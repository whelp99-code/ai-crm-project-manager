import { randomUUID } from "node:crypto";
import { CustomerWorkOsError, type ApprovalReceipt } from "@ai-crm/domain/customer-work-os";
import {
  canDecideCustomerWorkOsControl,
  customerWorkOsControlPolicy,
  type CustomerWorkOsControlledAction,
} from "./customer-work-os-policy.js";
import type { GovernanceApprovalResolver } from "./customer-work-os-runtime.js";

export interface CustomerWorkOsControl {
  id: string;
  workspaceId: string;
  action: CustomerWorkOsControlledAction;
  resourceType: ApprovalReceipt["resourceType"];
  resourceId: string;
  resourceVersion: number;
  payloadHash: string;
  policyVersion: number;
  requesterPrincipalId: string;
  requiredRoles: string[];
  status: "REQUESTED" | "CONSUMED" | "REJECTED" | "EXPIRED";
  requestReason: string;
  requestHash: string;
  requestIdempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  decidedByPrincipalId?: string;
  decisionReason?: string;
}

export interface ControlRequester {
  workspaceId: string;
  requesterPrincipalId: string;
  idempotencyKey: string;
  action: CustomerWorkOsControlledAction;
  resourceType: ApprovalReceipt["resourceType"];
  resourceId: string;
  resourceVersion: number;
  payloadHash: string;
  reason: string;
  requestHash: string;
}

export interface ControlDecision {
  workspaceId: string;
  controlId: string;
  approverPrincipalId: string;
  idempotencyKey: string;
  decision: "APPROVE" | "REJECT";
  reason: string;
}

export interface CustomerWorkOsControlService extends GovernanceApprovalResolver {
  request(input: ControlRequester): Promise<CustomerWorkOsControl>;
  decide(input: ControlDecision): Promise<CustomerWorkOsControl>;
  get(workspaceId: string, controlId: string): Promise<CustomerWorkOsControl>;
  close?(): Promise<void>;
}

export interface PrincipalIdentity {
  id: string;
  workspaceId: string;
  kind: "HUMAN" | "AI" | "SERVICE";
  role: string;
  active: boolean;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new CustomerWorkOsError("INVALID_INPUT", `${name} is required`);
  return normalized;
}

function controlRequestHash(input: Omit<ControlRequester, "requestHash">): string {
  return JSON.stringify({
    action: input.action,
    idempotencyKey: input.idempotencyKey,
    payloadHash: input.payloadHash,
    reason: input.reason,
    requesterPrincipalId: input.requesterPrincipalId,
    resourceId: input.resourceId,
    resourceType: input.resourceType,
    resourceVersion: input.resourceVersion,
    workspaceId: input.workspaceId,
  });
}

export class InMemoryCustomerWorkOsControlService implements CustomerWorkOsControlService {
  private readonly controls = new Map<string, CustomerWorkOsControl>();
  private readonly requestKeys = new Map<string, string>();
  private readonly decisionKeys = new Map<string, string>();

  constructor(
    private readonly principals: ReadonlyMap<string, PrincipalIdentity>,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async request(input: ControlRequester): Promise<CustomerWorkOsControl> {
    const { requestHash: _requestHash, ...requestFields } = input;
    const expectedHash = controlRequestHash(requestFields);
    if (input.requestHash !== expectedHash) throw new CustomerWorkOsError("REQUEST_HASH_MISMATCH", "control request hash does not match request fields");
    const policy = customerWorkOsControlPolicy(input.action);
    const requester = this.principals.get(input.requesterPrincipalId);
    if (!requester || !requester.active || requester.workspaceId !== input.workspaceId) throw new CustomerWorkOsError("PRINCIPAL_NOT_FOUND", "requester principal is inactive or missing");
    const key = `${input.workspaceId}\u0000${required(input.idempotencyKey, "idempotencyKey")}`;
    const existingId = this.requestKeys.get(key);
    if (existingId) {
      const existing = this.controls.get(existingId)!;
      if (existing.requestHash !== input.requestHash) throw new CustomerWorkOsError("IDEMPOTENCY_KEY_CONFLICT", "control request idempotency key has a different payload");
      return copy(existing);
    }
    const createdAt = this.now();
    const expiresAt = new Date(new Date(createdAt).getTime() + policy.expiresMinutes * 60_000).toISOString();
    const control: CustomerWorkOsControl = {
      id: `cwos-control-${randomUUID()}`,
      workspaceId: input.workspaceId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: required(input.resourceId, "resourceId"),
      resourceVersion: input.resourceVersion,
      payloadHash: required(input.payloadHash, "payloadHash"),
      policyVersion: 1,
      requesterPrincipalId: input.requesterPrincipalId,
      requiredRoles: policy.requiredRoles,
      status: "REQUESTED",
      requestReason: required(input.reason, "reason"),
      requestHash: input.requestHash,
      requestIdempotencyKey: input.idempotencyKey,
      createdAt,
      updatedAt: createdAt,
      expiresAt,
    };
    this.controls.set(control.id, control);
    this.requestKeys.set(key, control.id);
    return copy(control);
  }

  async decide(input: ControlDecision): Promise<CustomerWorkOsControl> {
    const key = `${input.workspaceId}\u0000${required(input.idempotencyKey, "idempotencyKey")}`;
    const priorControlId = this.decisionKeys.get(key);
    if (priorControlId) {
      if (priorControlId !== input.controlId) throw new CustomerWorkOsError("IDEMPOTENCY_KEY_CONFLICT", "decision key was used for another control");
      return this.get(input.workspaceId, input.controlId);
    }
    const control = await this.getMutable(input.workspaceId, input.controlId);
    if (control.status !== "REQUESTED") throw new CustomerWorkOsError("INVALID_STATE", `control is ${control.status}`);
    const approver = this.principals.get(input.approverPrincipalId);
    if (!approver || !approver.active || approver.workspaceId !== input.workspaceId) throw new CustomerWorkOsError("PRINCIPAL_NOT_FOUND", "approver principal is inactive or missing");
    const decisionAt = this.now();
    const evaluation = canDecideCustomerWorkOsControl({
      action: control.action,
      requesterPrincipalId: control.requesterPrincipalId,
      approverPrincipalId: approver.id,
      approverKind: approver.kind,
      approverRole: approver.role,
      requestedAt: control.createdAt,
      decisionAt,
    });
    if (!evaluation.allowed) {
      if (evaluation.code === "APPROVAL_EXPIRED") {
        control.status = "EXPIRED";
        control.updatedAt = decisionAt;
        control.decidedByPrincipalId = approver.id;
        control.decisionReason = evaluation.reason;
        this.decisionKeys.set(key, control.id);
        return copy(control);
      }
      throw new CustomerWorkOsError(evaluation.code, evaluation.reason);
    }
    control.status = input.decision === "APPROVE" ? "CONSUMED" : "REJECTED";
    control.decidedByPrincipalId = approver.id;
    control.decisionReason = required(input.reason, "decision reason");
    control.updatedAt = decisionAt;
    this.decisionKeys.set(key, control.id);
    return copy(control);
  }

  async get(workspaceId: string, controlId: string): Promise<CustomerWorkOsControl> {
    return copy(await this.getMutable(workspaceId, controlId));
  }

  async resolve(input: {
    workspaceId: string;
    approvalId: string;
    resourceType: ApprovalReceipt["resourceType"];
    resourceId: string;
    resourceVersion: number;
    action: string;
    payloadHash: string;
  }): Promise<ApprovalReceipt> {
    const control = await this.get(input.workspaceId, input.approvalId);
    if (
      control.status !== "CONSUMED" ||
      control.resourceType !== input.resourceType ||
      control.resourceId !== input.resourceId ||
      control.resourceVersion !== input.resourceVersion ||
      control.action !== input.action ||
      control.payloadHash !== input.payloadHash ||
      !control.decidedByPrincipalId
    ) throw new CustomerWorkOsError("STALE_APPROVAL", "control is not consumed or does not match the current payload");
    return {
      id: control.id,
      workspaceId: control.workspaceId,
      resourceType: control.resourceType,
      resourceId: control.resourceId,
      resourceVersion: control.resourceVersion,
      action: control.action,
      payloadHash: control.payloadHash,
      status: "CONSUMED",
      approvedByPrincipalId: control.decidedByPrincipalId,
    };
  }

  private async getMutable(workspaceId: string, controlId: string): Promise<CustomerWorkOsControl> {
    const control = this.controls.get(controlId);
    if (!control) throw new CustomerWorkOsError("APPROVAL_NOT_FOUND", `control not found: ${controlId}`);
    if (control.workspaceId !== workspaceId) throw new CustomerWorkOsError("CROSS_WORKSPACE", "control belongs to another workspace");
    return control;
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

interface ControlRow {
  id: string;
  workspace_id: string;
  action_type: CustomerWorkOsControlledAction;
  resource_type: ApprovalReceipt["resourceType"] | null;
  resource_id: string;
  resource_version: number;
  payload_hash: string;
  policy_version: number;
  requester_principal_id: string;
  required_roles: string[] | null;
  status: string;
  request_reason: string | null;
  request_hash: string | null;
  request_idempotency_key: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string | null;
  decided_by_principal_id: string | null;
  decision_reason: string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function rowToControl(row: ControlRow): CustomerWorkOsControl {
  if (!row.resource_type || !row.required_roles || !row.request_reason || !row.request_hash || !row.request_idempotency_key || !row.expires_at) {
    throw new CustomerWorkOsError("INVALID_CONTROL", "control metadata is incomplete");
  }
  const status = row.status as CustomerWorkOsControl["status"];
  if (!["REQUESTED", "CONSUMED", "REJECTED", "EXPIRED"].includes(status)) throw new CustomerWorkOsError("INVALID_CONTROL", `unsupported control status: ${row.status}`);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    action: row.action_type,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    resourceVersion: row.resource_version,
    payloadHash: row.payload_hash,
    policyVersion: row.policy_version,
    requesterPrincipalId: row.requester_principal_id,
    requiredRoles: row.required_roles,
    status,
    requestReason: row.request_reason,
    requestHash: row.request_hash,
    requestIdempotencyKey: row.request_idempotency_key,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    expiresAt: iso(row.expires_at),
    ...(row.decided_by_principal_id ? { decidedByPrincipalId: row.decided_by_principal_id } : {}),
    ...(row.decision_reason ? { decisionReason: row.decision_reason } : {}),
  };
}

const CONTROL_COLUMNS = `id, workspace_id, action_type, resource_type, resource_id,
  resource_version, payload_hash, policy_version, requester_principal_id,
  required_roles, status, request_reason, request_hash, request_idempotency_key,
  created_at, updated_at, expires_at, decided_by_principal_id, decision_reason`;

export class PgCustomerWorkOsControlService implements CustomerWorkOsControlService {
  constructor(private readonly pool: SqlPool, private readonly now: () => string = () => new Date().toISOString()) {}

  async request(input: ControlRequester): Promise<CustomerWorkOsControl> {
    const { requestHash: _requestHash, ...requestFields } = input;
    const expectedHash = controlRequestHash(requestFields);
    if (input.requestHash !== expectedHash) throw new CustomerWorkOsError("REQUEST_HASH_MISMATCH", "control request hash does not match request fields");
    const policy = customerWorkOsControlPolicy(input.action);
    const createdAt = this.now();
    const expiresAt = new Date(new Date(createdAt).getTime() + policy.expiresMinutes * 60_000).toISOString();
    const controlId = `cwos-control-${randomUUID()}`;
    return withWorkspace(this.pool, input.workspaceId, async (connection) => {
      const principal = await connection.query<{ id: string; is_active: boolean }>(
        `SELECT id::text AS id, is_active FROM principals WHERE workspace_id = $1 AND id::text = $2`,
        [input.workspaceId, input.requesterPrincipalId],
      );
      if (!principal.rows[0]?.is_active) throw new CustomerWorkOsError("PRINCIPAL_NOT_FOUND", "requester principal is inactive or missing");
      const existing = await connection.query<ControlRow>(
        `SELECT ${CONTROL_COLUMNS} FROM orch_governance_controls
          WHERE workspace_id = $1 AND request_idempotency_key = $2`,
        [input.workspaceId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        const control = rowToControl(existing.rows[0]);
        if (control.requestHash !== input.requestHash) throw new CustomerWorkOsError("IDEMPOTENCY_KEY_CONFLICT", "control request idempotency key has a different payload");
        return control;
      }
      const inserted = await connection.query<ControlRow>(
        `INSERT INTO orch_governance_controls
          (id, workspace_id, action_type, kind, resource_type, resource_id,
           resource_version, payload_hash, policy_version, requester_principal_id,
           required_roles, status, request_reason, request_hash,
           request_idempotency_key, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'APPROVAL', $4, $5, $6, $7, 1, $8,
                 $9::jsonb, 'REQUESTED', $10, $11, $12, $13::timestamptz,
                 $14::timestamptz, $14::timestamptz)
         RETURNING ${CONTROL_COLUMNS}`,
        [controlId, input.workspaceId, input.action, input.resourceType, input.resourceId,
         input.resourceVersion, input.payloadHash, input.requesterPrincipalId,
         JSON.stringify(policy.requiredRoles), input.reason, input.requestHash,
         input.idempotencyKey, expiresAt, createdAt],
      );
      const row = inserted.rows[0];
      if (!row) throw new CustomerWorkOsError("CONTROL_WRITE_FAILED", "approval control was not inserted");
      await connection.query(
        `INSERT INTO cwos_control_decision_events
          (workspace_id, control_id, event_type, actor_principal_id, reason,
           idempotency_key, payload_hash, occurred_at)
         VALUES ($1, $2, 'REQUESTED', $3, $4, $5, $6, $7::timestamptz)`,
        [input.workspaceId, controlId, input.requesterPrincipalId, input.reason,
         input.idempotencyKey, input.payloadHash, createdAt],
      );
      return rowToControl(row);
    });
  }

  async decide(input: ControlDecision): Promise<CustomerWorkOsControl> {
    const decisionAt = this.now();
    return withWorkspace(this.pool, input.workspaceId, async (connection) => {
      const replay = await connection.query<{ control_id: string }>(
        `SELECT control_id FROM cwos_control_decision_events
          WHERE workspace_id = $1 AND idempotency_key = $2`,
        [input.workspaceId, input.idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].control_id !== input.controlId) throw new CustomerWorkOsError("IDEMPOTENCY_KEY_CONFLICT", "decision key was used for another control");
        return this.getWithConnection(connection, input.workspaceId, input.controlId, false);
      }
      const control = await this.getWithConnection(connection, input.workspaceId, input.controlId, true);
      if (control.status !== "REQUESTED") throw new CustomerWorkOsError("INVALID_STATE", `control is ${control.status}`);
      const principal = await connection.query<{ id: string; kind: PrincipalIdentity["kind"]; role: string; is_active: boolean }>(
        `SELECT id::text AS id, kind, role, is_active FROM principals
          WHERE workspace_id = $1 AND id::text = $2`,
        [input.workspaceId, input.approverPrincipalId],
      );
      const approver = principal.rows[0];
      if (!approver?.is_active) throw new CustomerWorkOsError("PRINCIPAL_NOT_FOUND", "approver principal is inactive or missing");
      const evaluation = canDecideCustomerWorkOsControl({
        action: control.action,
        requesterPrincipalId: control.requesterPrincipalId,
        approverPrincipalId: approver.id,
        approverKind: approver.kind,
        approverRole: approver.role,
        requestedAt: control.createdAt,
        decisionAt,
      });
      if (!evaluation.allowed) {
        if (evaluation.code === "APPROVAL_EXPIRED") {
          const updated = await connection.query<ControlRow>(
            `UPDATE orch_governance_controls
                SET status = 'EXPIRED', decided_by_principal_id = $3,
                    decision_reason = $4, updated_at = $5::timestamptz
              WHERE workspace_id = $1 AND id = $2 AND status = 'REQUESTED'
              RETURNING ${CONTROL_COLUMNS}`,
            [input.workspaceId, input.controlId, approver.id, evaluation.reason, decisionAt],
          );
          const row = updated.rows[0];
          if (!row) throw new CustomerWorkOsError("CONCURRENT_MODIFICATION", "control was decided concurrently");
          await connection.query(
            `INSERT INTO cwos_control_decision_events
              (workspace_id, control_id, event_type, actor_principal_id, reason,
               idempotency_key, payload_hash, occurred_at)
             VALUES ($1, $2, 'EXPIRED', $3, $4, $5, $6, $7::timestamptz)`,
            [input.workspaceId, input.controlId, approver.id, evaluation.reason,
             input.idempotencyKey, control.payloadHash, decisionAt],
          );
          return rowToControl(row);
        }
        throw new CustomerWorkOsError(evaluation.code, evaluation.reason);
      }
      const nextStatus = input.decision === "APPROVE" ? "CONSUMED" : "REJECTED";
      const updated = await connection.query<ControlRow>(
        `UPDATE orch_governance_controls
            SET status = $3, decided_by_principal_id = $4,
                decision_reason = $5, updated_at = $6::timestamptz
          WHERE workspace_id = $1 AND id = $2 AND status = 'REQUESTED'
          RETURNING ${CONTROL_COLUMNS}`,
        [input.workspaceId, input.controlId, nextStatus, approver.id,
         required(input.reason, "decision reason"), decisionAt],
      );
      const row = updated.rows[0];
      if (!row) throw new CustomerWorkOsError("CONCURRENT_MODIFICATION", "control was decided concurrently");
      await connection.query(
        `INSERT INTO cwos_control_decision_events
          (workspace_id, control_id, event_type, actor_principal_id, reason,
           idempotency_key, payload_hash, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
        [input.workspaceId, input.controlId, input.decision === "APPROVE" ? "APPROVED" : "REJECTED",
         approver.id, input.reason, input.idempotencyKey, control.payloadHash, decisionAt],
      );
      return rowToControl(row);
    });
  }

  async get(workspaceId: string, controlId: string): Promise<CustomerWorkOsControl> {
    return withWorkspace(this.pool, workspaceId, (connection) => this.getWithConnection(connection, workspaceId, controlId, false));
  }

  async resolve(input: {
    workspaceId: string;
    approvalId: string;
    resourceType: ApprovalReceipt["resourceType"];
    resourceId: string;
    resourceVersion: number;
    action: string;
    payloadHash: string;
  }): Promise<ApprovalReceipt> {
    const control = await this.get(input.workspaceId, input.approvalId);
    if (
      control.status !== "CONSUMED" || control.resourceType !== input.resourceType ||
      control.resourceId !== input.resourceId || control.resourceVersion !== input.resourceVersion ||
      control.action !== input.action || control.payloadHash !== input.payloadHash ||
      !control.decidedByPrincipalId
    ) throw new CustomerWorkOsError("STALE_APPROVAL", "control does not match current action payload");
    return {
      id: control.id,
      workspaceId: control.workspaceId,
      resourceType: control.resourceType,
      resourceId: control.resourceId,
      resourceVersion: control.resourceVersion,
      action: control.action,
      payloadHash: control.payloadHash,
      status: "CONSUMED",
      approvedByPrincipalId: control.decidedByPrincipalId,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async getWithConnection(connection: SqlConnection, workspaceId: string, controlId: string, lock: boolean): Promise<CustomerWorkOsControl> {
    const result = await connection.query<ControlRow>(
      `SELECT ${CONTROL_COLUMNS} FROM orch_governance_controls
        WHERE workspace_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
      [workspaceId, controlId],
    );
    const row = result.rows[0];
    if (!row) throw new CustomerWorkOsError("APPROVAL_NOT_FOUND", `control not found: ${controlId}`);
    return rowToControl(row);
  }
}

export async function createPgCustomerWorkOsControlServiceFromEnvironment(): Promise<PgCustomerWorkOsControlService | undefined> {
  const connectionString = process.env.CWOS_DATABASE_URL ?? process.env.AI_CRM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) return undefined;
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;
  const module = await dynamicImport("pg");
  const Pool = module.Pool as new (options: { connectionString: string; max: number; application_name: string }) => SqlPool;
  if (!Pool) throw new CustomerWorkOsError("PG_DRIVER_UNAVAILABLE", "pg Pool export is unavailable");
  const max = Number(process.env.CWOS_CONTROL_PG_POOL_MAX ?? 3);
  if (!Number.isInteger(max) || max < 1 || max > 20) throw new CustomerWorkOsError("INVALID_CONFIG", "CWOS_CONTROL_PG_POOL_MAX must be 1..20");
  return new PgCustomerWorkOsControlService(new Pool({ connectionString, max, application_name: "ai-crm-cwos-controls" }));
}

export function buildCustomerWorkOsControlRequestHash(input: Omit<ControlRequester, "requestHash">): string {
  return controlRequestHash(input);
}
