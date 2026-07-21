import { ACTION_TYPES, ActionTypeSchema, type ActionType } from "@ai-crm/contracts";
import { createHash } from "node:crypto";

/**
 * @ai-crm/policy-engine
 *
 * Pure, deterministic mapping from a server-derived action type to a
 * required control, plus a schema-versioned deterministic canonicalization
 * and hashing API for action payloads.
 *
 * Hard constraints (do not violate):
 *  - No I/O, no network, no persistence.
 *  - No global mutable state; every export is a pure function or a frozen
 *    constant.
 *  - No reliance on the current date/time or on randomness. Timestamp
 *    canonicalization only *parses and reformats* a caller-supplied string;
 *    it never reads the system clock.
 *  - The required control for an action is derived *exclusively* from the
 *    action's `type` (validated against the shared contract enum). Payload
 *    content, caller-supplied classification hints, or any other input
 *    never change the required control.
 */

// ---------------------------------------------------------------------------
// Policy version and required controls
// ---------------------------------------------------------------------------

/** Bumped whenever POLICY_MATRIX semantics change. */
export const POLICY_VERSION = 1 as const;

export const REQUIRED_CONTROLS = ["ALLOW", "CHECKPOINT", "REQUIRE_APPROVAL", "BLOCK"] as const;
export type RequiredControl = (typeof REQUIRED_CONTROLS)[number];

/** Required controls a mapped (known) action type may resolve to; BLOCK is reserved for unmapped input. */
type MappedControl = Exclude<RequiredControl, "BLOCK">;

interface PolicyMatrixEntry {
  readonly control: MappedControl;
  readonly reason: string;
}

/**
 * Explicit, exhaustive policy row per registered `ActionType`. TypeScript
 * enforces exhaustiveness: adding an action type to `@ai-crm/contracts`
 * without adding a row here is a compile error.
 *
 * Rows are grouped by risk tier:
 *  - MODEL_INVOKE: model calls have no external side effect by themselves;
 *    always ALLOW.
 *  - Internal/PM planning actions default to ALLOW when reversible and
 *    low-blast-radius, and CHECKPOINT when they commit a team to a plan,
 *    assignment, target, or verified financial figure. Never BLOCK or
 *    downgrade to less oversight than this fixed table states.
 *  - Customer-facing, scope/schedule/contract, money-moving, destructive,
 *    permission, and ledger-posting actions are protected: always
 *    REQUIRE_APPROVAL, regardless of payload content.
 */
export const POLICY_MATRIX: Readonly<Record<ActionType, PolicyMatrixEntry>> = Object.freeze({
  INTERNAL_REVERSIBLE_UPDATE: {
    control: "ALLOW",
    reason: "Internal update is reversible and workspace-scoped; no external effect.",
  },
  CUSTOMER_SEND: {
    control: "REQUIRE_APPROVAL",
    reason: "Action is externally visible to a customer; always requires human approval.",
  },
  SCOPE_CHANGE: {
    control: "REQUIRE_APPROVAL",
    reason: "Scope changes affect committed deliverables; always requires human approval.",
  },
  SCHEDULE_CHANGE: {
    control: "REQUIRE_APPROVAL",
    reason: "Schedule changes affect committed deliverables; always requires human approval.",
  },
  CONTRACT_CHANGE: {
    control: "REQUIRE_APPROVAL",
    reason: "Contract terms are legally binding; always requires human approval.",
  },
  INVOICE_ISSUE: {
    control: "REQUIRE_APPROVAL",
    reason: "Issuing an invoice creates a customer-facing financial obligation.",
  },
  PAYMENT_EXECUTE: {
    control: "REQUIRE_APPROVAL",
    reason: "Executing payment moves money; always requires human approval.",
  },
  DELETE_RECORD: {
    control: "REQUIRE_APPROVAL",
    reason: "Deletion is destructive and may be irreversible; always requires human approval.",
  },
  PERMISSION_CHANGE: {
    control: "REQUIRE_APPROVAL",
    reason: "Permission changes affect the security boundary; always requires human approval.",
  },
  MODEL_INVOKE: {
    control: "ALLOW",
    reason: "Model invocation alone has no external side effect.",
  },
  PM_PLAN_CREATE: {
    control: "ALLOW",
    reason: "Creating a draft plan is reversible and has no external commitment yet.",
  },
  PM_PLAN_REVISE: {
    control: "CHECKPOINT",
    reason: "Revising an existing plan changes prior commitments; requires a checkpoint.",
  },
  PM_TASK_ASSIGN: {
    control: "CHECKPOINT",
    reason: "Assigning a task commits a team member's time; requires a checkpoint.",
  },
  PM_TARGET_SET: {
    control: "CHECKPOINT",
    reason: "Setting a target establishes a tracked commitment; requires a checkpoint.",
  },
  CRM_IMPORT: {
    control: "CHECKPOINT",
    reason: "CRM imports can create many internal records and require an operator checkpoint.",
  },
  ACCOUNTING_IMPORT: {
    control: "CHECKPOINT",
    reason: "Accounting imports affect draft financial records and require an operator checkpoint.",
  },
  BANK_STATEMENT_IMPORT: {
    control: "CHECKPOINT",
    reason: "Bank statement imports affect reconciliation inputs and require an operator checkpoint.",
  },
  FINANCE_DRAFT: {
    control: "ALLOW",
    reason: "Drafting a financial figure is reversible and not yet asserted as verified.",
  },
  FINANCE_VERIFY: {
    control: "CHECKPOINT",
    reason: "Verifying a financial figure asserts correctness downstream; requires a checkpoint.",
  },
  LEDGER_POST: {
    control: "REQUIRE_APPROVAL",
    reason: "Posting to the ledger is a durable financial record; always requires human approval.",
  },
} satisfies Record<ActionType, PolicyMatrixEntry>);

/** Action types whose required control must never be downgraded below REQUIRE_APPROVAL. */
export const PROTECTED_ACTION_TYPES: ReadonlySet<ActionType> = new Set(
  ACTION_TYPES.filter((type) => POLICY_MATRIX[type].control === "REQUIRE_APPROVAL"),
);

// ---------------------------------------------------------------------------
// Canonicalization: explicit, schema-versioned deterministic payload shaping
// ---------------------------------------------------------------------------

/** Bumped whenever canonical encoding rules change (decimal/timestamp/set rules, etc). */
export const CANONICALIZATION_SCHEMA_VERSION = 2 as const;

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export interface ObjectFieldSpec {
  readonly schema: FieldSchema;
  /** When true, a missing key is permitted. */
  readonly optional?: boolean;
  /** Canonical value substituted when the key is missing and `optional` is true. Omitted entirely if absent. */
  readonly default?: CanonicalValue;
}

/**
 * Explicit per-field canonicalization rules. `"auto"` is the schema-free
 * fallback: it still sorts keys, normalizes strings, and renders numbers as
 * canonical decimal strings, but treats arrays as ordered lists (it cannot
 * infer set semantics) and leaves timestamp-shaped strings untouched (it
 * cannot infer which strings are timestamps). Use the explicit variants for
 * those guarantees.
 */
export type FieldSchema =
  | { readonly kind: "auto" }
  | { readonly kind: "string" }
  | { readonly kind: "decimal" }
  | { readonly kind: "timestamp" }
  | { readonly kind: "boolean" }
  | { readonly kind: "nullable"; readonly of: FieldSchema }
  | { readonly kind: "list"; readonly of: FieldSchema }
  | { readonly kind: "set"; readonly of: FieldSchema }
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, ObjectFieldSpec>> };

export const AUTO_SCHEMA: FieldSchema = { kind: "auto" };

export type PolicyCanonicalizationErrorCode =
  | "TYPE_MISMATCH"
  | "INVALID_DECIMAL"
  | "INVALID_TIMESTAMP"
  | "MISSING_FIELD"
  | "UNEXPECTED_FIELD"
  | "UNSUPPORTED_VALUE";

export class PolicyCanonicalizationError extends Error {
  readonly code: PolicyCanonicalizationErrorCode;
  readonly path: string;

  constructor(code: PolicyCanonicalizationErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "PolicyCanonicalizationError";
    this.code = code;
    this.path = path;
  }
}

function normalizeString(raw: unknown, path: string): string {
  if (typeof raw !== "string") {
    throw new PolicyCanonicalizationError("TYPE_MISMATCH", path, "expected a string");
  }
  return raw.normalize("NFC");
}

const DECIMAL_LITERAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const MAX_DECIMAL_EXPONENT = 10_000;

/**
 * Renders a number or numeric string as a canonical, exponent-free decimal
 * string: no leading zeros (except a lone "0"), no trailing fractional
 * zeros, no trailing ".", and "-0"/"-0.0" normalize to "0".
 */
function toCanonicalDecimalString(raw: unknown, path: string): string {
  let text: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throw new PolicyCanonicalizationError("INVALID_DECIMAL", path, "decimal must be finite");
    }
    text = raw.toString();
  } else if (typeof raw === "string") {
    text = raw.trim();
  } else {
    throw new PolicyCanonicalizationError(
      "TYPE_MISMATCH",
      path,
      "expected a number or a decimal string",
    );
  }

  if (!DECIMAL_LITERAL.test(text)) {
    throw new PolicyCanonicalizationError(
      "INVALID_DECIMAL",
      path,
      `invalid decimal literal "${text}"`,
    );
  }

  const negative = text.startsWith("-");
  if (text.startsWith("+") || text.startsWith("-")) {
    text = text.slice(1);
  }

  let mantissa = text;
  let exponent = 0;
  const eIndex = mantissa.search(/[eE]/);
  if (eIndex !== -1) {
    exponent = parseInt(mantissa.slice(eIndex + 1), 10);
    mantissa = mantissa.slice(0, eIndex);
  }
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_DECIMAL_EXPONENT) {
    throw new PolicyCanonicalizationError(
      "INVALID_DECIMAL",
      path,
      `decimal exponent must be between -${MAX_DECIMAL_EXPONENT} and ${MAX_DECIMAL_EXPONENT}`,
    );
  }

  const dotIndex = mantissa.indexOf(".");
  let intPart = dotIndex === -1 ? mantissa : mantissa.slice(0, dotIndex);
  let fracPart = dotIndex === -1 ? "" : mantissa.slice(dotIndex + 1);

  while (exponent > 0) {
    intPart += fracPart.length > 0 ? fracPart[0] : "0";
    fracPart = fracPart.length > 0 ? fracPart.slice(1) : "";
    exponent--;
  }
  while (exponent < 0) {
    fracPart = (intPart.length > 0 ? intPart[intPart.length - 1] : "0") + fracPart;
    intPart = intPart.length > 0 ? intPart.slice(0, -1) : "";
    exponent++;
  }

  intPart = intPart.replace(/^0+(?=\d)/, "");
  if (intPart === "") {
    intPart = "0";
  }
  fracPart = fracPart.replace(/0+$/, "");

  const isZero = intPart === "0" && fracPart === "";
  const sign = negative && !isZero ? "-" : "";
  return fracPart.length > 0 ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
}

/** Renders a strict ISO-8601 timestamp with an explicit offset as canonical UTC. */
function toCanonicalTimestamp(raw: unknown, path: string): string {
  if (typeof raw !== "string") {
    throw new PolicyCanonicalizationError("TYPE_MISMATCH", path, "expected a timestamp string");
  }
  const trimmed = raw.trim();
  const explicitOffsetIso =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!explicitOffsetIso.test(trimmed)) {
    throw new PolicyCanonicalizationError(
      "INVALID_TIMESTAMP",
      path,
      "timestamp must be ISO-8601 with an explicit Z or numeric offset",
    );
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new PolicyCanonicalizationError(
      "INVALID_TIMESTAMP",
      path,
      `invalid timestamp "${raw}"`,
    );
  }
  return new Date(ms).toISOString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Deterministic (non-lexicographic-string-quirky) ordering over already-canonical values, for `"set"` sorting. */
function compareCanonical(a: CanonicalValue, b: CanonicalValue): number {
  const sa = stableStringify(a);
  const sb = stableStringify(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function canonicalizeAuto(raw: unknown, path: string): CanonicalValue {
  if (raw === null) {
    return null;
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "number") {
    return toCanonicalDecimalString(raw, path);
  }
  if (typeof raw === "string") {
    return normalizeString(raw, path);
  }
  if (Array.isArray(raw)) {
    return raw.map((item, index) => canonicalizeAuto(item, `${path}[${index}]`));
  }
  if (isPlainObject(raw)) {
    const result: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(raw).sort()) {
      const value = raw[key];
      if (value === undefined) {
        continue;
      }
      result[key] = canonicalizeAuto(value, `${path}.${key}`);
    }
    return result;
  }
  throw new PolicyCanonicalizationError(
    "UNSUPPORTED_VALUE",
    path,
    `unsupported value of type "${typeof raw}"`,
  );
}

/**
 * Canonicalizes `raw` against an explicit `FieldSchema`, producing a
 * deterministic value suitable for stable stringification and hashing.
 * Distinguishes an explicit `null` (kept) from an absent key (omitted, or
 * replaced with the field's declared `default`), normalizes Unicode text to
 * NFC, renders numeric values as canonical decimal strings, renders
 * timestamp strings as canonical UTC ISO-8601, and sorts `"set"` arrays into
 * a deterministic order so element order never affects the result.
 */
export function canonicalize(raw: unknown, schema: FieldSchema, path = "$"): CanonicalValue {
  switch (schema.kind) {
    case "auto":
      return canonicalizeAuto(raw, path);
    case "string":
      return normalizeString(raw, path);
    case "decimal":
      return toCanonicalDecimalString(raw, path);
    case "timestamp":
      return toCanonicalTimestamp(raw, path);
    case "boolean":
      if (typeof raw !== "boolean") {
        throw new PolicyCanonicalizationError("TYPE_MISMATCH", path, "expected a boolean");
      }
      return raw;
    case "nullable":
      return raw === null ? null : canonicalize(raw, schema.of, path);
    case "list": {
      if (!Array.isArray(raw)) {
        throw new PolicyCanonicalizationError("TYPE_MISMATCH", path, "expected an array");
      }
      return raw.map((item, index) => canonicalize(item, schema.of, `${path}[${index}]`));
    }
    case "set": {
      if (!Array.isArray(raw)) {
        throw new PolicyCanonicalizationError("TYPE_MISMATCH", path, "expected an array");
      }
      const items = raw.map((item, index) => canonicalize(item, schema.of, `${path}[${index}]`));
      return [...items].sort(compareCanonical);
    }
    case "object": {
      if (!isPlainObject(raw)) {
        throw new PolicyCanonicalizationError("TYPE_MISMATCH", path, "expected an object");
      }
      const fieldNames = Object.keys(schema.fields).sort();
      const extra = Object.keys(raw).filter((key) => !(key in schema.fields));
      if (extra.length > 0) {
        throw new PolicyCanonicalizationError(
          "UNEXPECTED_FIELD",
          path,
          `unexpected field(s): ${extra.sort().join(", ")}`,
        );
      }
      const result: Record<string, CanonicalValue> = {};
      for (const key of fieldNames) {
        const spec = schema.fields[key];
        if (spec === undefined) {
          continue;
        }
        const fieldPath = `${path}.${key}`;
        const value = raw[key];
        if (value === undefined) {
          if (!spec.optional) {
            throw new PolicyCanonicalizationError(
              "MISSING_FIELD",
              fieldPath,
              "required field is missing",
            );
          }
          if (spec.default !== undefined) {
            result[key] = spec.default;
          }
          continue;
        }
        result[key] = canonicalize(value, spec.schema, fieldPath);
      }
      return result;
    }
    default: {
      const exhaustive: never = schema;
      throw new PolicyCanonicalizationError(
        "UNSUPPORTED_VALUE",
        path,
        `unsupported schema kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/** Deterministic JSON stringification: object keys are sorted at every level regardless of insertion order. */
export function stableStringify(value: CanonicalValue): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const objectValue = value as Readonly<Record<string, CanonicalValue>>;
  const keys = Object.keys(objectValue).sort();
  const body = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key] as CanonicalValue)}`);
  return `{${body.join(",")}}`;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** Collision-resistant deterministic hash for approval and intent payload binding. */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Computes the canonical hash of an action's payload, bound to its action type and the canonicalization schema version. */
export function canonicalHashOf(actionType: string, payload: unknown, schema: FieldSchema = AUTO_SCHEMA): string {
  const canonical = canonicalize(payload, schema);
  const envelope: CanonicalValue = {
    schemaVersion: CANONICALIZATION_SCHEMA_VERSION,
    actionType,
    payload: canonical,
  };
  return sha256Hex(stableStringify(envelope));
}

// ---------------------------------------------------------------------------
// Policy evaluation
// ---------------------------------------------------------------------------

export interface PolicyInput {
  /** Server-derived action type; never trust a caller-supplied classification override. */
  readonly actionType: string;
  readonly payload: unknown;
}

export interface PolicyResult {
  readonly policyVersion: number;
  readonly actionType: string;
  readonly requiredControl: RequiredControl;
  readonly reason: string;
  readonly canonicalHash: string;
}

/**
 * Evaluates policy for a single action. The required control is determined
 * solely by `input.actionType` against `POLICY_MATRIX`; `input.payload` only
 * affects the returned `canonicalHash`, never the required control. Unknown
 * or unmapped action types fail closed to `"BLOCK"`.
 */
export function evaluatePolicy(input: PolicyInput, payloadSchema: FieldSchema = AUTO_SCHEMA): PolicyResult {
  const parsed = ActionTypeSchema.safeParse(input.actionType);

  if (!parsed.success) {
    return {
      policyVersion: POLICY_VERSION,
      actionType: input.actionType,
      requiredControl: "BLOCK",
      reason: `unknown or unmapped action type "${input.actionType}"`,
      canonicalHash: canonicalHashOf(input.actionType, null),
    };
  }

  const canonicalHash = canonicalHashOf(input.actionType, input.payload, payloadSchema);
  const entry = POLICY_MATRIX[parsed.data];
  return {
    policyVersion: POLICY_VERSION,
    actionType: parsed.data,
    requiredControl: entry.control,
    reason: entry.reason,
    canonicalHash,
  };
}
