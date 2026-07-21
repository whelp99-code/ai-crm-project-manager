import { describe, expect, it } from "vitest";
import {
  ActionRegistry,
  GovernanceAuthorizationService,
  InMemoryGovernanceRepository,
  intentToPersisted,
} from "@ai-crm/governance";
import { loadGovernance, runDurableOutboxDrainTick, runDurableWorkerTick, type WorkerRuntime } from "../src/main.js";

/**
 * G-02: proves worker lease recovery is durable against a SHARED governance
 * store, not just the in-process GovernanceAuthorizationService snapshot.
 *
 * Uses InMemoryGovernanceRepository (round-trips the same PersistedIntentShape
 * as PgGovernanceRepository — see packages/governance/src/pg-governance-adapter.ts)
 * as the shared SoR to avoid live-pg flakiness in CI. A LIVE_PG_TEST=1-gated
 * real-Postgres variant lives in worker-durable.live-pg.integration.test.ts.
 */
const registry = new ActionRegistry({ updateCustomer: "INTERNAL_REVERSIBLE_UPDATE" });

const authorizeRequest = {
  command: "updateCustomer",
  workspaceId: "ws-durable",
  resourceId: "customer-9",
  resourceVersion: 1,
  payload: { note: "durable-worker" },
  requesterPrincipalId: "seed-service",
};

describe("worker durable governance SoR (G-02)", () => {
  it("recovers an expired lease and persists QUEUED back to the shared repo", async () => {
    const sharedRepo = new InMemoryGovernanceRepository();

    // 1. Seed: authorize + lease an intent with an already-past deadline via a
    //    throwaway seeding service, then dual-write it into the shared repo —
    //    standing in for a prior worker/API process that leased, then crashed.
    const seedGovernance = new GovernanceAuthorizationService(registry);
    const seeded = seedGovernance.authorize(authorizeRequest);
    const intentId = seeded.intent!.id;
    const lease = seedGovernance.leaseIntent(
      intentId,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:01:00.000Z",
    );
    expect(lease.status).toBe("LEASED");
    await sharedRepo.saveIntent(intentToPersisted(seedGovernance.getIntent("ws-durable", intentId)));

    const seededBeforeRecover = await sharedRepo.loadIntent("ws-durable", intentId);
    expect(seededBeforeRecover?.status).toBe("LEASED");

    // 2. Construct worker governance hydrated from the shared repo (simulates
    //    worker process boot with DATABASE_URL set — see loadGovernance).
    const workerGovernance = new GovernanceAuthorizationService(new ActionRegistry({}));
    const [controls, intents] = await Promise.all([
      sharedRepo.listAllControls(),
      sharedRepo.listAllIntents(),
    ]);
    workerGovernance.hydrate({ controls, intents });
    expect(workerGovernance.getIntent("ws-durable", intentId).status).toBe("LEASED");

    const runtime: WorkerRuntime = {
      governance: workerGovernance,
      govRepo: sharedRepo,
      closePool: async () => {},
    };

    // 3. Run the tick past the lease deadline: LEASED -> QUEUED, dual-written.
    const logs: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const result = await runDurableWorkerTick(runtime, "2026-01-01T00:05:00.000Z", (message, data) => {
      logs.push({ message, ...(data !== undefined ? { data } : {}) });
    });

    expect(result.recoveredLeases).toHaveLength(1);
    expect(result.recoveredLeases[0]?.id).toBe(intentId);
    expect(result.recoveredLeases[0]?.status).toBe("QUEUED");
    expect(logs.some((l) => l.message === "worker.lease_recovered_persisted")).toBe(true);

    // In-process transition:
    expect(workerGovernance.getIntent("ws-durable", intentId).status).toBe("QUEUED");

    // 4. Durability proof: reload straight from the shared store (not the
    //    in-process governance instance) — must reflect QUEUED.
    const reloaded = await sharedRepo.loadIntent("ws-durable", intentId);
    expect(reloaded?.status).toBe("QUEUED");
    expect(reloaded?.leaseDeadline).toBeUndefined();

    // 5. Restart survival: a brand new governance instance hydrated again from
    //    the shared repo also sees QUEUED — proving the recovery persisted
    //    across a simulated worker restart, not just the current process.
    const restarted = new GovernanceAuthorizationService(new ActionRegistry({}));
    const [restartedControls, restartedIntents] = await Promise.all([
      sharedRepo.listAllControls(),
      sharedRepo.listAllIntents(),
    ]);
    restarted.hydrate({ controls: restartedControls, intents: restartedIntents });
    expect(restarted.getIntent("ws-durable", intentId).status).toBe("QUEUED");
  });

  it("does not dual-write when no leases are recovered", async () => {
    const sharedRepo = new InMemoryGovernanceRepository();
    const governance = new GovernanceAuthorizationService(new ActionRegistry({}));
    const runtime: WorkerRuntime = { governance, govRepo: sharedRepo, closePool: async () => {} };

    const result = await runDurableWorkerTick(runtime, "2026-01-01T00:00:00.000Z");
    expect(result.recoveredLeases).toHaveLength(0);
    expect(await sharedRepo.listAllIntents()).toHaveLength(0);
  });

  it("loadGovernance falls back to pure in-memory governance when DATABASE_URL is unset", async () => {
    const runtime = await loadGovernance({});
    expect(runtime.govRepo).toBeUndefined();
    expect(runtime.governance.snapshot().intents).toEqual({});
    await runtime.closePool();
  });

  it(
    "ADMIN_DATABASE_URL split: outbox drain uses adminGovRepo (not govRepo), saveIntent uses govRepo (not adminGovRepo)",
    async () => {
      // Two DISTINCT repos standing in for the two DSNs a real
      // ADMIN_DATABASE_URL split opens (admin/BYPASSRLS pool for
      // cross-workspace drain/hydrate vs scoped/NOBYPASSRLS pool for
      // per-workspace saveIntent) — see loadGovernance's ADMIN_DATABASE_URL
      // branch in src/main.ts.
      const scopedRuntimeRepo = new InMemoryGovernanceRepository();
      const adminRepo = new InMemoryGovernanceRepository();

      // Seed a PENDING outbox row ONLY on the admin repo.
      const workspaceId = "ws-admin-split";
      const appended = await adminRepo.appendAuditEvents(workspaceId, [
        { kind: "ADMIN_SPLIT_TEST", subjectId: "subject-1", data: { ok: true } },
      ]);
      expect(appended).toHaveLength(1);

      const governance = new GovernanceAuthorizationService(new ActionRegistry({}));
      const runtime: WorkerRuntime = {
        governance,
        govRepo: scopedRuntimeRepo,
        adminGovRepo: adminRepo,
        closePool: async () => {},
      };

      // 1. Outbox drain must claim/publish from adminGovRepo, never govRepo:
      // the scoped runtime repo has nothing PENDING, so a drain that
      // (incorrectly) targeted govRepo would claim zero rows.
      const drainResult = await runDurableOutboxDrainTick(runtime, { limit: 10 });
      expect(drainResult.claimed).toBe(1);
      expect(drainResult.published).toHaveLength(1);
      expect(await scopedRuntimeRepo.listAllIntents()).toEqual([]);

      // 2. Per-workspace saveIntent (lease-recovery dual-write) must go
      // through govRepo, never adminGovRepo: seed a LEASED intent directly
      // on govRepo's backing GovernanceAuthorizationService instance and
      // recover it via runDurableWorkerTick, then assert only govRepo (not
      // adminGovRepo) observed the persisted QUEUED intent.
      const authorizeRequest = {
        command: "updateCustomer",
        workspaceId,
        resourceId: "customer-admin-split",
        resourceVersion: 1,
        payload: { note: "admin-split" },
        requesterPrincipalId: "seed-service-admin-split",
      };
      const seedGovernance = new GovernanceAuthorizationService(registry);
      const seeded = seedGovernance.authorize(authorizeRequest);
      const intentId = seeded.intent!.id;
      seedGovernance.leaseIntent(intentId, "2026-01-01T00:00:00.000Z", "2026-01-01T00:01:00.000Z");

      const [controls, intents] = await Promise.all([adminRepo.listAllControls(), adminRepo.listAllIntents()]);
      // adminRepo has neither this workspace's controls nor intents yet —
      // hydrate the worker's in-process governance straight from the seeded
      // in-memory service instead, mirroring how loadGovernance hydrates
      // from listAllControls/listAllIntents before any tick runs.
      expect(controls).toEqual([]);
      expect(intents).toEqual([]);
      governance.hydrate({
        controls: [],
        intents: [intentToPersisted(seedGovernance.getIntent(workspaceId, intentId))],
      });
      expect(governance.getIntent(workspaceId, intentId).status).toBe("LEASED");

      const tickResult = await runDurableWorkerTick(runtime, "2026-01-01T00:05:00.000Z");
      expect(tickResult.recoveredLeases).toHaveLength(1);
      expect(tickResult.recoveredLeases[0]?.id).toBe(intentId);

      const persistedOnGovRepo = await scopedRuntimeRepo.loadIntent(workspaceId, intentId);
      expect(persistedOnGovRepo?.status).toBe("QUEUED");
      const persistedOnAdminRepo = await adminRepo.loadIntent(workspaceId, intentId);
      expect(persistedOnAdminRepo).toBeUndefined();
    },
  );
});
