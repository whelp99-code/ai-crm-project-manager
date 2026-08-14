import { describe, expect, it } from "vitest";
import {
  CustomerWorkOsError,
  CustomerWorkOsService,
  type CustomerWorkOsState,
} from "../src/customer-work-os-stateful.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";

function serviceWithAccount(): CustomerWorkOsService {
  const service = new CustomerWorkOsService();
  service.createAccount({
    id: "account-1",
    workspaceId: WORKSPACE,
    name: "고객 A",
    kinds: ["customer"],
    status: "active",
  });
  return service;
}

describe("Customer Work OS state snapshots", () => {
  it("round-trips a deterministic state through a fresh service", () => {
    const original = serviceWithAccount();
    const snapshot = original.exportState();
    const restored = new CustomerWorkOsService();
    restored.hydrateState(snapshot);

    expect(restored.exportState()).toEqual(snapshot);
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.accounts[0]?.normalizedName).toBe("고객 a");
  });

  it("does not expose mutable internal collections through exportState", () => {
    const service = serviceWithAccount();
    const snapshot = service.exportState();
    snapshot.accounts[0]!.name = "변조";
    snapshot.accounts.push({
      id: "injected",
      workspaceId: WORKSPACE,
      name: "주입",
      normalizedName: "주입",
      kinds: ["customer"],
      status: "active",
      version: 1,
    });

    const current = service.exportState();
    expect(current.accounts).toHaveLength(1);
    expect(current.accounts[0]?.name).toBe("고객 A");
  });

  it("validates the complete candidate before replacing live state", () => {
    const service = serviceWithAccount();
    const before = service.exportState();
    const malformed = structuredClone(before) as CustomerWorkOsState;
    malformed.accounts.push(structuredClone(malformed.accounts[0]!));

    expect(() => service.hydrateState(malformed)).toThrowError(CustomerWorkOsError);
    expect(service.exportState()).toEqual(before);
  });

  it("rejects unsupported schemas without clearing the current workspace", () => {
    const service = serviceWithAccount();
    const before = service.exportState();
    const unsupported = { ...structuredClone(before), schemaVersion: 2 } as unknown as CustomerWorkOsState;

    expect(() => service.hydrateState(unsupported)).toMatchObject({ code: "UNSUPPORTED_STATE" });
    expect(service.exportState()).toEqual(before);
  });
});
