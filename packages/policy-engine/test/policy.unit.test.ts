import { describe, expect, it } from "vitest";
import { ACTION_TYPES, type ActionType } from "@ai-crm/contracts";
import {
  AUTO_SCHEMA,
  CANONICALIZATION_SCHEMA_VERSION,
  POLICY_MATRIX,
  POLICY_MATRIX_VERSION,
  POLICY_VERSION,
  PROTECTED_ACTION_TYPES,
  PolicyCanonicalizationError,
  REQUIRED_CONTROLS,
  canonicalHashOf,
  canonicalize,
  evaluatePolicy,
  stableStringify,
  type FieldSchema,
} from "../src/index.js";

const ALWAYS_REQUIRE_APPROVAL: readonly ActionType[] = [
  "CUSTOMER_SEND",
  "SCOPE_CHANGE",
  "SCHEDULE_CHANGE",
  "CONTRACT_CHANGE",
  "INVOICE_ISSUE",
  "PAYMENT_EXECUTE",
  "DELETE_RECORD",
  "PERMISSION_CHANGE",
  "LEDGER_POST",
];

describe("POLICY_MATRIX", () => {
  it("exposes immutable conservative, eligible, and risk-tiered matrices with finance verification controls", async () => {
    const policy = await import("../src/index.js");
    expect(policy.POLICY_MATRICES.conservative.FINANCE_VERIFY.control).toBe("REQUIRE_APPROVAL");
    expect(policy.POLICY_MATRICES.eligible.FINANCE_VERIFY.control).toBe("CHECKPOINT");
    expect(policy.POLICY_MATRICES.risk_tiered.FINANCE_VERIFY.control).toBe("ALLOW");
    expect(Object.isFrozen(policy.POLICY_MATRICES)).toBe(true);
    expect(policy.VERSIONED_POLICY_MATRICES[POLICY_MATRIX_VERSION]).toBe(policy.POLICY_MATRICES);
    for (const matrix of Object.values(policy.POLICY_MATRICES)) {
      for (const actionType of policy.PROTECTED_ACTION_TYPES) {
        expect(matrix[actionType].control).toBe("REQUIRE_APPROVAL");
      }
    }
  });
  it("has exactly one explicit row per registered ACTION_TYPES entry, no more, no less", () => {
    expect(Object.keys(POLICY_MATRIX).sort()).toEqual([...ACTION_TYPES].sort());
  });

  it("MODEL_INVOKE is a non-effect ALLOW", () => {
    expect(POLICY_MATRIX.MODEL_INVOKE.control).toBe("ALLOW");
  });

  it("every protected action type is mapped to REQUIRE_APPROVAL", () => {
    for (const type of ALWAYS_REQUIRE_APPROVAL) {
      expect(POLICY_MATRIX[type].control).toBe("REQUIRE_APPROVAL");
    }
  });

  it("PROTECTED_ACTION_TYPES matches exactly the REQUIRE_APPROVAL rows", () => {
    expect([...PROTECTED_ACTION_TYPES].sort()).toEqual([...ALWAYS_REQUIRE_APPROVAL].sort());
  });

  it("every policy row has a non-empty reason", () => {
    for (const type of ACTION_TYPES) {
      expect(POLICY_MATRIX[type].reason.length).toBeGreaterThan(0);
    }
  });

  it("every policy row resolves to a control other than BLOCK (BLOCK is reserved for unmapped input)", () => {
    for (const type of ACTION_TYPES) {
      expect(REQUIRED_CONTROLS).toContain(POLICY_MATRIX[type].control);
      expect(POLICY_MATRIX[type].control).not.toBe("BLOCK");
    }
  });
});

describe("evaluatePolicy: known action types", () => {
  it("returns the matrix-mapped control and reason for every registered action type", () => {
    for (const type of ACTION_TYPES) {
      const result = evaluatePolicy({ actionType: type, payload: { note: "x" } });
      expect(result.policyVersion).toBe(POLICY_VERSION);
      expect(result.matrixVersion).toBe(POLICY_MATRIX_VERSION);
      expect(result.actionType).toBe(type);
      expect(result.requiredControl).toBe(POLICY_MATRIX[type].control);
      expect(result.reason).toBe(POLICY_MATRIX[type].reason);
      expect(result.canonicalHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("protected actions never downgrade regardless of payload shape", () => {
    const payloads: unknown[] = [
      {},
      { amount: "0" },
      { urgent: true, override: true, force: true },
      { classification: "ALLOW", requiredControl: "ALLOW" },
      null,
      "raw-string-payload",
      42,
    ];
    for (const type of ALWAYS_REQUIRE_APPROVAL) {
      for (const payload of payloads) {
        const result = evaluatePolicy({ actionType: type, payload });
        expect(result.requiredControl).toBe("REQUIRE_APPROVAL");
      }
    }
  });

  it("required control depends only on actionType, never on caller-supplied payload content", () => {
    const a = evaluatePolicy({ actionType: "PM_TASK_ASSIGN", payload: { assignee: "alice" } });
    const b = evaluatePolicy({ actionType: "PM_TASK_ASSIGN", payload: { assignee: "bob", priority: "urgent" } });
    expect(a.requiredControl).toBe(b.requiredControl);
    expect(a.requiredControl).toBe("CHECKPOINT");
    // Different payload content still yields different hashes (payload is hashed, not decision-relevant).
    expect(a.canonicalHash).not.toBe(b.canonicalHash);
  });

  it("ignores any extraneous caller-provided classification-like fields on the input", () => {
    const tampered = {
      actionType: "CUSTOMER_SEND",
      payload: {},
      // Not part of PolicyInput; simulates a caller trying to smuggle a classification override.
      requiredControl: "ALLOW",
      classification: "low-risk",
    } as unknown as { actionType: string; payload: unknown };
    const result = evaluatePolicy(tampered);
    expect(result.requiredControl).toBe("REQUIRE_APPROVAL");
  });
});

describe("evaluatePolicy: unknown action types fail closed", () => {
  it("blocks a completely unrecognized action type", () => {
    const result = evaluatePolicy({ actionType: "SELF_DESTRUCT", payload: {} });
    expect(result.requiredControl).toBe("BLOCK");
    expect(result.reason).toContain("SELF_DESTRUCT");
    expect(result.policyVersion).toBe(POLICY_VERSION);
  });

  it("blocks an empty action type", () => {
    const result = evaluatePolicy({ actionType: "", payload: {} });
    expect(result.requiredControl).toBe("BLOCK");
  });

  it("blocks a lowercase variant of a known action type (case-sensitive registry)", () => {
    const result = evaluatePolicy({ actionType: "customer_send", payload: {} });
    expect(result.requiredControl).toBe("BLOCK");
  });

  it("returns a stable BLOCK even when an unknown action carries a non-canonical payload", () => {
    const result = evaluatePolicy({ actionType: "SELF_DESTRUCT", payload: new Date() });
    expect(result.requiredControl).toBe("BLOCK");
    expect(result.canonicalHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("canonicalize: key order and structure", () => {
  it("produces identical hashes for objects with the same fields in different key order", () => {
    const h1 = canonicalHashOf("INTERNAL_REVERSIBLE_UPDATE", { a: 1, b: 2, c: 3 });
    const h2 = canonicalHashOf("INTERNAL_REVERSIBLE_UPDATE", { c: 3, a: 1, b: 2 });
    expect(h1).toBe(h2);
  });

  it("produces different hashes when a nested field value materially differs", () => {
    const h1 = canonicalHashOf("INTERNAL_REVERSIBLE_UPDATE", { a: { x: 1, y: 2 } });
    const h2 = canonicalHashOf("INTERNAL_REVERSIBLE_UPDATE", { a: { x: 1, y: 3 } });
    expect(h1).not.toBe(h2);
  });

  it("binds the hash to the action type: identical payload, different action type, different hash", () => {
    const h1 = canonicalHashOf("PM_PLAN_CREATE", { a: 1 });
    const h2 = canonicalHashOf("PM_PLAN_REVISE", { a: 1 });
    expect(h1).not.toBe(h2);
  });

  it("stableStringify sorts keys at every nesting level", () => {
    const s1 = stableStringify(canonicalize({ b: { z: 1, a: 2 }, a: 1 }, AUTO_SCHEMA));
    const s2 = stableStringify(canonicalize({ a: 1, b: { a: 2, z: 1 } }, AUTO_SCHEMA));
    expect(s1).toBe(s2);
    expect(s1).toBe('{"a":"1","b":{"a":"2","z":"1"}}');
  });
});

describe("canonicalize: null vs default distinction", () => {
  const schema: FieldSchema = {
    kind: "object",
    fields: {
      note: { schema: { kind: "string" }, optional: true, default: "unset" },
      flag: { schema: { kind: "nullable", of: { kind: "boolean" } } },
    },
  };

  it("an explicit null is kept as null and differs from an omitted key with a default", () => {
    const withNull = canonicalize({ note: null as unknown as string, flag: null }, {
      kind: "object",
      fields: {
        note: { schema: { kind: "nullable", of: { kind: "string" } }, optional: true, default: "unset" },
        flag: { schema: { kind: "nullable", of: { kind: "boolean" } } },
      },
    });
    const omitted = canonicalize({ flag: null }, schema);
    expect(withNull).not.toEqual(omitted);
    expect((withNull as Record<string, unknown>).note).toBeNull();
    expect((omitted as Record<string, unknown>).note).toBe("unset");
  });

  it("omitting a required field throws MISSING_FIELD", () => {
    expect(() => canonicalize({}, schema)).toThrow(PolicyCanonicalizationError);
    try {
      canonicalize({}, schema);
      throw new Error("expected canonicalize to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyCanonicalizationError);
      expect((error as PolicyCanonicalizationError).code).toBe("MISSING_FIELD");
    }
  });

  it("an unexpected field throws UNEXPECTED_FIELD", () => {
    try {
      canonicalize({ flag: true, extra: 1 }, schema);
      throw new Error("expected canonicalize to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyCanonicalizationError);
      expect((error as PolicyCanonicalizationError).code).toBe("UNEXPECTED_FIELD");
    }
  });
});

describe("canonicalize: Unicode normalization", () => {
  it("normalizes NFD-decomposed and NFC-composed forms of the same text to the same hash", () => {
    const composed = "\u00e9"; // "é" precomposed
    const decomposed = "e\u0301"; // "e" + combining acute accent
    expect(composed).not.toBe(decomposed);
    const h1 = canonicalHashOf("CUSTOMER_SEND", { message: composed });
    const h2 = canonicalHashOf("CUSTOMER_SEND", { message: decomposed });
    expect(h1).toBe(h2);
  });

  it("distinguishes genuinely different text", () => {
    const h1 = canonicalHashOf("CUSTOMER_SEND", { message: "hello" });
    const h2 = canonicalHashOf("CUSTOMER_SEND", { message: "goodbye" });
    expect(h1).not.toBe(h2);
  });
});

describe("canonicalize: decimal strings", () => {
  const schema: FieldSchema = { kind: "object", fields: { amount: { schema: { kind: "decimal" } } } };

  it("treats equivalent decimal representations as canonically identical", () => {
    const variants = ["1.50", "1.5", 1.5, "1.500000", "+1.5", "0.15e1", "15e-1"];
    const canonicalForms = variants.map(
      (amount) => (canonicalize({ amount }, schema) as Record<string, unknown>).amount,
    );
    for (const form of canonicalForms) {
      expect(form).toBe("1.5");
    }
  });

  it("normalizes negative and positive zero to a single canonical zero", () => {
    const zeros = ["-0", "0", "-0.0", "0.00", 0, -0];
    for (const amount of zeros) {
      const result = canonicalize({ amount }, schema) as Record<string, unknown>;
      expect(result.amount).toBe("0");
    }
  });

  it("distinguishes materially different amounts", () => {
    const a = canonicalize({ amount: "1.50" }, schema) as Record<string, unknown>;
    const b = canonicalize({ amount: "1.51" }, schema) as Record<string, unknown>;
    expect(a.amount).not.toBe(b.amount);
  });

  it("large integers and scientific notation expand to full canonical decimal form", () => {
    const result = canonicalize({ amount: "1.23e3" }, schema) as Record<string, unknown>;
    expect(result.amount).toBe("1230");
  });

  it("rejects a non-numeric decimal literal", () => {
    expect(() => canonicalize({ amount: "not-a-number" }, schema)).toThrow(PolicyCanonicalizationError);
  });

  it("rejects exponents that would cause unbounded expansion", () => {
    expect(() => canonicalize({ amount: "1e10001" }, schema)).toThrow(PolicyCanonicalizationError);
  });
});

describe("canonicalize: timestamp normalization", () => {
  const schema: FieldSchema = { kind: "object", fields: { at: { schema: { kind: "timestamp" } } } };

  it("normalizes equivalent instants expressed with different UTC offsets to the same canonical form", () => {
    const utc = canonicalize({ at: "2026-07-15T12:00:00.000Z" }, schema) as Record<string, unknown>;
    const offset = canonicalize({ at: "2026-07-15T14:00:00.000+02:00" }, schema) as Record<string, unknown>;
    expect(utc.at).toBe(offset.at);
    expect(utc.at).toBe("2026-07-15T12:00:00.000Z");
  });

  it("distinguishes genuinely different instants", () => {
    const a = canonicalize({ at: "2026-07-15T12:00:00.000Z" }, schema) as Record<string, unknown>;
    const b = canonicalize({ at: "2026-07-15T12:00:01.000Z" }, schema) as Record<string, unknown>;
    expect(a.at).not.toBe(b.at);
  });

  it("rejects an unparseable timestamp", () => {
    expect(() => canonicalize({ at: "not-a-date" }, schema)).toThrow(PolicyCanonicalizationError);
  });

  it("rejects timestamps without an explicit offset", () => {
    expect(() => canonicalize({ at: "2026-07-15T12:00:00" }, schema)).toThrow(PolicyCanonicalizationError);
  });
});

describe("canonicalize: set-like arrays", () => {
  const schema: FieldSchema = {
    kind: "object",
    fields: { tags: { schema: { kind: "set", of: { kind: "string" } } } },
  };
  const listSchema: FieldSchema = {
    kind: "object",
    fields: { tags: { schema: { kind: "list", of: { kind: "string" } } } },
  };

  it("set-kind arrays are order-independent", () => {
    const a = canonicalize({ tags: ["beta", "alpha", "gamma"] }, schema);
    const b = canonicalize({ tags: ["gamma", "alpha", "beta"] }, schema);
    expect(a).toEqual(b);
  });

  it("list-kind arrays with the same elements in different order are NOT equivalent", () => {
    const a = canonicalize({ tags: ["beta", "alpha"] }, listSchema);
    const b = canonicalize({ tags: ["alpha", "beta"] }, listSchema);
    expect(a).not.toEqual(b);
  });

  it("set with a materially different member set differs", () => {
    const a = canonicalize({ tags: ["alpha", "beta"] }, schema);
    const b = canonicalize({ tags: ["alpha", "gamma"] }, schema);
    expect(a).not.toEqual(b);
  });
});

describe("canonicalize: auto schema fallback", () => {
  it("sorts keys and normalizes numbers/strings without an explicit schema", () => {
    const h1 = canonicalHashOf("MODEL_INVOKE", { count: 3, name: "x" }, AUTO_SCHEMA);
    const h2 = canonicalHashOf("MODEL_INVOKE", { name: "x", count: 3.0 }, AUTO_SCHEMA);
    expect(h1).toBe(h2);
  });

  it("omits explicit undefined values but keeps explicit null", () => {
    const withUndefined = canonicalize({ a: 1, b: undefined }, AUTO_SCHEMA);
    const withoutKey = canonicalize({ a: 1 }, AUTO_SCHEMA);
    expect(withUndefined).toEqual(withoutKey);

    const withNull = canonicalize({ a: 1, b: null }, AUTO_SCHEMA);
    expect(withNull).not.toEqual(withoutKey);
  });

  it.each([new Date("2026-07-15T00:00:00Z"), new Map([["a", 1]]), new Set(["a"])])(
    "rejects non-plain object payloads instead of collapsing them",
    (value) => {
      expect(() => canonicalize(value, AUTO_SCHEMA)).toThrow(PolicyCanonicalizationError);
    },
  );

  it("pins the canonicalization schema version used in approval hashes", () => {
    expect(CANONICALIZATION_SCHEMA_VERSION).toBe(2);
  });
});

describe("determinism", () => {
  it("evaluating the same input twice yields identical results", () => {
    const input = { actionType: "FINANCE_VERIFY", payload: { total: "100.00", currency: "USD" } };
    const r1 = evaluatePolicy(input);
    const r2 = evaluatePolicy(input);
    expect(r1).toEqual(r2);
  });

  it("canonical hash is stable across repeated calls for equivalent-but-differently-formatted payloads", () => {
    const h1 = canonicalHashOf("FINANCE_DRAFT", { amount: 10, note: "café", tags: ["a", "b"] });
    const h2 = canonicalHashOf("FINANCE_DRAFT", { tags: ["a", "b"], note: "cafe\u0301", amount: 10.0 });
    expect(h1).toBe(h2);
  });

  it("explicit decimal schema treats a string amount and an equal-value number amount as equivalent", () => {
    const schema: FieldSchema = { kind: "object", fields: { amount: { schema: { kind: "decimal" } } } };
    const h1 = canonicalHashOf("FINANCE_DRAFT", { amount: "10.00" }, schema);
    const h2 = canonicalHashOf("FINANCE_DRAFT", { amount: 10 }, schema);
    expect(h1).toBe(h2);
  });
});
