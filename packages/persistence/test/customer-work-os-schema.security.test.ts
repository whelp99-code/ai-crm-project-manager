import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(new URL("../migrations/0012_customer_work_os.sql", import.meta.url));
const sql = readFileSync(migrationPath, "utf8");

const TABLES = [
  "cwos_accounts",
  "cwos_contacts",
  "cwos_engagements",
  "cwos_engagement_parties",
  "cwos_activities",
  "cwos_knowledge_items",
  "cwos_commitments",
  "cwos_products",
  "cwos_quotes",
  "cwos_contracts",
  "cwos_delivery_projects",
  "cwos_change_requests",
  "cwos_purchase_orders",
  "cwos_assets",
  "cwos_financial_items",
  "cwos_settlements",
] as const;

describe("Customer Work OS PostgreSQL contract", () => {
  it("creates every CRM, CPQ, PSA, ERP and finance table inside the workspace boundary", () => {
    for (const table of TABLES) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
    }
    expect(sql).toContain("UNIQUE (workspace_id, project_key)");
    expect(sql).toContain("FOREIGN KEY (workspace_id, engagement_id)");
    expect(sql).toContain("FOREIGN KEY (workspace_id, account_id)");
  });

  it("enables and forces RLS for every table and grants no model-gateway write access", () => {
    expect(sql).toContain("ALTER TABLE %I ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE %I FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("current_setting(''app.workspace_id'', true)");
    expect(sql).toContain("ai_crm_runtime_api, ai_crm_runtime_worker");
    expect(sql).not.toContain("ai_crm_runtime_model_gateway");
    for (const table of TABLES) {
      expect(sql).toContain(`'${table}'`);
    }
  });

  it("uses integer KRW, enforces VAT equality and prevents orphan project costs", () => {
    expect(sql).toContain("net_amount_krw bigint NOT NULL");
    expect(sql).toContain("vat_amount_krw bigint NOT NULL");
    expect(sql).toContain("gross_amount_krw bigint NOT NULL");
    expect(sql).toContain("gross_amount_krw = net_amount_krw + vat_amount_krw");
    expect(sql).toContain("engagement_id IS NOT NULL OR category = 'overhead'");
    expect(sql).not.toMatch(/(?:net|vat|gross)_amount_krw\s+(?:real|double precision|numeric\s*\([^)]*,[^)]*\))/i);
  });

  it("makes settlements evidence-backed, bounded, append-only and reversible", () => {
    expect(sql).toContain("evidence_ref text NOT NULL");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION cwos_settlement_guard()");
    expect(sql).toContain("settlement allocation outside 0..gross range");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION cwos_settlement_immutable()");
    expect(sql).toContain("settlements are append-only; create a reversal row");
    expect(sql).toContain("REVOKE UPDATE, DELETE ON cwos_settlements");
    expect(sql).toContain("UNIQUE (workspace_id, reversal_of_settlement_id)");
  });

  it("requires evidence for confirmed facts and completed commitments", () => {
    expect(sql).toContain("status <> 'CONFIRMED' OR evidence_ref IS NOT NULL");
    expect(sql).toContain("status <> 'DONE' OR completion_evidence_ref IS NOT NULL");
  });
});
