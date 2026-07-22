import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  auditChainHeads,
  auditEvents,
  controlClaims,
  controlRequests,
  executionIntents,
  importBatches,
  importRows,
  modelInvocations,
  notifications,
  orchGovernanceControls,
  orchGovernanceIntents,
  orchJobEvents,
  orchJobs,
  orchWorkItems,
  outboxEvents,
  policyDecisions,
  principals,
  reportSnapshots,
  users,
  workspaces,
} from "../src/schema.js";

/**
 * These tests never connect to PostgreSQL. They assert two independent
 * things: (1) the exported Drizzle table contracts have the columns the
 * foundation design requires (workspace binding, lease fencing, immutable
 * audit sequencing), and (2) the raw migration SQL text actually contains
 * the role/RLS/audit/lease invariants it claims to — so a future edit that
 * silently drops `FORCE ROW LEVEL SECURITY` or an append-only trigger fails
 * this suite even though nothing here can execute the SQL.
 */

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(currentDir, "../migrations/0001_foundation.sql"),
  "utf8",
);
const modelGatewayMigrationSql = readFileSync(
  join(currentDir, "../migrations/0002_model_gateway_and_break_glass_roles.sql"),
  "utf8",
);
const orchestrationMigrationSql = readFileSync(
  join(currentDir, "../migrations/0003_orchestration.sql"),
  "utf8",
);
const governanceSnapshotMigrationSql = readFileSync(
  join(currentDir, "../migrations/0004_governance_snapshot.sql"),
  "utf8",
);


/** Tables declared and FORCE-RLS'd in 0001_foundation.sql. */
const FOUNDATION_WORKSPACE_BOUND_TABLES = [
  users,
  principals,
  policyDecisions,
  controlRequests,
  controlClaims,
  executionIntents,
  auditChainHeads,
  auditEvents,
  outboxEvents,
  notifications,
  importBatches,
  importRows,
  modelInvocations,
] as const;

/** Tables declared and FORCE-RLS'd in 0003_orchestration.sql. */
const ORCH_WORKSPACE_BOUND_TABLES = [orchJobs, orchWorkItems, orchJobEvents] as const;

/** Tables declared and FORCE-RLS'd in 0004_governance_snapshot.sql. */
const GOVERNANCE_SNAPSHOT_WORKSPACE_BOUND_TABLES = [
  orchGovernanceControls,
  orchGovernanceIntents,
] as const;

/** Tables declared and FORCE-RLS'd in 0011_reports_model_invocations.sql. */
const REPORTS_MODEL_INVOCATIONS_WORKSPACE_BOUND_TABLES = [reportSnapshots] as const;

const WORKSPACE_BOUND_TABLES = [
  ...FOUNDATION_WORKSPACE_BOUND_TABLES,
  ...ORCH_WORKSPACE_BOUND_TABLES,
  ...GOVERNANCE_SNAPSHOT_WORKSPACE_BOUND_TABLES,
  ...REPORTS_MODEL_INVOCATIONS_WORKSPACE_BOUND_TABLES,
] as const;

const FOUNDATION_WORKSPACE_BOUND_TABLE_NAMES = FOUNDATION_WORKSPACE_BOUND_TABLES.map((table) =>
  getTableName(table),
);
const ORCH_WORKSPACE_BOUND_TABLE_NAMES = ORCH_WORKSPACE_BOUND_TABLES.map((table) => getTableName(table));
const GOVERNANCE_SNAPSHOT_WORKSPACE_BOUND_TABLE_NAMES = GOVERNANCE_SNAPSHOT_WORKSPACE_BOUND_TABLES.map(
  (table) => getTableName(table),
);
const WORKSPACE_BOUND_TABLE_NAMES = WORKSPACE_BOUND_TABLES.map((table) => getTableName(table));

describe("table contracts", () => {
  it("workspaces is the tenant boundary root with no workspace_id column", () => {
    expect(getTableName(workspaces)).toBe("workspaces");
    expect(Object.keys(getTableColumns(workspaces))).not.toContain("workspaceId");
  });

  it.each(WORKSPACE_BOUND_TABLES.map((table) => [getTableName(table), table] as const))(
    "%s declares a not-null workspace_id column",
    (_name, table) => {
      const columns = getTableColumns(table);
      expect(columns.workspaceId).toBeDefined();
      expect(columns.workspaceId.notNull).toBe(true);
      expect(columns.workspaceId.name).toBe("workspace_id");
    },
  );

  it("execution_intents exposes immutable binding columns and lease fencing columns", () => {
    const columns = getTableColumns(executionIntents);
    for (const bindingColumn of [
      "idempotencyKey",
      "actionType",
      "payloadHash",
      "canonicalSchemaVersion",
      "controlClaimId",
    ]) {
      expect(columns[bindingColumn as keyof typeof columns]).toBeDefined();
    }
    for (const leaseColumn of ["leaseDeadline", "leaseEpoch", "leaseToken"]) {
      expect(columns[leaseColumn as keyof typeof columns]).toBeDefined();
    }
    expect(columns.leaseEpoch.notNull).toBe(true);
    expect(columns.state.notNull).toBe(true);
  });

  it("audit_events carries a sequence column distinct from its primary key id", () => {
    const columns = getTableColumns(auditEvents);
    expect(columns.sequence).toBeDefined();
    expect(columns.sequence.notNull).toBe(true);
    expect(columns.id.primary).toBe(true);
    expect(columns.eventHash.notNull).toBe(true);
  });

  it("audit_chain_heads is keyed by workspace_id and tracks a head sequence", () => {
    const columns = getTableColumns(auditChainHeads);
    expect(columns.workspaceId.primary).toBe(true);
    expect(columns.headSequence).toBeDefined();
  });

  it("model_invocations and import tables are workspace-bound with no gaps", () => {
    expect(WORKSPACE_BOUND_TABLE_NAMES).toEqual(
      expect.arrayContaining([
        "model_invocations",
        "import_batches",
        "import_rows",
        "notifications",
        "outbox_events",
        "report_snapshots",
      ]),
    );
  });
});

describe("migration SQL: roles", () => {
  it("creates a distinct migration/owner role separate from runtime roles", () => {
    expect(migrationSql).toMatch(/CREATE ROLE ai_crm_migration_owner\b.*NOLOGIN/s);
  });

  it("creates runtime roles that are explicitly non-owner and NOBYPASSRLS", () => {
    for (const role of ["ai_crm_runtime_api", "ai_crm_runtime_worker", "ai_crm_audit_verifier"]) {
      const createStatement = new RegExp(`CREATE ROLE ${role}\\b[^;]*;`, "s");
      const match = migrationSql.match(createStatement);
      expect(match, `expected a CREATE ROLE statement for ${role}`).not.toBeNull();
      expect(match?.[0]).toMatch(/NOBYPASSRLS/);
      expect(match?.[0]).not.toMatch(/\bSUPERUSER\b/);
    }
  });

  it("makes the migration owner the owner of every foundation workspace-bound table", () => {
    for (const tableName of [...FOUNDATION_WORKSPACE_BOUND_TABLE_NAMES, "workspaces"]) {
      expect(migrationSql).toMatch(
        new RegExp(`ALTER TABLE ${tableName}\\s+OWNER TO ai_crm_migration_owner;`),
      );
    }
  });

  it("never grants runtime roles ownership or table creation on public schema", () => {
    expect(migrationSql).not.toMatch(/ALTER TABLE \w+\s+OWNER TO ai_crm_runtime_(api|worker)/);
    expect(migrationSql).not.toMatch(/GRANT CREATE ON SCHEMA public TO ai_crm_runtime/);
  });
});

describe("migration SQL: guarded workspace setting", () => {
  it("defines a workspace accessor function that fails closed on missing context", () => {
    expect(migrationSql).toMatch(/CREATE OR REPLACE FUNCTION app_current_workspace_id\(\)/);
    expect(migrationSql).toMatch(/current_setting\('app\.workspace_id', true\)/);
    expect(migrationSql).toMatch(/RAISE EXCEPTION 'app\.workspace_id is not set/);
    expect(migrationSql).toMatch(/RAISE EXCEPTION 'app\.workspace_id is malformed/);
  });
});

describe("migration SQL: row level security", () => {
  it("enables and forces RLS on exactly every foundation workspace-bound table", () => {
    const tableArray = migrationSql.match(
      /FOREACH workspace_bound_table IN ARRAY ARRAY\[([\s\S]*?)\]\s*LOOP/,
    )?.[1];
    expect(tableArray).toBeDefined();
    const listedTables = [...(tableArray?.matchAll(/'([^']+)'/g) ?? [])]
      .map((match) => match[1])
      .sort();
    expect(listedTables).toEqual([...FOUNDATION_WORKSPACE_BOUND_TABLE_NAMES].sort());
    expect(migrationSql).toMatch(/ALTER TABLE %I ENABLE ROW LEVEL SECURITY/);
    expect(migrationSql).toMatch(/ALTER TABLE %I FORCE ROW LEVEL SECURITY/);
  });

  it("defines both USING and WITH CHECK on the workspace isolation policy", () => {
    expect(migrationSql).toMatch(
      /CREATE POLICY workspace_isolation ON %I USING \(workspace_id = app_current_workspace_id\(\)\) WITH CHECK \(workspace_id = app_current_workspace_id\(\)\)/,
    );
  });

  it("never leaves a table with ENABLE but not FORCE row level security", () => {
    const executableSql = migrationSql.replace(/--.*$/gm, "");
    const enableCount = (executableSql.match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length;
    const forceCount = (executableSql.match(/FORCE ROW LEVEL SECURITY/g) ?? []).length;
    expect(forceCount).toBeGreaterThan(0);
    expect(forceCount).toBe(enableCount);
  });
});

describe("migration SQL: append-only audit protections", () => {
  it("rejects UPDATE and DELETE on audit_events via a BEFORE trigger", () => {
    expect(migrationSql).toMatch(
      /CREATE TRIGGER audit_events_append_only\s+BEFORE UPDATE OR DELETE ON audit_events/,
    );
    expect(migrationSql).toMatch(/audit_events is append-only/);
  });

  it("revokes UPDATE/DELETE grants on audit_events from every runtime role and PUBLIC", () => {
    expect(migrationSql).toMatch(
      /REVOKE UPDATE, DELETE ON audit_events FROM ai_crm_runtime_api, ai_crm_runtime_worker, ai_crm_audit_verifier, PUBLIC;/,
    );
  });

  it("never grants UPDATE or DELETE on audit_events to a runtime role", () => {
    expect(migrationSql).not.toMatch(/GRANT[^;]*UPDATE[^;]*ON[^;]*audit_events[^;]*TO ai_crm_runtime/);
    expect(migrationSql).not.toMatch(/GRANT[^;]*DELETE[^;]*ON[^;]*audit_events/);
  });

  it("enforces a monotonically increasing audit_chain_heads sequence and blocks deletes", () => {
    expect(migrationSql).toMatch(
      /CREATE TRIGGER audit_chain_heads_no_delete\s+BEFORE DELETE ON audit_chain_heads/,
    );
    expect(migrationSql).toMatch(/head_sequence must strictly increase/);
  });

  it("grants the worker the state transitions needed for outbox publication", () => {
    expect(migrationSql).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON outbox_events, audit_chain_heads TO ai_crm_runtime_worker;/,
    );
  });

  it("allows API and worker appenders to initialize a workspace chain head", () => {
    expect(migrationSql).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON audit_chain_heads TO ai_crm_runtime_api;/,
    );
    expect(migrationSql).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON outbox_events, audit_chain_heads TO ai_crm_runtime_worker;/,
    );
  });
});

describe("migration SQL: intent lease fencing and idempotency", () => {
  it("declares lease_deadline, lease_epoch and lease_token columns on execution_intents", () => {
    expect(migrationSql).toMatch(/lease_deadline\s+timestamptz/);
    expect(migrationSql).toMatch(/lease_epoch\s+integer NOT NULL DEFAULT 0/);
    expect(migrationSql).toMatch(/lease_token\s+text/);
  });

  it("requires lease columns to be present whenever state is LEASED or DISPATCHING", () => {
    expect(migrationSql).toMatch(/execution_intents_lease_columns_present CHECK/);
    expect(migrationSql).toMatch(/state NOT IN \('LEASED', 'DISPATCHING'\)/);
  });

  it("enforces immutable binding fields via a BEFORE UPDATE trigger", () => {
    expect(migrationSql).toMatch(
      /CREATE TRIGGER execution_intents_immutable_binding\s+BEFORE UPDATE ON execution_intents/,
    );
    expect(migrationSql).toMatch(/binding fields \(workspace_id, control_claim_id, idempotency_key, action_type, payload_hash, canonical_schema_version\) are immutable/);
  });

  it("enforces a unique idempotency key per workspace on execution_intents", () => {
    expect(migrationSql).toMatch(
      /execution_intents_workspace_idempotency_key UNIQUE \(workspace_id, idempotency_key\)/,
    );
  });

  it("enforces unique (workspace_id, sequence) pairs on audit_events", () => {
    expect(migrationSql).toMatch(
      /audit_events_workspace_sequence_key UNIQUE \(workspace_id, sequence\)/,
    );
  });
});

describe("migration SQL: fail-closed workspace context", () => {
  it("every workspace isolation policy references the guarded accessor, not a raw current_setting", () => {
    const rawSettingInPolicy = /CREATE POLICY[\s\S]*?current_setting\('app\.workspace_id'/;
    expect(migrationSql).not.toMatch(rawSettingInPolicy);
  });
});

describe("migration SQL 0002: model-gateway and break-glass roles", () => {
  it("creates the model-gateway role with LOGIN, NOINHERIT and never BYPASSRLS", () => {
    const createStatement = modelGatewayMigrationSql.match(
      /CREATE ROLE ai_crm_runtime_model_gateway\b[^;]*;/s,
    );
    expect(createStatement, "expected a CREATE ROLE statement for ai_crm_runtime_model_gateway").not.toBeNull();
    expect(createStatement?.[0]).toMatch(/\bLOGIN\b/);
    expect(createStatement?.[0]).toMatch(/\bNOINHERIT\b/);
    expect(createStatement?.[0]).toMatch(/\bNOBYPASSRLS\b/);
    expect(createStatement?.[0]).not.toMatch(/(?<!NO)BYPASSRLS\b(?<!NOBYPASSRLS)/);
  });

  it("creates the break-glass role with NOLOGIN and never BYPASSRLS", () => {
    const createStatement = modelGatewayMigrationSql.match(
      /CREATE ROLE ai_crm_break_glass_admin\b[^;]*;/s,
    );
    expect(createStatement, "expected a CREATE ROLE statement for ai_crm_break_glass_admin").not.toBeNull();
    expect(createStatement?.[0]).toMatch(/\bNOLOGIN\b/);
    expect(createStatement?.[0]).not.toMatch(/\bLOGIN\b/);
    expect(createStatement?.[0]).toMatch(/\bNOBYPASSRLS\b/);
  });

  it("revokes model_invocations SELECT and INSERT access from the API and worker roles", () => {
    expect(modelGatewayMigrationSql).toMatch(
      /REVOKE SELECT, INSERT ON model_invocations FROM ai_crm_runtime_api, ai_crm_runtime_worker;/,
    );
  });

  it("grants model_invocations write access to the model-gateway role only", () => {
    expect(modelGatewayMigrationSql).toMatch(
      /GRANT SELECT, INSERT ON model_invocations TO ai_crm_runtime_model_gateway;/,
    );
    expect(modelGatewayMigrationSql).not.toMatch(
      /GRANT[^;]*(INSERT|ALL|UPDATE|DELETE)[^;]*ON[^;]*model_invocations[^;]*TO ai_crm_runtime_(api|worker)/,
    );
  });

  it("never contains a bare BYPASSRLS grant outside NOBYPASSRLS", () => {
    const bareBypass = modelGatewayMigrationSql.match(/(?<!NO)BYPASSRLS/g) ?? [];
    expect(bareBypass).toEqual([]);
  });

  it("grants no table ownership to any role", () => {
    expect(modelGatewayMigrationSql).not.toMatch(/OWNER TO/);
  });
});
describe("migration SQL: all migrations (globbed negative invariants)", () => {
  // Every migration file is globbed here (not just 0001/0002 individually) so a
  // future migration that silently re-introduces a forbidden pattern fails this
  // suite even though nobody updated this file's list of imports.
  const migrationsDir = join(currentDir, "../migrations");
  const migrationFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const migrations = migrationFiles.map((file) => ({
    file,
    sql: readFileSync(join(migrationsDir, file), "utf8"),
  }));

  it("finds at least one migration file to check (sanity guard against a vacuous test)", () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
  });

  it("never contains a bare BYPASSRLS grant outside NOBYPASSRLS, in any migration file", () => {
    for (const { file, sql } of migrations) {
      // Strip line comments so prose like "only an explicit BYPASSRLS role" does not
      // trip the negative invariant; role DDL attributes remain in the executable body.
      const executableSql = sql.replace(/--.*$/gm, "");
      const bareBypass = executableSql.match(/(?<!NO)BYPASSRLS/g) ?? [];
      expect(bareBypass, `unexpected bare BYPASSRLS in ${file}`).toEqual([]);
    }
  });

  it("never grants table ownership to any role other than ai_crm_migration_owner, in any migration file", () => {
    for (const { file, sql } of migrations) {
      const ownerGrants = sql.match(/OWNER TO \w+/g) ?? [];
      for (const grant of ownerGrants) {
        expect(grant, `unexpected non-migration-owner OWNER TO in ${file}`).toBe("OWNER TO ai_crm_migration_owner");
      }
    }
  });

  // 0001_foundation.sql legitimately grants SELECT, INSERT on model_invocations to
  // ai_crm_runtime_api/ai_crm_runtime_worker — that was the original design, since
  // revoked by 0002. A blanket "no migration ever grants this" assertion would be
  // false for 0001 itself, so the real invariant this test protects is narrower and
  // still meaningful: no migration LATER than 0001 (in filename/apply order) ever
  // re-introduces that grant, and the revoke that closes the original grant exists
  // exactly once across the whole migration history.
  it("no migration after 0001_foundation.sql re-grants model_invocations to api/worker, and the revoke happens exactly once", () => {
    const foundationIndex = migrationFiles.findIndex((file) => file.startsWith("0001_"));
    expect(foundationIndex, "expected 0001_foundation.sql to exist").toBeGreaterThanOrEqual(0);
    const laterMigrations = migrations.slice(foundationIndex + 1);
    expect(laterMigrations.length).toBeGreaterThan(0);

    const regrantPattern =
      /GRANT[^;]*(INSERT|ALL|UPDATE|DELETE)[^;]*ON[^;]*model_invocations[^;]*TO ai_crm_runtime_(api|worker)/;
    for (const { file, sql } of laterMigrations) {
      expect(sql, `unexpected model_invocations re-grant to api/worker in ${file}`).not.toMatch(regrantPattern);
    }

    const revokePattern = /REVOKE SELECT, INSERT ON model_invocations FROM ai_crm_runtime_api, ai_crm_runtime_worker;/g;
    const revokeMatches = migrations.flatMap(({ sql }) => sql.match(revokePattern) ?? []);
    expect(revokeMatches.length).toBe(1);
  });
});

describe("table contracts: orchestration spine", () => {
  it.each(ORCH_WORKSPACE_BOUND_TABLES.map((table) => [getTableName(table), table] as const))(
    "%s declares a not-null workspace_id column",
    (_name, table) => {
      const columns = getTableColumns(table);
      expect(columns.workspaceId).toBeDefined();
      expect(columns.workspaceId.notNull).toBe(true);
      expect(columns.workspaceId.name).toBe("workspace_id");
    },
  );

  it("orch_jobs exposes idempotency and principal binding columns", () => {
    const columns = getTableColumns(orchJobs);
    for (const name of [
      "id",
      "workspaceId",
      "source",
      "rawText",
      "planInvocationId",
      "status",
      "createdByPrincipalId",
      "idempotencyKey",
      "createdAt",
      "updatedAt",
    ]) {
      expect(columns[name as keyof typeof columns]).toBeDefined();
    }
    expect(columns.source.notNull).toBe(true);
    expect(columns.status.notNull).toBe(true);
    expect(columns.createdByPrincipalId.notNull).toBe(true);
  });

  it("orch_work_items exposes resource binding, progress and governance refs", () => {
    const columns = getTableColumns(orchWorkItems);
    for (const name of [
      "jobId",
      "sequence",
      "title",
      "status",
      "suggestedCommand",
      "actionType",
      "assignedPrincipalId",
      "controlId",
      "intentId",
      "resourceType",
      "resourceId",
      "resourceVersion",
      "progress",
      "errorCode",
      "resultRef",
    ]) {
      expect(columns[name as keyof typeof columns]).toBeDefined();
    }
    expect(columns.jobId.notNull).toBe(true);
    expect(columns.progress.notNull).toBe(true);
  });

  it("orch_job_events carries kind, payload and at", () => {
    const columns = getTableColumns(orchJobEvents);
    expect(columns.jobId.notNull).toBe(true);
    expect(columns.kind.notNull).toBe(true);
    expect(columns.payload.notNull).toBe(true);
    expect(columns.at.notNull).toBe(true);
  });
});

describe("migration SQL 0003: orchestration FORCE RLS (SEC-05)", () => {
  it("creates orch_jobs, orch_work_items and orch_job_events", () => {
    expect(orchestrationMigrationSql).toMatch(/CREATE TABLE orch_jobs\b/);
    expect(orchestrationMigrationSql).toMatch(/CREATE TABLE orch_work_items\b/);
    expect(orchestrationMigrationSql).toMatch(/CREATE TABLE orch_job_events\b/);
  });

  it("enforces unique (workspace_id, idempotency_key) on orch_jobs", () => {
    expect(orchestrationMigrationSql).toMatch(
      /orch_jobs_workspace_idempotency_key UNIQUE \(workspace_id, idempotency_key\)/,
    );
  });

  it("enforces resource_type/resource_id paired CHECK on orch_work_items", () => {
    expect(orchestrationMigrationSql).toMatch(/orch_work_items_resource_binding_check CHECK/);
    expect(orchestrationMigrationSql).toMatch(
      /\(resource_type IS NULL AND resource_id IS NULL\)\s*OR\s*\(resource_type IS NOT NULL AND resource_id IS NOT NULL\)/,
    );
  });

  it("indexes job workspace, work_items job_id, and events job_id", () => {
    expect(orchestrationMigrationSql).toMatch(/CREATE INDEX orch_jobs_workspace_idx ON orch_jobs \(workspace_id\)/);
    expect(orchestrationMigrationSql).toMatch(/CREATE INDEX orch_work_items_job_id_idx ON orch_work_items \(job_id\)/);
    expect(orchestrationMigrationSql).toMatch(/CREATE INDEX orch_job_events_job_id_idx ON orch_job_events \(job_id\)/);
  });

  it("makes the migration owner the owner of every orch table", () => {
    for (const tableName of ORCH_WORKSPACE_BOUND_TABLE_NAMES) {
      expect(orchestrationMigrationSql).toMatch(
        new RegExp(`ALTER TABLE ${tableName}\\s+OWNER TO ai_crm_migration_owner;`),
      );
    }
  });

  it("enables and forces RLS on exactly the orch workspace-bound tables", () => {
    const tableArray = orchestrationMigrationSql.match(
      /FOREACH workspace_bound_table IN ARRAY ARRAY\[([\s\S]*?)\]\s*LOOP/,
    )?.[1];
    expect(tableArray).toBeDefined();
    const listedTables = [...(tableArray?.matchAll(/'([^']+)'/g) ?? [])]
      .map((match) => match[1])
      .sort();
    expect(listedTables).toEqual([...ORCH_WORKSPACE_BOUND_TABLE_NAMES].sort());
    expect(orchestrationMigrationSql).toMatch(/ALTER TABLE %I ENABLE ROW LEVEL SECURITY/);
    expect(orchestrationMigrationSql).toMatch(/ALTER TABLE %I FORCE ROW LEVEL SECURITY/);
  });

  it("defines both USING and WITH CHECK via app_current_workspace_id()", () => {
    expect(orchestrationMigrationSql).toMatch(
      /CREATE POLICY workspace_isolation ON %I USING \(workspace_id = app_current_workspace_id\(\)\) WITH CHECK \(workspace_id = app_current_workspace_id\(\)\)/,
    );
    expect(orchestrationMigrationSql).toMatch(/app_current_workspace_id\(\)/);
    // Fail-closed: policies must not use raw current_setting.
    const rawSettingInPolicy = /CREATE POLICY[\s\S]*?current_setting\('app\.workspace_id'/;
    expect(orchestrationMigrationSql).not.toMatch(rawSettingInPolicy);
  });

  it("never leaves a table with ENABLE but not FORCE row level security", () => {
    const executableSql = orchestrationMigrationSql.replace(/--.*$/gm, "");
    const enableCount = (executableSql.match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length;
    const forceCount = (executableSql.match(/FORCE ROW LEVEL SECURITY/g) ?? []).length;
    expect(forceCount).toBeGreaterThan(0);
    expect(forceCount).toBe(enableCount);
  });

  it("grants SELECT,INSERT,UPDATE,DELETE to api and worker and SELECT to audit verifier", () => {
    expect(orchestrationMigrationSql).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON\s+orch_jobs, orch_work_items, orch_job_events\s+TO ai_crm_runtime_api;/,
    );
    expect(orchestrationMigrationSql).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON\s+orch_jobs, orch_work_items, orch_job_events\s+TO ai_crm_runtime_worker;/,
    );
    expect(orchestrationMigrationSql).toMatch(
      /GRANT SELECT ON\s+orch_jobs, orch_work_items, orch_job_events\s+TO ai_crm_audit_verifier;/,
    );
  });

  it("never grants ownership to runtime roles", () => {
    expect(orchestrationMigrationSql).not.toMatch(/ALTER TABLE \w+\s+OWNER TO ai_crm_runtime_(api|worker)/);
  });
});

describe("table contracts: governance snapshot", () => {
  it.each(
    GOVERNANCE_SNAPSHOT_WORKSPACE_BOUND_TABLES.map((table) => [getTableName(table), table] as const),
  )("%s declares a not-null workspace_id column", (_name, table) => {
    const columns = getTableColumns(table);
    expect(columns.workspaceId).toBeDefined();
    expect(columns.workspaceId.notNull).toBe(true);
    expect(columns.workspaceId.name).toBe("workspace_id");
  });

  it("orch_governance_controls exposes control binding and decision columns", () => {
    const columns = getTableColumns(orchGovernanceControls);
    for (const name of [
      "id",
      "workspaceId",
      "actionType",
      "kind",
      "resourceId",
      "resourceVersion",
      "payloadHash",
      "policyVersion",
      "requesterPrincipalId",
      "decidedByPrincipalId",
      "status",
      "createdAt",
      "updatedAt",
    ]) {
      expect(columns[name as keyof typeof columns]).toBeDefined();
    }
    expect(columns.status.notNull).toBe(true);
    expect(columns.requesterPrincipalId.notNull).toBe(true);
  });

  it("orch_governance_intents exposes lease fencing and idempotency columns", () => {
    const columns = getTableColumns(orchGovernanceIntents);
    for (const name of [
      "id",
      "workspaceId",
      "actionType",
      "status",
      "idempotencyKey",
      "resourceId",
      "resourceVersion",
      "payloadHash",
      "policyVersion",
      "leaseDeadline",
      "leaseEpoch",
      "leaseToken",
      "controlId",
    ]) {
      expect(columns[name as keyof typeof columns]).toBeDefined();
    }
    expect(columns.leaseEpoch.notNull).toBe(true);
    expect(columns.idempotencyKey.notNull).toBe(true);
  });
});

describe("migration SQL 0004: governance snapshot FORCE RLS (G-01)", () => {
  it("creates orch_governance_controls and orch_governance_intents", () => {
    expect(governanceSnapshotMigrationSql).toMatch(/CREATE TABLE orch_governance_controls\b/);
    expect(governanceSnapshotMigrationSql).toMatch(/CREATE TABLE orch_governance_intents\b/);
  });

  it("enforces unique (workspace_id, idempotency_key) on orch_governance_intents", () => {
    expect(governanceSnapshotMigrationSql).toMatch(
      /orch_governance_intents_workspace_idempotency_key UNIQUE \(workspace_id, idempotency_key\)/,
    );
  });

  it("indexes both tables by workspace_id", () => {
    expect(governanceSnapshotMigrationSql).toMatch(
      /CREATE INDEX orch_governance_controls_workspace_idx ON orch_governance_controls \(workspace_id\)/,
    );
    expect(governanceSnapshotMigrationSql).toMatch(
      /CREATE INDEX orch_governance_intents_workspace_idx ON orch_governance_intents \(workspace_id\)/,
    );
  });

  it("makes the migration owner the owner of every governance snapshot table", () => {
    for (const tableName of GOVERNANCE_SNAPSHOT_WORKSPACE_BOUND_TABLE_NAMES) {
      expect(governanceSnapshotMigrationSql).toMatch(
        new RegExp(`ALTER TABLE ${tableName}\\s+OWNER TO ai_crm_migration_owner;`),
      );
    }
  });

  it("enables and forces RLS on exactly the governance snapshot workspace-bound tables", () => {
    const tableArray = governanceSnapshotMigrationSql.match(
      /FOREACH workspace_bound_table IN ARRAY ARRAY\[([\s\S]*?)\]\s*LOOP/,
    )?.[1];
    expect(tableArray).toBeDefined();
    const listedTables = [...(tableArray?.matchAll(/'([^']+)'/g) ?? [])]
      .map((match) => match[1])
      .sort();
    expect(listedTables).toEqual([...GOVERNANCE_SNAPSHOT_WORKSPACE_BOUND_TABLE_NAMES].sort());
    expect(governanceSnapshotMigrationSql).toMatch(/ALTER TABLE %I ENABLE ROW LEVEL SECURITY/);
    expect(governanceSnapshotMigrationSql).toMatch(/ALTER TABLE %I FORCE ROW LEVEL SECURITY/);
  });

  it("defines both USING and WITH CHECK via app_current_workspace_id()", () => {
    expect(governanceSnapshotMigrationSql).toMatch(
      /CREATE POLICY workspace_isolation ON %I USING \(workspace_id = app_current_workspace_id\(\)\) WITH CHECK \(workspace_id = app_current_workspace_id\(\)\)/,
    );
    expect(governanceSnapshotMigrationSql).toMatch(/app_current_workspace_id\(\)/);
    // Fail-closed: policies must not use raw current_setting.
    const rawSettingInPolicy = /CREATE POLICY[\s\S]*?current_setting\('app\.workspace_id'/;
    expect(governanceSnapshotMigrationSql).not.toMatch(rawSettingInPolicy);
  });

  it("never leaves a table with ENABLE but not FORCE row level security", () => {
    const executableSql = governanceSnapshotMigrationSql.replace(/--.*$/gm, "");
    const enableCount = (executableSql.match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length;
    const forceCount = (executableSql.match(/FORCE ROW LEVEL SECURITY/g) ?? []).length;
    expect(forceCount).toBeGreaterThan(0);
    expect(forceCount).toBe(enableCount);
  });

  it("grants SELECT,INSERT,UPDATE,DELETE to api and worker and SELECT to audit verifier", () => {
    expect(governanceSnapshotMigrationSql).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON\s+orch_governance_controls, orch_governance_intents\s+TO ai_crm_runtime_api;/,
    );
    expect(governanceSnapshotMigrationSql).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON\s+orch_governance_controls, orch_governance_intents\s+TO ai_crm_runtime_worker;/,
    );
    expect(governanceSnapshotMigrationSql).toMatch(
      /GRANT SELECT ON\s+orch_governance_controls, orch_governance_intents\s+TO ai_crm_audit_verifier;/,
    );
  });

  it("never grants ownership to runtime roles", () => {
    expect(governanceSnapshotMigrationSql).not.toMatch(/ALTER TABLE \w+\s+OWNER TO ai_crm_runtime_(api|worker)/);
  });
});