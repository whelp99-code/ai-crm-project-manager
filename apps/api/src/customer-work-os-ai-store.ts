import {
  CustomerWorkOsAiError,
  CustomerWorkOsAiService,
  type AiSuggestion,
} from "@ai-crm/ai-orchestrator/customer-work-os-ai";

export interface AiSuggestionStore {
  create(suggestion: AiSuggestion): Promise<AiSuggestion>;
  compareAndSwap(workspaceId: string, suggestionId: string, expectedVersion: number, next: AiSuggestion): Promise<AiSuggestion>;
  get(workspaceId: string, suggestionId: string): Promise<AiSuggestion | undefined>;
  list(workspaceId: string, status?: AiSuggestion["status"]): Promise<AiSuggestion[]>;
  close?(): Promise<void>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryAiSuggestionStore implements AiSuggestionStore {
  private readonly rows = new Map<string, AiSuggestion>();

  async create(suggestion: AiSuggestion): Promise<AiSuggestion> {
    const key = `${suggestion.workspaceId}\u0000${suggestion.id}`;
    if (this.rows.has(key)) throw new CustomerWorkOsAiError("DUPLICATE_ID", `suggestion exists: ${suggestion.id}`);
    this.rows.set(key, copy(suggestion));
    return copy(suggestion);
  }

  async compareAndSwap(workspaceId: string, suggestionId: string, expectedVersion: number, next: AiSuggestion): Promise<AiSuggestion> {
    const key = `${workspaceId}\u0000${suggestionId}`;
    const current = this.rows.get(key);
    if (!current) throw new CustomerWorkOsAiError("NOT_FOUND", `suggestion not found: ${suggestionId}`);
    if (current.version !== expectedVersion) throw new CustomerWorkOsAiError("CONCURRENT_MODIFICATION", `expected version ${expectedVersion}, found ${current.version}`);
    if (next.workspaceId !== workspaceId || next.id !== suggestionId || next.version !== expectedVersion + 1) throw new CustomerWorkOsAiError("INVALID_STATE", "invalid suggestion CAS payload");
    this.rows.set(key, copy(next));
    return copy(next);
  }

  async get(workspaceId: string, suggestionId: string): Promise<AiSuggestion | undefined> {
    const row = this.rows.get(`${workspaceId}\u0000${suggestionId}`);
    return row ? copy(row) : undefined;
  }

  async list(workspaceId: string, status?: AiSuggestion["status"]): Promise<AiSuggestion[]> {
    return [...this.rows.values()]
      .filter((item) => item.workspaceId === workspaceId && (status === undefined || item.status === status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
      .map((item) => copy(item));
  }
}

interface QueryResult<T> { rows: T[]; rowCount?: number | null }
interface SqlConnection {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
  release(): void;
}
interface SqlPool {
  connect(): Promise<SqlConnection>;
  end(): Promise<void>;
}

async function withWorkspace<T>(pool: SqlPool, workspaceId: string, operation: (connection: SqlConnection) => Promise<T>): Promise<T> {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await operation(connection);
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

interface SuggestionRow {
  id: string;
  workspace_id: string;
  account_id: string | null;
  engagement_id: string | null;
  agent_role: AiSuggestion["agentRole"];
  suggestion_kind: AiSuggestion["kind"];
  title: string;
  proposed_payload: Record<string, unknown>;
  evidence: AiSuggestion["evidence"];
  confidence: string | number;
  risk: AiSuggestion["risk"];
  status: AiSuggestion["status"];
  requires_human_review: boolean;
  proposed_command: AiSuggestion["proposedCommand"] | null;
  input_digest: string;
  response_digest: string;
  model_version: string;
  prompt_version: string;
  usage: AiSuggestion["usage"];
  created_by_principal_id: string;
  reviewed_by_principal_id: string | null;
  review_reason: string | null;
  created_at: Date | string;
  expires_at: Date | string;
  version: number;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function fromRow(row: SuggestionRow): AiSuggestion {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ...(row.account_id ? { accountId: row.account_id } : {}),
    ...(row.engagement_id ? { engagementId: row.engagement_id } : {}),
    agentRole: row.agent_role,
    kind: row.suggestion_kind,
    title: row.title,
    proposedPayload: copy(row.proposed_payload),
    evidence: copy(row.evidence),
    confidence: Number(row.confidence),
    risk: row.risk,
    status: row.status,
    requiresHumanReview: row.requires_human_review,
    ...(row.proposed_command ? { proposedCommand: copy(row.proposed_command) } : {}),
    inputDigest: row.input_digest,
    responseDigest: row.response_digest,
    modelVersion: row.model_version,
    promptVersion: row.prompt_version,
    usage: copy(row.usage),
    createdByPrincipalId: row.created_by_principal_id,
    ...(row.reviewed_by_principal_id ? { reviewedByPrincipalId: row.reviewed_by_principal_id } : {}),
    ...(row.review_reason ? { reviewReason: row.review_reason } : {}),
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    version: row.version,
  };
}

const COLUMNS = `id, workspace_id, account_id, engagement_id, agent_role,
  suggestion_kind, title, proposed_payload, evidence, confidence, risk, status,
  requires_human_review, proposed_command, input_digest, response_digest,
  model_version, prompt_version, usage, created_by_principal_id,
  reviewed_by_principal_id, review_reason, created_at, expires_at, version`;

export class PgAiSuggestionStore implements AiSuggestionStore {
  constructor(private readonly pool: SqlPool) {}

  async create(suggestion: AiSuggestion): Promise<AiSuggestion> {
    return withWorkspace(this.pool, suggestion.workspaceId, async (connection) => {
      const result = await connection.query<SuggestionRow>(
        `INSERT INTO cwos_ai_suggestions
          (id, workspace_id, account_id, engagement_id, agent_role, suggestion_kind,
           title, proposed_payload, evidence, confidence, risk, status,
           requires_human_review, proposed_command, input_digest, response_digest,
           model_version, prompt_version, usage, created_by_principal_id,
           reviewed_by_principal_id, review_reason, created_at, expires_at, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14::jsonb,
                 $15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23::timestamptz,$24::timestamptz,$25)
         RETURNING ${COLUMNS}`,
        [suggestion.id, suggestion.workspaceId, suggestion.accountId ?? null,
         suggestion.engagementId ?? null, suggestion.agentRole, suggestion.kind,
         suggestion.title, JSON.stringify(suggestion.proposedPayload), JSON.stringify(suggestion.evidence),
         suggestion.confidence, suggestion.risk, suggestion.status,
         suggestion.requiresHumanReview, suggestion.proposedCommand ? JSON.stringify(suggestion.proposedCommand) : null,
         suggestion.inputDigest, suggestion.responseDigest, suggestion.modelVersion,
         suggestion.promptVersion, JSON.stringify(suggestion.usage), suggestion.createdByPrincipalId,
         suggestion.reviewedByPrincipalId ?? null, suggestion.reviewReason ?? null,
         suggestion.createdAt, suggestion.expiresAt, suggestion.version],
      );
      const row = result.rows[0];
      if (!row) throw new CustomerWorkOsAiError("PERSISTENCE_FAILED", "AI suggestion was not inserted");
      await connection.query(
        `INSERT INTO cwos_ai_suggestion_events
          (workspace_id, suggestion_id, event_type, actor_principal_id,
           before_hash, after_hash, reason, occurred_at)
         VALUES ($1,$2,'PROPOSED',$3,NULL,$4,'AI suggestion proposed',$5::timestamptz)`,
        [suggestion.workspaceId, suggestion.id, suggestion.createdByPrincipalId,
         suggestion.responseDigest, suggestion.createdAt],
      );
      return fromRow(row);
    });
  }

  async compareAndSwap(workspaceId: string, suggestionId: string, expectedVersion: number, next: AiSuggestion): Promise<AiSuggestion> {
    return withWorkspace(this.pool, workspaceId, async (connection) => {
      const current = await connection.query<SuggestionRow>(
        `SELECT ${COLUMNS} FROM cwos_ai_suggestions
          WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
        [workspaceId, suggestionId],
      );
      const before = current.rows[0];
      if (!before) throw new CustomerWorkOsAiError("NOT_FOUND", `suggestion not found: ${suggestionId}`);
      if (before.version !== expectedVersion) throw new CustomerWorkOsAiError("CONCURRENT_MODIFICATION", `expected version ${expectedVersion}, found ${before.version}`);
      if (next.version !== expectedVersion + 1) throw new CustomerWorkOsAiError("INVALID_STATE", "suggestion version must increment once");
      const updated = await connection.query<SuggestionRow>(
        `UPDATE cwos_ai_suggestions
            SET status = $4, reviewed_by_principal_id = $5, review_reason = $6,
                version = version + 1, updated_at = $7::timestamptz
          WHERE workspace_id = $1 AND id = $2 AND version = $3
          RETURNING ${COLUMNS}`,
        [workspaceId, suggestionId, expectedVersion, next.status,
         next.reviewedByPrincipalId ?? null, next.reviewReason ?? null, new Date().toISOString()],
      );
      const row = updated.rows[0];
      if (!row) throw new CustomerWorkOsAiError("CONCURRENT_MODIFICATION", "suggestion changed concurrently");
      const eventType = next.status === "ACCEPTED" ? "ACCEPTED" : next.status === "REJECTED" ? "REJECTED" : "EXPIRED";
      await connection.query(
        `INSERT INTO cwos_ai_suggestion_events
          (workspace_id, suggestion_id, event_type, actor_principal_id,
           before_hash, after_hash, reason, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)`,
        [workspaceId, suggestionId, eventType, next.reviewedByPrincipalId,
         before.response_digest, next.responseDigest, next.reviewReason, new Date().toISOString()],
      );
      return fromRow(row);
    });
  }

  async get(workspaceId: string, suggestionId: string): Promise<AiSuggestion | undefined> {
    return withWorkspace(this.pool, workspaceId, async (connection) => {
      const result = await connection.query<SuggestionRow>(
        `SELECT ${COLUMNS} FROM cwos_ai_suggestions WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, suggestionId],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : undefined;
    });
  }

  async list(workspaceId: string, status?: AiSuggestion["status"]): Promise<AiSuggestion[]> {
    return withWorkspace(this.pool, workspaceId, async (connection) => {
      const result = status
        ? await connection.query<SuggestionRow>(
            `SELECT ${COLUMNS} FROM cwos_ai_suggestions
              WHERE workspace_id = $1 AND status = $2 ORDER BY created_at DESC, id`,
            [workspaceId, status],
          )
        : await connection.query<SuggestionRow>(
            `SELECT ${COLUMNS} FROM cwos_ai_suggestions
              WHERE workspace_id = $1 ORDER BY created_at DESC, id`,
            [workspaceId],
          );
      return result.rows.map(fromRow);
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class CustomerWorkOsAiRuntime {
  constructor(private readonly store: AiSuggestionStore) {}

  async propose(input: Parameters<CustomerWorkOsAiService["propose"]>[0]): Promise<AiSuggestion> {
    const service = new CustomerWorkOsAiService();
    const suggestion = service.propose(input);
    return this.store.create(suggestion);
  }

  async review(input: {
    workspaceId: string;
    suggestionId: string;
    expectedVersion: number;
    reviewerPrincipalId: string;
    reviewerKind: "HUMAN" | "AI" | "SERVICE";
    decision: "ACCEPT" | "REJECT";
    reason: string;
    now: string;
  }): Promise<AiSuggestion> {
    if (input.reviewerKind !== "HUMAN") throw new CustomerWorkOsAiError("HUMAN_REVIEW_REQUIRED", "AI suggestions require a human reviewer");
    const existing = await this.store.get(input.workspaceId, input.suggestionId);
    if (!existing) throw new CustomerWorkOsAiError("NOT_FOUND", `suggestion not found: ${input.suggestionId}`);
    if (existing.createdByPrincipalId === input.reviewerPrincipalId) {
      throw new CustomerWorkOsAiError("INDEPENDENT_REVIEW_REQUIRED", "suggestion creator cannot review their own output");
    }
    if (existing.version !== input.expectedVersion) {
      throw new CustomerWorkOsAiError("CONCURRENT_MODIFICATION", `expected version ${input.expectedVersion}, found ${existing.version}`);
    }
    const service = new CustomerWorkOsAiService();
    service.hydrate([existing]);
    const next = service.review(
      input.workspaceId,
      input.suggestionId,
      input.expectedVersion,
      input.reviewerPrincipalId,
      input.decision,
      input.reason,
      input.now,
    );
    return this.store.compareAndSwap(input.workspaceId, input.suggestionId, input.expectedVersion, next);
  }

  async preparedCommand(workspaceId: string, suggestionId: string) {
    const existing = await this.store.get(workspaceId, suggestionId);
    if (!existing) throw new CustomerWorkOsAiError("NOT_FOUND", `suggestion not found: ${suggestionId}`);
    const service = new CustomerWorkOsAiService();
    service.hydrate([existing]);
    return service.preparedCommand(workspaceId, suggestionId);
  }

  get(workspaceId: string, suggestionId: string): Promise<AiSuggestion | undefined> {
    return this.store.get(workspaceId, suggestionId);
  }

  list(workspaceId: string, status?: AiSuggestion["status"]): Promise<AiSuggestion[]> {
    return this.store.list(workspaceId, status);
  }
}

export async function createPgAiSuggestionStoreFromEnvironment(): Promise<PgAiSuggestionStore | undefined> {
  const connectionString = process.env.CWOS_DATABASE_URL ?? process.env.AI_CRM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) return undefined;
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;
  const module = await dynamicImport("pg");
  const Pool = module.Pool as new (options: { connectionString: string; max: number; application_name: string }) => SqlPool;
  if (!Pool) throw new CustomerWorkOsAiError("PG_DRIVER_UNAVAILABLE", "pg Pool export is unavailable");
  const max = Number(process.env.CWOS_AI_PG_POOL_MAX ?? 3);
  if (!Number.isInteger(max) || max < 1 || max > 20) throw new CustomerWorkOsAiError("INVALID_CONFIG", "CWOS_AI_PG_POOL_MAX must be 1..20");
  return new PgAiSuggestionStore(new Pool({ connectionString, max, application_name: "ai-crm-cwos-ai" }));
}
