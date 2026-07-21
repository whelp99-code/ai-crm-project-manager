import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IMPORT_ACTION_TYPES, ImportDomainError, ImportService, parseCsv } from "../src/index.js";

const submittedAt = "2026-07-15T09:00:00+09:00";

function service(appliers?: ConstructorParameters<typeof ImportService>[0]) {
  return new ImportService(appliers);
}

function crmCsv(rows: string[]): string {
  return ["customer_id,name,status,created_at", ...rows].join("\n");
}

function bankCsv(rows: string[]): string {
  return ["account,statement_period,posted_at,amount_krw,balance_krw,description", ...rows].join("\n");
}

function submit(
  imports: ImportService,
  overrides: Partial<Parameters<ImportService["submitBatch"]>[0]> & { id: string; content: string },
) {
  return imports.submitBatch({
    workspaceId: "ws-1",
    sourceKind: "CRM",
    schemaVersion: 1,
    operatorPrincipalId: "import-operator",
    submittedAt,
    ...overrides,
  });
}

describe("ImportService — capability-matrix test obligations", () => {
  it("obligation 1: quarantines malformed rows with a reason and imports well-formed rows", () => {
    const imports = service();
    const batch = submit(imports, {
      id: "batch-1",
      content: crmCsv([
        "customer-1,Acme,active,2026-01-01T00:00:00Z",
        "customer-2,,active,2026-01-01T00:00:00Z",
        "customer-3,Beta,nonsense,2026-01-01T00:00:00Z",
      ]),
    });
    expect(batch.status).toBe("QUARANTINED");
    expect(batch.rows[0]).toMatchObject({ status: "IMPORTED" });
    expect(batch.rows[1]).toMatchObject({ status: "QUARANTINED", errorReason: "name is required" });
    expect(batch.rows[2]!.status).toBe("QUARANTINED");
    expect(batch.rows[2]!.errorReason).toMatch(/status must be/);
    // No row may end the batch outside IMPORTED/QUARANTINED.
    expect(batch.rows.every((row) => row.status === "IMPORTED" || row.status === "QUARANTINED")).toBe(true);
  });

  it("obligation 1: a fully valid batch is COMPLETED; a wrong header fails the whole batch", () => {
    const imports = service();
    const completed = submit(imports, { id: "batch-1", content: crmCsv(["customer-1,Acme,active,2026-01-01T00:00:00Z"]) });
    expect(completed.status).toBe("COMPLETED");
    expect(completed.actionType).toBe(IMPORT_ACTION_TYPES.CRM);

    const failed = submit(imports, { id: "batch-2", content: "wrong,header\nvalue,value" });
    expect(failed.status).toBe("FAILED");
    expect(failed.failureReason).toMatch(/header must be exactly/);
    expect(failed.rows).toHaveLength(0);
  });

  it("obligation 1: a row that fails domain application is quarantined, not silently dropped", () => {
    const imports = service({
      CRM: (_batch, row) => {
        if (row.values.customer_id === "customer-dup") throw new Error("customer already exists: customer-dup");
        return row.values.customer_id!;
      },
    });
    const batch = submit(imports, {
      id: "batch-1",
      content: crmCsv(["customer-1,Acme,active,2026-01-01T00:00:00Z", "customer-dup,Dup,active,2026-01-01T00:00:00Z"]),
    });
    expect(batch.status).toBe("QUARANTINED");
    expect(batch.rows[1]).toMatchObject({ status: "QUARANTINED", errorReason: "customer already exists: customer-dup" });
  });

  it("obligation 2: an identical file digest is rejected as a duplicate import", () => {
    const imports = service();
    const content = crmCsv(["customer-1,Acme,active,2026-01-01T00:00:00Z"]);
    submit(imports, { id: "batch-1", content });
    expect(() => submit(imports, { id: "batch-2", content })).toThrowError(/file digest already imported/);
    try {
      submit(imports, { id: "batch-3", content });
    } catch (error) {
      expect(error).toBeInstanceOf(ImportDomainError);
      expect((error as ImportDomainError).code).toBe("DUPLICATE_IMPORT");
    }
  });

  it("obligation 2: an identical bank statement row under a different file digest is quarantined", () => {
    const imports = service();
    const row = "acct-1,2026-06,2026-06-30,-50000,950000,Vendor payment";
    const first = submit(imports, { id: "batch-1", sourceKind: "BANK_STATEMENT", content: bankCsv([row]) });
    expect(first.status).toBe("COMPLETED");

    // Different file (extra row) → different digest, same statement row identity.
    const second = submit(imports, {
      id: "batch-2",
      sourceKind: "BANK_STATEMENT",
      content: bankCsv([row, "acct-1,2026-06,2026-06-30,10000,960000,Interest"]),
    });
    expect(second.status).toBe("QUARANTINED");
    expect(second.rows[0]!.status).toBe("QUARANTINED");
    expect(second.rows[0]!.errorReason).toMatch(/already imported by batch batch-1/);
    expect(second.rows[1]!.status).toBe("IMPORTED");
  });

  it("obligation 2: a duplicate fingerprint inside one batch is quarantined", () => {
    const imports = service();
    const row = "customer-1,Acme,active,2026-01-01T00:00:00Z";
    const batch = submit(imports, { id: "batch-1", content: crmCsv([row, row]) });
    expect(batch.rows[0]!.status).toBe("IMPORTED");
    expect(batch.rows[1]).toMatchObject({ status: "QUARANTINED", errorReason: "duplicate row fingerprint inside batch" });
  });

  it("obligation 3: bank as_of is the stalest per-account date across accounts and periods", () => {
    const imports = service();
    expect(imports.bankFreshness("ws-1")).toEqual({ accounts: {} });

    submit(imports, { id: "batch-1", sourceKind: "BANK_STATEMENT", content: bankCsv(["acct-1,2026-05,2026-05-31,1000,1000,A"]) });
    submit(imports, { id: "batch-2", sourceKind: "BANK_STATEMENT", content: bankCsv(["acct-2,2026-06,2026-06-15,2000,2000,B"]) });

    // acct-1 is stalest → overall freshness must not claim June.
    expect(imports.bankFreshness("ws-1")).toEqual({
      accounts: { "acct-1": "2026-05-31", "acct-2": "2026-06-15" },
      asOf: "2026-05-31",
    });

    // Importing a newer acct-1 statement advances the overall as_of.
    submit(imports, { id: "batch-3", sourceKind: "BANK_STATEMENT", content: bankCsv(["acct-1,2026-06,2026-06-20,3000,4000,C"]) });
    expect(imports.bankFreshness("ws-1").asOf).toBe("2026-06-15");
  });

  it("obligation 3: quarantined statement rows never advance freshness", () => {
    const imports = service();
    const batch = submit(imports, {
      id: "batch-1",
      sourceKind: "BANK_STATEMENT",
      content: bankCsv(["acct-1,2026-06,2026-07-05,1000,1000,posted outside period"]),
    });
    expect(batch.rows[0]!.status).toBe("QUARANTINED");
    expect(imports.bankFreshness("ws-1")).toEqual({ accounts: {} });
  });

  it("obligation 4: every applied record resolves to a full provenance link", () => {
    const imports = service();
    const batch = submit(imports, { id: "batch-1", content: crmCsv(["customer-1,Acme,active,2026-01-01T00:00:00Z"]) });
    expect(imports.provenanceOf("ws-1", "CRM", "customer-1")).toEqual({
      workspaceId: "ws-1",
      sourceKind: "CRM",
      recordId: "customer-1",
      importBatchId: "batch-1",
      rowFingerprint: batch.rows[0]!.rowFingerprint,
      fileDigest: batch.fileDigest,
      fileVersion: 1,
    });
    expect(() => imports.provenanceOf("ws-1", "CRM", "customer-unknown")).toThrowError(/no provenance/);
  });

  it("obligation 5: the import operator cannot verify postings sourced from its own batch", () => {
    const imports = service();
    submit(imports, {
      id: "batch-1",
      sourceKind: "LEDGER",
      content: ["entry_id,entry_date,account_code,debit_krw,credit_krw,description,evidence_ref", "entry-1,2026-06-30,101,50000,0,Sale,evidence-1"].join("\n"),
    });
    expect(() => imports.assertVerifierDistinct("ws-1", "batch-1", "import-operator")).toThrowError(/cannot verify or approve/);
    expect(() => imports.assertVerifierDistinct("ws-1", "batch-1", "cfo-approver")).not.toThrow();
  });

  it("obligation 6: the imports package holds no network capability", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../src/index.ts"), "utf8");
    for (const forbidden of ["node:http", "node:https", "node:net", "node:tls", "node:dgram", "undici", "axios", "fetch("]) {
      expect(source).not.toContain(forbidden);
    }
    const manifest = JSON.parse(readFileSync(join(here, "../package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@ai-crm/contracts"]);
  });
});

describe("ImportService — schema versioning and workspace boundary", () => {
  it("rejects unpinned schema versions and unknown batches fail closed", () => {
    const imports = service();
    expect(() => submit(imports, { id: "batch-1", schemaVersion: 2, content: crmCsv([]) })).toThrowError(/schema version 2 is not pinned/);
    expect(() => imports.getBatch("ws-1", "missing")).toThrowError(/not found/);
  });

  it("assigns immutable monotonic file versions per workspace and source kind", () => {
    const imports = service();
    const first = submit(imports, { id: "batch-1", content: crmCsv(["customer-1,Acme,active,2026-01-01T00:00:00Z"]) });
    const second = submit(imports, { id: "batch-2", content: crmCsv(["customer-2,Beta,active,2026-01-01T00:00:00Z"]) });
    const otherKind = submit(imports, { id: "batch-3", sourceKind: "BANK_STATEMENT", content: bankCsv(["acct-1,2026-06,2026-06-01,1,1,x"]) });
    expect(first.fileVersion).toBe(1);
    expect(second.fileVersion).toBe(2);
    expect(otherKind.fileVersion).toBe(1);
  });

  it("denies cross-workspace batch access, provenance and freshness", () => {
    const imports = service();
    submit(imports, { id: "batch-1", content: crmCsv(["customer-1,Acme,active,2026-01-01T00:00:00Z"]) });
    expect(() => imports.getBatch("ws-2", "batch-1")).toThrowError(/another workspace/);
    expect(() => imports.provenanceOf("ws-2", "CRM", "customer-1")).toThrowError(/no provenance/);
    expect(imports.bankFreshness("ws-2")).toEqual({ accounts: {} });
  });

  it("parses quoted CSV fields with embedded commas, quotes and CRLF", () => {
    expect(parseCsv('a,"b,c","d""e"\r\nf,g,h\n')).toEqual([
      ["a", "b,c", 'd"e'],
      ["f", "g", "h"],
    ]);
  });
});
