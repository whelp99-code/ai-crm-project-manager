import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InMemoryOrchestrationStore,
  OrchestrationService,
  assembleSnapshot,
  createPgOrchestrationRepository,
  mapEventRow,
  mapJobRow,
  mapWorkItemRow,
  type OrchJobEventRow,
  type OrchJobRow,
  type OrchWorkItemRow,
  type PgQueryable,
  type PgQueryResult,
} from "../src/index.js";

const jobRow: OrchJobRow = {
  id: "job-000001",
  workspace_id: "11111111-1111-1111-1111-111111111111",
  source: "natural_command",
  raw_text: "assign task",
  plan_invocation_id: "plan-1",
  status: "open",
  created_by_principal_id: "principal-1",
  idempotency_key: "idem-1",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:01.000Z",
};

const workItemRow: OrchWorkItemRow = {
  id: "wi-000001",
  job_id: "job-000001",
  workspace_id: "11111111-1111-1111-1111-111111111111",
  sequence: 1,
  title: "Assign task",
  status: "queued",
  suggested_command: "pm.task_assign",
  action_type: "PM_TASK_ASSIGN",
  assigned_principal_id: null,
  control_id: null,
  intent_id: null,
  resource_type: "task",
  resource_id: "task-1",
  resource_version: 1,
  progress: 0,
  error_code: null,
  result_ref: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const eventRow: OrchJobEventRow = {
  id: "evt-000001",
  job_id: "job-000001",
  workspace_id: "11111111-1111-1111-1111-111111111111",
  kind: "job.created",
  payload: { stepCount: 1 },
  at: "2026-01-01T00:00:00.000Z",
};

describe("ORCH-PG-01 pure row mappers", () => {
  it("maps job / work item / event rows to JobSnapshot shapes", () => {
    const job = mapJobRow(jobRow);
    expect(job).toMatchObject({
      id: "job-000001",
      workspaceId: jobRow.workspace_id,
      source: "natural_command",
      rawText: "assign task",
      planInvocationId: "plan-1",
      status: "open",
      createdByPrincipalId: "principal-1",
      idempotencyKey: "idem-1",
    });
    expect(job.workItemIds).toEqual([]);

    const item = mapWorkItemRow(workItemRow);
    expect(item).toMatchObject({
      id: "wi-000001",
      jobId: "job-000001",
      sequence: 1,
      title: "Assign task",
      status: "queued",
      suggestedCommand: "pm.task_assign",
      actionType: "PM_TASK_ASSIGN",
      resourceType: "task",
      resourceId: "task-1",
      resourceVersion: 1,
      progress: 0,
    });
    expect(item.controlId).toBeUndefined();

    const event = mapEventRow(eventRow);
    expect(event).toEqual({
      id: "evt-000001",
      jobId: "job-000001",
      workspaceId: jobRow.workspace_id,
      kind: "job.created",
      payload: { stepCount: 1 },
      at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("assembleSnapshot sorts work items by sequence and fills workItemIds", () => {
    const second: OrchWorkItemRow = {
      ...workItemRow,
      id: "wi-000002",
      sequence: 2,
      title: "Second",
      resource_type: null,
      resource_id: null,
      resource_version: null,
    };
    const snap = assembleSnapshot(jobRow, [second, workItemRow], [eventRow]);
    expect(snap.workItems.map((item) => item.id)).toEqual(["wi-000001", "wi-000002"]);
    expect(snap.job.workItemIds).toEqual(["wi-000001", "wi-000002"]);
    expect(snap.events).toHaveLength(1);
  });
});

describe("ORCH-PG-02 InMemoryOrchestrationStore round-trip", () => {
  it("saveSnapshot / getJob / getByIdempotency round-trip a live service snapshot", async () => {
    const service = new OrchestrationService();
    const created = service.createJob({
      workspaceId: "ws-1",
      createdBy: "principal-1",
      idempotencyKey: "k-1",
      source: "api",
      steps: [{ title: "One", actionType: "PM_TASK_ASSIGN" }],
    });

    const store = new InMemoryOrchestrationStore();
    await store.saveSnapshot(created);

    const byId = await store.getJob("ws-1", created.job.id);
    expect(byId).toEqual(created);
    const byKey = await store.getByIdempotency("ws-1", "k-1");
    expect(byKey?.job.id).toBe(created.job.id);
    expect(await store.getJob("ws-other", created.job.id)).toBeUndefined();
  });

  it("survives restart via JSON file serialize/deserialize", async () => {
    const service = new OrchestrationService();
    const created = service.createJob({
      workspaceId: "ws-1",
      createdBy: "principal-1",
      idempotencyKey: "restart-1",
      steps: [{ title: "Persist me" }],
    });
    const store = new InMemoryOrchestrationStore();
    await store.saveSnapshot(created);

    const dir = mkdtempSync(join(tmpdir(), "orch-pg-"));
    const file = join(dir, "snapshots.json");
    writeFileSync(file, JSON.stringify(store.toJSON()), "utf8");

    const revived = InMemoryOrchestrationStore.fromJSON(
      JSON.parse(readFileSync(file, "utf8")) as ReturnType<InMemoryOrchestrationStore["toJSON"]>,
    );
    const loaded = await revived.getByIdempotency("ws-1", "restart-1");
    expect(loaded?.job.id).toBe(created.job.id);
    expect(loaded?.workItems[0]?.title).toBe("Persist me");
  });

  it("listJobSnapshots returns all snapshots, optionally scoped by workspace", async () => {
    const store = new InMemoryOrchestrationStore();
    const svc = new OrchestrationService();
    const a = svc.createJob({ workspaceId: "ws-1", createdBy: "p1", steps: [{ title: "A" }] });
    const b = svc.createJob({ workspaceId: "ws-2", createdBy: "p1", steps: [{ title: "B" }] });
    await store.saveSnapshot(a);
    await store.saveSnapshot(b);

    const all = await store.listJobSnapshots();
    expect(all.map((s) => s.job.id).sort()).toEqual([a.job.id, b.job.id].sort());

    const scoped = await store.listJobSnapshots("ws-1");
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.job.id).toBe(a.job.id);
  });
});

describe("ORCH-PG-03 createPgOrchestrationRepository with mock client", () => {
  it("round-trips saveSnapshot → getJob through a mock queryable", async () => {
    const jobs = new Map<string, OrchJobRow>();
    const items = new Map<string, OrchWorkItemRow[]>();
    const events = new Map<string, OrchJobEventRow[]>();

    const mock: PgQueryable = {
      async query<T = unknown>(text: string, params: unknown[] = []): Promise<PgQueryResult<T>> {
        const sql = text.replace(/\s+/g, " ").trim();

        if (sql.startsWith("INSERT INTO orch_jobs")) {
          const row: OrchJobRow = {
            id: String(params[0]),
            workspace_id: String(params[1]),
            source: String(params[2]),
            raw_text: (params[3] as string | null) ?? null,
            plan_invocation_id: (params[4] as string | null) ?? null,
            status: String(params[5]),
            created_by_principal_id: String(params[6]),
            idempotency_key: (params[7] as string | null) ?? null,
            created_at: String(params[8]),
            updated_at: String(params[9]),
          };
          jobs.set(`${row.workspace_id}\0${row.id}`, row);
          return { rows: [], rowCount: 1 };
        }

        if (sql.startsWith("DELETE FROM orch_work_items")) {
          items.set(`${params[0]}\0${params[1]}`, []);
          return { rows: [], rowCount: 1 };
        }

        if (sql.startsWith("INSERT INTO orch_work_items")) {
          const key = `${params[2]}\0${params[1]}`;
          const list = items.get(key) ?? [];
          list.push({
            id: String(params[0]),
            job_id: String(params[1]),
            workspace_id: String(params[2]),
            sequence: Number(params[3]),
            title: String(params[4]),
            status: String(params[5]),
            suggested_command: (params[6] as string | null) ?? null,
            action_type: (params[7] as string | null) ?? null,
            assigned_principal_id: (params[8] as string | null) ?? null,
            control_id: (params[9] as string | null) ?? null,
            intent_id: (params[10] as string | null) ?? null,
            resource_type: (params[11] as string | null) ?? null,
            resource_id: (params[12] as string | null) ?? null,
            resource_version: (params[13] as number | null) ?? null,
            progress: Number(params[14] ?? 0),
            error_code: (params[15] as string | null) ?? null,
            result_ref: params[16] == null ? null : JSON.parse(String(params[16])),
            created_at: String(params[17]),
            updated_at: String(params[18]),
          });
          items.set(key, list);
          return { rows: [], rowCount: 1 };
        }

        if (sql.startsWith("DELETE FROM orch_job_events")) {
          events.set(`${params[0]}\0${params[1]}`, []);
          return { rows: [], rowCount: 1 };
        }

        if (sql.startsWith("INSERT INTO orch_job_events")) {
          const key = `${params[2]}\0${params[1]}`;
          const list = events.get(key) ?? [];
          list.push({
            id: String(params[0]),
            job_id: String(params[1]),
            workspace_id: String(params[2]),
            kind: String(params[3]),
            payload: JSON.parse(String(params[4])),
            at: String(params[5]),
          });
          events.set(key, list);
          return { rows: [], rowCount: 1 };
        }

        if (sql.startsWith("SELECT * FROM orch_jobs WHERE workspace_id = $1 AND id = $2")) {
          const row = jobs.get(`${params[0]}\0${params[1]}`);
          return { rows: (row ? [row] : []) as T[], rowCount: row ? 1 : 0 };
        }

        if (sql.startsWith("SELECT * FROM orch_jobs WHERE workspace_id = $1 AND idempotency_key = $2")) {
          const row = [...jobs.values()].find(
            (j) => j.workspace_id === params[0] && j.idempotency_key === params[1],
          );
          return { rows: (row ? [row] : []) as T[], rowCount: row ? 1 : 0 };
        }

        if (sql.startsWith("SELECT * FROM orch_work_items")) {
          const list = items.get(`${params[0]}\0${params[1]}`) ?? [];
          return { rows: list as T[], rowCount: list.length };
        }

        if (sql.startsWith("SELECT * FROM orch_job_events")) {
          const list = events.get(`${params[0]}\0${params[1]}`) ?? [];
          return { rows: list as T[], rowCount: list.length };
        }

        if (sql.startsWith("SELECT * FROM orch_jobs WHERE workspace_id = $1 ORDER BY")) {
          const rows = [...jobs.values()].filter((j) => j.workspace_id === params[0]);
          return { rows: rows as T[], rowCount: rows.length };
        }

        if (sql.startsWith("SELECT * FROM orch_jobs ORDER BY")) {
          const rows = [...jobs.values()];
          return { rows: rows as T[], rowCount: rows.length };
        }

        throw new Error(`unexpected SQL in mock: ${sql}`);
      },
    };

    const repo = createPgOrchestrationRepository(mock);
    const service = new OrchestrationService();
    const created = service.createJob({
      workspaceId: "ws-1",
      createdBy: "p1",
      idempotencyKey: "idem-pg",
      steps: [
        {
          title: "Step",
          resourceType: "task",
          resourceId: "t-1",
          resourceVersion: 2,
        },
      ],
    });

    await repo.saveSnapshot(created);
    const loaded = await repo.getJob("ws-1", created.job.id);
    expect(loaded?.job.id).toBe(created.job.id);
    expect(loaded?.job.idempotencyKey).toBe("idem-pg");
    expect(loaded?.workItems).toHaveLength(1);
    expect(loaded?.workItems[0]?.resourceType).toBe("task");
    expect(loaded?.workItems[0]?.resourceId).toBe("t-1");
    expect(loaded?.events.some((e) => e.kind === "job.created")).toBe(true);

    const byKey = await repo.getByIdempotency("ws-1", "idem-pg");
    expect(byKey?.job.id).toBe(created.job.id);
  });

  it("listJobSnapshots assembles snapshots for all jobs, optionally scoped by workspace", async () => {
    const jobs = new Map<string, OrchJobRow>();
    const items = new Map<string, OrchWorkItemRow[]>();
    const events = new Map<string, OrchJobEventRow[]>();

    const mock: PgQueryable = {
      async query<T = unknown>(text: string, params: unknown[] = []): Promise<PgQueryResult<T>> {
        const sql = text.replace(/\s+/g, " ").trim();

        if (sql.startsWith("INSERT INTO orch_jobs")) {
          const row: OrchJobRow = {
            id: String(params[0]),
            workspace_id: String(params[1]),
            source: String(params[2]),
            raw_text: (params[3] as string | null) ?? null,
            plan_invocation_id: (params[4] as string | null) ?? null,
            status: String(params[5]),
            created_by_principal_id: String(params[6]),
            idempotency_key: (params[7] as string | null) ?? null,
            created_at: String(params[8]),
            updated_at: String(params[9]),
          };
          jobs.set(`${row.workspace_id}\0${row.id}`, row);
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith("DELETE FROM orch_work_items")) {
          items.set(`${params[0]}\0${params[1]}`, []);
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO orch_work_items")) {
          const key = `${params[2]}\0${params[1]}`;
          const list = items.get(key) ?? [];
          list.push({
            id: String(params[0]),
            job_id: String(params[1]),
            workspace_id: String(params[2]),
            sequence: Number(params[3]),
            title: String(params[4]),
            status: String(params[5]),
            suggested_command: (params[6] as string | null) ?? null,
            action_type: (params[7] as string | null) ?? null,
            assigned_principal_id: (params[8] as string | null) ?? null,
            control_id: (params[9] as string | null) ?? null,
            intent_id: (params[10] as string | null) ?? null,
            resource_type: (params[11] as string | null) ?? null,
            resource_id: (params[12] as string | null) ?? null,
            resource_version: (params[13] as number | null) ?? null,
            progress: Number(params[14] ?? 0),
            error_code: (params[15] as string | null) ?? null,
            result_ref: params[16] == null ? null : JSON.parse(String(params[16])),
            created_at: String(params[17]),
            updated_at: String(params[18]),
          });
          items.set(key, list);
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith("DELETE FROM orch_job_events")) {
          events.set(`${params[0]}\0${params[1]}`, []);
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO orch_job_events")) {
          const key = `${params[2]}\0${params[1]}`;
          const list = events.get(key) ?? [];
          list.push({
            id: String(params[0]),
            job_id: String(params[1]),
            workspace_id: String(params[2]),
            kind: String(params[3]),
            payload: JSON.parse(String(params[4])),
            at: String(params[5]),
          });
          events.set(key, list);
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith("SELECT * FROM orch_jobs WHERE workspace_id = $1 ORDER BY")) {
          const rows = [...jobs.values()].filter((j) => j.workspace_id === params[0]);
          return { rows: rows as T[], rowCount: rows.length };
        }
        if (sql.startsWith("SELECT * FROM orch_jobs ORDER BY")) {
          const rows = [...jobs.values()];
          return { rows: rows as T[], rowCount: rows.length };
        }
        if (sql.startsWith("SELECT * FROM orch_work_items")) {
          const list = items.get(`${params[0]}\0${params[1]}`) ?? [];
          return { rows: list as T[], rowCount: list.length };
        }
        if (sql.startsWith("SELECT * FROM orch_job_events")) {
          const list = events.get(`${params[0]}\0${params[1]}`) ?? [];
          return { rows: list as T[], rowCount: list.length };
        }
        throw new Error(`unexpected SQL in mock: ${sql}`);
      },
    };

    const repo = createPgOrchestrationRepository(mock);
    const service = new OrchestrationService();
    const jobA = service.createJob({ workspaceId: "ws-1", createdBy: "p1", steps: [{ title: "A" }] });
    const jobB = service.createJob({ workspaceId: "ws-2", createdBy: "p1", steps: [{ title: "B" }] });
    await repo.saveSnapshot(jobA);
    await repo.saveSnapshot(jobB);

    const all = await repo.listJobSnapshots();
    expect(all.map((s) => s.job.id).sort()).toEqual([jobA.job.id, jobB.job.id].sort());

    const scoped = await repo.listJobSnapshots("ws-1");
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.job.id).toBe(jobA.job.id);
    expect(scoped[0]?.workItems[0]?.title).toBe("A");
  });
});
