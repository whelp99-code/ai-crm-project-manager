import { describe, expect, it } from "vitest";
import {
  ACTION_TYPES,
  ActionBindingSchema,
  ContractError,
  INTENT_STATES,
  IntentIdentitySchema,
  IntentSchema,
  PrincipalRoleSchema,
  PrincipalSchema,
  assertActionBinding,
  isValidIntentTransition,
} from "../src/index.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const RESOURCE_ID = "22222222-2222-4222-8222-222222222222";
const PRINCIPAL_ID = "33333333-3333-4333-8333-333333333333";
const INTENT_ID = "44444444-4444-4444-8444-444444444444";

describe("ActionBindingSchema", () => {
  it("accepts a complete workspace/resource/action binding", () => {
    const result = ActionBindingSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      resourceId: RESOURCE_ID,
      actionType: "CUSTOMER_SEND",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a binding missing the resourceId leg", () => {
    const result = ActionBindingSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      actionType: "CUSTOMER_SEND",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a binding missing the workspaceId leg", () => {
    const result = ActionBindingSchema.safeParse({
      resourceId: RESOURCE_ID,
      actionType: "CUSTOMER_SEND",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown actionType", () => {
    const result = ActionBindingSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      resourceId: RESOURCE_ID,
      actionType: "NOT_A_REAL_ACTION",
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra unrecognized fields (strict binding)", () => {
    const result = ActionBindingSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      resourceId: RESOURCE_ID,
      actionType: "CUSTOMER_SEND",
      extra: "nope",
    });
    expect(result.success).toBe(false);
  });

  it("assertActionBinding throws a ContractError with a stable code on failure", () => {
    expect(() => assertActionBinding({ workspaceId: WORKSPACE_ID })).toThrow(
      ContractError,
    );
    try {
      assertActionBinding({ workspaceId: WORKSPACE_ID });
      throw new Error("expected assertActionBinding to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      expect((error as ContractError).code).toBe("INVALID_BINDING");
    }
  });
});

describe("action type registry", () => {
  const REQUIRED_ACTION_TYPES = [
    "INTERNAL_REVERSIBLE_UPDATE",
    "CUSTOMER_SEND",
    "SCOPE_CHANGE",
    "SCHEDULE_CHANGE",
    "CONTRACT_CHANGE",
    "INVOICE_ISSUE",
    "PAYMENT_EXECUTE",
    "DELETE_RECORD",
    "PERMISSION_CHANGE",
    "MODEL_INVOKE",
    "PM_PLAN_CREATE",
    "PM_PLAN_REVISE",
    "PM_TASK_ASSIGN",
    "PM_TARGET_SET",
    "CRM_IMPORT",
    "ACCOUNTING_IMPORT",
    "BANK_STATEMENT_IMPORT",
    "FINANCE_DRAFT",
    "FINANCE_VERIFY",
    "LEDGER_POST",
  ];

  it("contains every required action type", () => {
    for (const required of REQUIRED_ACTION_TYPES) {
      expect(ACTION_TYPES).toContain(required);
    }
  });

  it("has no duplicate entries", () => {
    expect(new Set(ACTION_TYPES).size).toBe(ACTION_TYPES.length);
  });
});

describe("intent lifecycle states", () => {
  const REQUIRED_STATES = [
    "QUEUED",
    "LEASED",
    "DISPATCHING",
    "SUCCEEDED",
    "FAILED",
    "UNKNOWN",
    "INVALIDATED",
    "CANCELLED",
  ];

  it("declares every required lifecycle state exactly once", () => {
    expect(INTENT_STATES.length).toBe(REQUIRED_STATES.length);
    expect(new Set(INTENT_STATES)).toEqual(new Set(REQUIRED_STATES));
  });

  it("allows QUEUED -> LEASED but rejects QUEUED -> SUCCEEDED directly", () => {
    expect(isValidIntentTransition("QUEUED", "LEASED")).toBe(true);
    expect(isValidIntentTransition("QUEUED", "SUCCEEDED")).toBe(false);
  });

  it("treats terminal states SUCCEEDED, INVALIDATED, and CANCELLED as having no outgoing transitions", () => {
    expect(isValidIntentTransition("SUCCEEDED", "QUEUED")).toBe(false);
    expect(isValidIntentTransition("INVALIDATED", "QUEUED")).toBe(false);
    expect(isValidIntentTransition("CANCELLED", "QUEUED")).toBe(false);
  });
});

describe("IntentIdentitySchema", () => {
  const validIdentity = {
    id: INTENT_ID,
    workspaceId: WORKSPACE_ID,
    resourceId: RESOURCE_ID,
    actionType: "SCOPE_CHANGE",
    principalId: PRINCIPAL_ID,
    createdAt: "2026-07-15T00:00:00.000Z",
  };

  it("accepts a well-formed immutable identity", () => {
    expect(IntentIdentitySchema.safeParse(validIdentity).success).toBe(true);
  });

  it("rejects an identity missing the actionType binding leg", () => {
    const { actionType, ...withoutActionType } = validIdentity;
    expect(IntentIdentitySchema.safeParse(withoutActionType).success).toBe(
      false,
    );
  });

  it("rejects identity fields being mutated onto an unrelated shape (state leaking in)", () => {
    const result = IntentIdentitySchema.safeParse({
      ...validIdentity,
      state: "SUCCEEDED",
    });
    expect(result.success).toBe(false);
  });

  it("IntentSchema extends identity with lifecycle fields required for a full intent", () => {
    const full = IntentSchema.safeParse({
      ...validIdentity,
      state: "QUEUED",
      attempt: 0,
      payload: {},
      leaseExpiresAt: null,
      updatedAt: "2026-07-15T00:00:00.000Z",
    });
    expect(full.success).toBe(true);
  });
});

describe("PrincipalSchema role validation", () => {
  it("accepts each declared principal role", () => {
    for (const role of PrincipalRoleSchema.options) {
      const result = PrincipalSchema.safeParse({
        id: PRINCIPAL_ID,
        workspaceId: WORKSPACE_ID,
        role,
        displayName: "Ada Lovelace",
        isActive: true,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unrecognized role", () => {
    const result = PrincipalSchema.safeParse({
      id: PRINCIPAL_ID,
      workspaceId: WORKSPACE_ID,
      role: "SUPERUSER",
      displayName: "Ada Lovelace",
      isActive: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a principal missing workspaceId", () => {
    const result = PrincipalSchema.safeParse({
      id: PRINCIPAL_ID,
      role: "MEMBER",
      displayName: "Ada Lovelace",
      isActive: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty displayName", () => {
    const result = PrincipalSchema.safeParse({
      id: PRINCIPAL_ID,
      workspaceId: WORKSPACE_ID,
      role: "MEMBER",
      displayName: "",
      isActive: true,
    });
    expect(result.success).toBe(false);
  });
});
