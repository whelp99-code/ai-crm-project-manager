import { describe, expect, it } from "vitest";
import { CustomerWorkOsError } from "@ai-crm/domain/customer-work-os";
import {
  CustomerWorkOsRuntimeManager,
  InMemoryCustomerWorkOsSnapshotStore,
  type CustomerWorkOsMutationAudit,
  type CustomerWorkOsRuntimeEnvelope,
  type CustomerWorkOsSnapshotStore,
} from "../src/customer-work-os-runtime.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";

function mutation(id: string, name: string) {
  return {
    workspaceId: WORKSPACE,
    principalId: "owner",
    idempotencyKey: id,
    requestHash: `hash:${id}:${name}`,
    operationId: "account.create",
    now: `2026-08-14T00:00:${id.endsWith("2") ? "02" : "01"}.000Z`,
    operation: (service: Parameters<Parameters<CustomerWorkOsRuntimeManager["mutate"]>[0]["operation"]>[0]) => service.createAccount({
      id,
      workspaceId: WORKSPACE,
      name,
      kinds: ["customer"],
      status: "active",
    }),
  };
}

describe("CustomerWorkOsRuntimeManager", () => {
  it("survives restart and replays the same idempotent response", async () => {
    const store = new InMemoryCustomerWorkOsSnapshotStore();
    const firstManager = new CustomerWorkOsRuntimeManager(store);
    const created = await firstManager.mutate(mutation("account-1", "고객 A"));
    expect(created.replayed).toBe(false);

    const restarted = new CustomerWorkOsRuntimeManager(store);
    const replay = await restarted.mutate(mutation("account-1", "고객 A"));
    expect(replay.replayed).toBe(true);
    expect(replay.payload).toEqual(created.payload);

    const state = await restarted.read(WORKSPACE, (service) => service.exportState());
    expect(state.accounts).toHaveLength(1);
    expect(state.accounts[0]?.name).toBe("고객 A");
  });

  it("rejects idempotency payload changes after restart", async () => {
    const store = new InMemoryCustomerWorkOsSnapshotStore();
    await new CustomerWorkOsRuntimeManager(store).mutate(mutation("account-1", "고객 A"));
    const restarted = new CustomerWorkOsRuntimeManager(store);
    await expect(restarted.mutate(mutation("account-1", "다른 고객"))).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("detects stale concurrent writers, reloads, and succeeds on explicit retry", async () => {
    const store = new InMemoryCustomerWorkOsSnapshotStore();
    const first = new CustomerWorkOsRuntimeManager(store);
    const second = new CustomerWorkOsRuntimeManager(store);

    await first.read(WORKSPACE, (service) => service.exportState());
    await second.read(WORKSPACE, (service) => service.exportState());
    await first.mutate(mutation("account-1", "고객 A"));
    await expect(second.mutate(mutation("account-2", "고객 B"))).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });

    const retried = await second.mutate({ ...mutation("account-2-retry", "고객 B"), idempotencyKey: "account-2-retry", requestHash: "hash:retry" });
    expect(retried.replayed).toBe(false);
    const state = await second.read(WORKSPACE, (service) => service.exportState());
    expect(state.accounts.map((item) => item.name).sort()).toEqual(["고객 A", "고객 B"]);
  });

  it("rolls back in-memory state when durable persistence fails", async () => {
    const base = new InMemoryCustomerWorkOsSnapshotStore();
    class FailingStore implements CustomerWorkOsSnapshotStore {
      async load(workspaceId: string) { return base.load(workspaceId); }
      async compareAndSwap(
        _workspaceId: string,
        _expectedVersion: number,
        _next: Omit<CustomerWorkOsRuntimeEnvelope, "version">,
        _audit: CustomerWorkOsMutationAudit,
      ): Promise<CustomerWorkOsRuntimeEnvelope> {
        throw new CustomerWorkOsError("PERSISTENCE_FAILED", "synthetic failure");
      }
    }
    const manager = new CustomerWorkOsRuntimeManager(new FailingStore());
    await expect(manager.mutate(mutation("account-1", "고객 A"))).rejects.toMatchObject({ code: "PERSISTENCE_FAILED" });
    const state = await manager.read(WORKSPACE, (service) => service.exportState());
    expect(state.accounts).toHaveLength(0);
  });

  it("writes a contiguous hash-chained audit event for every committed mutation", async () => {
    const store = new InMemoryCustomerWorkOsSnapshotStore();
    const manager = new CustomerWorkOsRuntimeManager(store);
    await manager.mutate(mutation("account-1", "고객 A"));
    await manager.mutate(mutation("account-2", "고객 B"));
    const events = store.auditLog(WORKSPACE);
    expect(events).toHaveLength(2);
    expect(events[0]?.sequence).toBe(1);
    expect(events[1]?.sequence).toBe(2);
    expect(events[1]?.previousEventHash).toBe(events[0]?.eventHash);
    expect(events[0]?.operationId).toBe("account.create");
    expect(events.every((item) => item.beforeStateHash !== item.afterStateHash)).toBe(true);
  });

  it("serializes concurrent mutations in one process without dropping either write", async () => {
    const store = new InMemoryCustomerWorkOsSnapshotStore();
    const manager = new CustomerWorkOsRuntimeManager(store);
    const [left, right] = await Promise.all([
      manager.mutate(mutation("account-1", "고객 A")),
      manager.mutate(mutation("account-2", "고객 B")),
    ]);
    expect(left.replayed).toBe(false);
    expect(right.replayed).toBe(false);
    const state = await manager.read(WORKSPACE, (service) => service.exportState());
    expect(state.accounts).toHaveLength(2);
    expect(store.auditLog(WORKSPACE)).toHaveLength(2);
  });
});
