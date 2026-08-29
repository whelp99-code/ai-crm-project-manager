import {
  CustomerWorkOsV25Error,
  CustomerWorkOsV25Platform,
  deterministicHash,
  type AutomationActor,
  type CustomerWorkOsV25State,
} from "@ai-crm/domain/customer-work-os-v2.5";

export interface V25IdempotencyRecord {
  key: string;
  requestHash: string;
  result: unknown;
  statusCode: number;
}

export interface V25StateEnvelope {
  workspaceId: string;
  version: number;
  state: CustomerWorkOsV25State;
  stateHash: string;
  idempotency: V25IdempotencyRecord[];
}

export interface V25StateStore {
  load(workspaceId: string): Promise<V25StateEnvelope | null>;
  save(input: {
    expectedVersion: number;
    next: V25StateEnvelope;
    operationId: string;
    principalId: string;
    command: string;
    idempotencyKey: string;
    requestHash: string;
    beforeStateHash: string;
    resultHash: string;
    createdAt: string;
  }): Promise<void>;
  close?(): Promise<void>;
}

export interface V25PgQueryable {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
  withWorkspaceScope?<T>(workspaceId: string, fn: (scoped: V25PgQueryable) => Promise<T>): Promise<T>;
}

export class InMemoryV25StateStore implements V25StateStore {
  private readonly states = new Map<string, V25StateEnvelope>();

  async load(workspaceId: string): Promise<V25StateEnvelope | null> {
    const item = this.states.get(workspaceId);
    return item ? structuredClone(item) : null;
  }

  async save(input: { expectedVersion: number; next: V25StateEnvelope }): Promise<void> {
    const current = this.states.get(input.next.workspaceId);
    const version = current?.version ?? 0;
    if (version !== input.expectedVersion) {
      throw new CustomerWorkOsV25Error("CONCURRENT_MODIFICATION", `expected version ${input.expectedVersion}, found ${version}`);
    }
    this.states.set(input.next.workspaceId, structuredClone(input.next));
  }
}

export class PgV25StateStore implements V25StateStore {
  constructor(private readonly db: V25PgQueryable) {}

  private async scoped<T>(workspaceId: string, fn: (db: V25PgQueryable) => Promise<T>): Promise<T> {
    if (!this.db.withWorkspaceScope) {
      throw new CustomerWorkOsV25Error("PG_SCOPE_REQUIRED", "PostgreSQL v2.5 store requires transaction-scoped workspace isolation");
    }
    return this.db.withWorkspaceScope(workspaceId, fn);
  }

  async load(workspaceId: string): Promise<V25StateEnvelope | null> {
    return this.scoped(workspaceId, async (db) => {
      const result = await db.query<{
        workspace_id: string;
        version: string | number;
        state: CustomerWorkOsV25State;
        state_hash: string;
        idempotency: V25IdempotencyRecord[];
      }>(
        `SELECT workspace_id, version, state, state_hash, idempotency
           FROM cwos_v25_automation_snapshots
          WHERE workspace_id = $1`,
        [workspaceId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const envelope: V25StateEnvelope = {
        workspaceId: row.workspace_id,
        version: Number(row.version),
        state: structuredClone(row.state),
        stateHash: row.state_hash,
        idempotency: structuredClone(row.idempotency ?? []),
      };
      if (deterministicHash(envelope.state) !== envelope.stateHash) {
        throw new CustomerWorkOsV25Error("STATE_HASH_MISMATCH", "stored v2.5 state hash does not match state");
      }
      return envelope;
    });
  }

  async save(input: {
    expectedVersion: number;
    next: V25StateEnvelope;
    operationId: string;
    principalId: string;
    command: string;
    idempotencyKey: string;
    requestHash: string;
    beforeStateHash: string;
    resultHash: string;
    createdAt: string;
  }): Promise<void> {
    await this.scoped(input.next.workspaceId, async (db) => {
      if (input.expectedVersion === 0) {
        const inserted = await db.query(
          `INSERT INTO cwos_v25_automation_snapshots
             (workspace_id, version, schema_version, state, idempotency, state_hash, updated_by_principal_id, updated_at)
           VALUES ($1, $2, 1, $3::jsonb, $4::jsonb, $5, $6, $7)
           ON CONFLICT (workspace_id) DO NOTHING`,
          [
            input.next.workspaceId,
            input.next.version,
            JSON.stringify(input.next.state),
            JSON.stringify(input.next.idempotency),
            input.next.stateHash,
            input.principalId,
            input.createdAt,
          ],
        );
        if ((inserted.rowCount ?? 0) !== 1) throw new CustomerWorkOsV25Error("CONCURRENT_MODIFICATION", "v2.5 workspace was initialized concurrently");
      } else {
        const updated = await db.query(
          `UPDATE cwos_v25_automation_snapshots
              SET version = $3,
                  state = $4::jsonb,
                  idempotency = $5::jsonb,
                  state_hash = $6,
                  updated_by_principal_id = $7,
                  updated_at = $8
            WHERE workspace_id = $1 AND version = $2`,
          [
            input.next.workspaceId,
            input.expectedVersion,
            input.next.version,
            JSON.stringify(input.next.state),
            JSON.stringify(input.next.idempotency),
            input.next.stateHash,
            input.principalId,
            input.createdAt,
          ],
        );
        if ((updated.rowCount ?? 0) !== 1) throw new CustomerWorkOsV25Error("CONCURRENT_MODIFICATION", "v2.5 runtime version changed");
      }

      const previous = await db.query<{ sequence: string | number; event_hash: string }>(
        `SELECT sequence, event_hash
           FROM cwos_v25_automation_audit_events
          WHERE workspace_id = $1
          ORDER BY sequence DESC
          LIMIT 1`,
        [input.next.workspaceId],
      );
      const previousSequence = previous.rows[0] ? Number(previous.rows[0].sequence) : 0;
      const previousEventHash = previous.rows[0]?.event_hash ?? null;
      const eventHash = deterministicHash({
        workspaceId: input.next.workspaceId,
        sequence: previousSequence + 1,
        operationId: input.operationId,
        command: input.command,
        requestHash: input.requestHash,
        beforeStateHash: input.beforeStateHash,
        afterStateHash: input.next.stateHash,
        resultHash: input.resultHash,
        previousEventHash,
      });
      await db.query(
        `INSERT INTO cwos_v25_automation_audit_events
           (workspace_id, sequence, operation_id, principal_id, command, idempotency_key,
            request_hash, before_state_hash, after_state_hash, result_hash, previous_event_hash, event_hash, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          input.next.workspaceId,
          previousSequence + 1,
          input.operationId,
          input.principalId,
          input.command,
          input.idempotencyKey,
          input.requestHash,
          input.beforeStateHash,
          input.next.stateHash,
          input.resultHash,
          previousEventHash,
          eventHash,
          input.createdAt,
        ],
      );
    });
  }
}

function initialEnvelope(workspaceId: string): V25StateEnvelope {
  const platform = new CustomerWorkOsV25Platform(workspaceId);
  const state = platform.exportState();
  return { workspaceId, version: 0, state, stateHash: deterministicHash(state), idempotency: [] };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CustomerWorkOsV25Error("INVALID_INPUT", "payload must be an object");
  }
  return value as Record<string, unknown>;
}

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new CustomerWorkOsV25Error("INVALID_INPUT", `${key} is required`);
  return value.trim();
}

export function executeV25Command(
  platform: CustomerWorkOsV25Platform,
  command: string,
  payload: unknown,
  actor: AutomationActor,
): unknown {
  const input = object(payload);
  switch (command) {
    case "baseline.build":
      return platform.baseline.build(input as never, actor);
    case "baseline.answer":
      return platform.baseline.answerQuestion(text(input, "questionId"), input.answer, actor);
    case "baseline.apply":
      return platform.baseline.apply(text(input, "planId"), text(input, "appliedAt"), actor);
    case "capture.submit":
      return platform.capture.submit(input.capture as never, input.context as never, actor);
    case "capture.answer":
      return platform.capture.answerQuestion(text(input, "questionId"), input.answer, actor);
    case "capture.approve":
      return platform.capture.approvePlan(
        text(input, "planId"),
        Array.isArray(input.approvedMutationIds) ? input.approvedMutationIds.filter((item): item is string => typeof item === "string") : [],
        text(input, "approvedAt"),
        actor,
      );
    case "capture.apply":
      return platform.capture.markApplied(text(input, "planId"), actor);
    case "clarification.create":
      return platform.clarification.createTasks(input as never, actor);
    case "clarification.answer":
      return platform.clarification.answer(input as never, actor);
    case "sync.register":
      return platform.sync.register(input as never, actor);
    case "sync.ingestBatch":
      return platform.sync.ingestBatch(input as never, actor);
    case "manager.run":
      return platform.manager.runDaily(input.snapshot as never, input.thresholds as never, actor);
    case "manager.acknowledge":
      return platform.manager.acknowledge(text(input, "findingId"), actor);
    default:
      throw new CustomerWorkOsV25Error("UNKNOWN_COMMAND", `unknown v2.5 command: ${command}`);
  }
}

export class CustomerWorkOsV25RuntimeManager {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly store: V25StateStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async read(workspaceId: string): Promise<V25StateEnvelope> {
    return structuredClone((await this.store.load(workspaceId)) ?? initialEnvelope(workspaceId));
  }

  async command(input: {
    workspaceId: string;
    actor: AutomationActor;
    expectedVersion: number;
    idempotencyKey: string;
    command: string;
    payload: unknown;
  }): Promise<{ statusCode: number; result: unknown; envelope: V25StateEnvelope }> {
    const previous = this.queues.get(input.workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.then(() => next);
    this.queues.set(input.workspaceId, chain);
    await previous;
    try {
      const envelope = await this.read(input.workspaceId);
      const requestHash = deterministicHash({ command: input.command, payload: input.payload, actor: input.actor });
      const replay = envelope.idempotency.find((item) => item.key === input.idempotencyKey);
      if (replay) {
        if (replay.requestHash !== requestHash) throw new CustomerWorkOsV25Error("IDEMPOTENCY_CONFLICT", "idempotency key was reused with a different request");
        return { statusCode: replay.statusCode, result: structuredClone(replay.result), envelope };
      }
      if (envelope.version !== input.expectedVersion) {
        throw new CustomerWorkOsV25Error("CONCURRENT_MODIFICATION", `expected version ${input.expectedVersion}, found ${envelope.version}`);
      }
      const platform = new CustomerWorkOsV25Platform(input.workspaceId);
      platform.hydrateState(envelope.state);
      const result = executeV25Command(platform, input.command, input.payload, input.actor);
      const state = platform.exportState();
      const idempotency = [
        ...envelope.idempotency,
        { key: input.idempotencyKey, requestHash, result: structuredClone(result), statusCode: 201 },
      ].slice(-1000);
      const nextEnvelope: V25StateEnvelope = {
        workspaceId: input.workspaceId,
        version: envelope.version + 1,
        state,
        stateHash: deterministicHash(state),
        idempotency,
      };
      await this.store.save({
        expectedVersion: envelope.version,
        next: nextEnvelope,
        operationId: `v25-${deterministicHash({ workspaceId: input.workspaceId, key: input.idempotencyKey }).slice(-16)}`,
        principalId: input.actor.principalId,
        command: input.command,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        beforeStateHash: envelope.stateHash,
        resultHash: deterministicHash(result),
        createdAt: this.now(),
      });
      return { statusCode: 201, result: structuredClone(result), envelope: structuredClone(nextEnvelope) };
    } finally {
      release();
      if (this.queues.get(input.workspaceId) === chain) this.queues.delete(input.workspaceId);
    }
  }

  async close(): Promise<void> {
    if (this.store.close) await this.store.close();
  }
}
