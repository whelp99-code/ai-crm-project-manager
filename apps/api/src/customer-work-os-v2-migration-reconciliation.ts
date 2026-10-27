import { createHash } from "node:crypto";
import { CustomerWorkOsV2Error, type NormalizedArchiveReference } from "@ai-crm/domain/customer-work-os-v2";
import type { NormalizedBusinessProjection } from "./customer-work-os-v2-normalized-projection.js";
import { v2Hash } from "./customer-work-os-v2-runtime.js";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CustomerWorkOsV2Error("INVALID_ARCHIVE", "archive entry must be an object");
  }
  return Object.fromEntries(Object.entries(value));
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new CustomerWorkOsV2Error("INVALID_ARCHIVE", "archive collection must be an array");
  return value.map(record);
}
function key(row: Record<string, unknown>): string {
  if (typeof row.id !== "string" || row.id.length === 0) {
    throw new CustomerWorkOsV2Error("INVALID_ARCHIVE", "canonical key is required");
  }
  return row.id;
}

/** Read-only comparison; residuals are never silently promoted to migrated business state. */
export function reconcileNormalizedArchive(input: {
  readonly archiveBytes: Uint8Array;
  readonly expectedArchiveSHA256: string;
  readonly projection: NormalizedBusinessProjection;
  readonly reference: NormalizedArchiveReference;
  readonly nativeVersion: number;
  readonly expectedNativeVersion: number;
}) {
  const archiveSHA256 = createHash("sha256").update(input.archiveBytes).digest("hex");
  if (archiveSHA256 !== input.expectedArchiveSHA256) {
    throw new CustomerWorkOsV2Error("ARCHIVE_SOURCE_MISMATCH", "original archive bytes do not match the pinned source");
  }
  const archive = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.archiveBytes)));
  const { projection, reference } = input;
  if (archive.workspaceId !== reference.workspaceId || projection.workspaceId !== reference.workspaceId) {
    throw new CustomerWorkOsV2Error("WORKSPACE_MISMATCH", "archive, projection and native scope must match");
  }
  if (input.nativeVersion !== input.expectedNativeVersion) {
    throw new CustomerWorkOsV2Error("VERSION_CONFLICT", "native reconciliation version changed");
  }
  if (reference.approved !== false || projection.authority !== "ARCHIVE_PROJECTION_ONLY" ||
      archive.planHash !== reference.planHash || archive.snapshotHash !== reference.snapshotHash ||
      projection.planId !== reference.planId || projection.planVersion !== reference.planVersion ||
      v2Hash(projection) !== reference.sourceDigest) {
    throw new CustomerWorkOsV2Error("ARCHIVE_SOURCE_MISMATCH", "native reference must bind the exact archive projection");
  }
  const quarantined = rows(archive.quarantined);
  const excluded = new Set(quarantined.map(row => row.sourceId));
  const residuals: { entity: string; id: string | null; reason: string }[] = [];
  const collections = [
    { entity: "accounts", source: rows(archive.accounts), normalized: projection.accounts, native: reference.accountIds },
    { entity: "engagements", source: rows(archive.engagements), normalized: projection.engagements, native: reference.engagementIds },
    { entity: "financialItems", source: rows(archive.financialItems), normalized: projection.financialItems, native: reference.financialItemIds },
  ];
  const records = collections.map(collection => {
    const eligible = collection.source.filter(row => {
      const skip = excluded.has(row.id) || excluded.has(row.legacySourceId);
      if (skip) residuals.push({ entity: collection.entity, id: key(row), reason: "SOURCE_QUARANTINED" });
      return !skip;
    });
    const sourceKeys = eligible.map(key), normalizedKeys = collection.normalized.map(key);
    const duplicates = sourceKeys.filter((id, index) => sourceKeys.indexOf(id) !== index);
    const missingNormalized = sourceKeys.filter(id => !normalizedKeys.includes(id));
    const missingNative = normalizedKeys.filter(id => !collection.native.includes(id));
    const unexpectedNormalized = normalizedKeys.filter(id => !sourceKeys.includes(id));
    const unexpectedNative = collection.native.filter(id => !normalizedKeys.includes(id));
    for (const id of duplicates) residuals.push({ entity: collection.entity, id, reason: "DUPLICATE_SOURCE_KEY" });
    for (const id of missingNormalized) residuals.push({ entity: collection.entity, id, reason: "MISSING_NORMALIZED_KEY" });
    for (const id of missingNative) residuals.push({ entity: collection.entity, id, reason: "MISSING_NATIVE_REFERENCE" });
    for (const id of unexpectedNormalized) residuals.push({ entity: collection.entity, id, reason: "UNEXPECTED_NORMALIZED_KEY" });
    for (const id of unexpectedNative) residuals.push({ entity: collection.entity, id, reason: "UNEXPECTED_NATIVE_REFERENCE" });
    return {
      entity: collection.entity, archiveCount: collection.source.length, eligibleCount: eligible.length,
      normalizedCount: normalizedKeys.length, nativeReferenceCount: collection.native.length,
      sourceKeys, normalizedKeys, nativeKeys: [...collection.native],
      duplicates, missingNormalized, missingNative, unexpectedNormalized, unexpectedNative,
    };
  });
  const accountKeys = new Set(projection.accounts.map(key));
  const engagementKeys = new Set(projection.engagements.map(key));
  const relations = projection.financialItems.flatMap(row => {
    const source = rows(archive.financialItems).find(item => key(item) === key(row));
    const links = [
      { field: "account_id", sourceField: "accountSourceId", collection: "accounts", targets: accountKeys },
      ...typeof row.engagement_id === "string" || typeof source?.engagementSourceId === "string"
        ? [{ field: "engagement_id", sourceField: "engagementSourceId", collection: "engagements", targets: engagementKeys }]
        : [],
    ];
    return links.map(link => {
      const sourceId = source?.[link.sourceField];
      const original = typeof sourceId === "string"
        ? rows(archive[link.collection]).find(item => item.legacySourceId === sourceId)
        : undefined;
      const sourceTarget = original ? key(original) : null;
      const sourceMatched = sourceTarget === null ? null : sourceTarget === row[link.field];
      if (sourceMatched !== true) residuals.push({
        entity: "relations", id: key(row),
        reason: sourceMatched === null
          ? `SOURCE_${link.sourceField}_${typeof sourceId === "string" ? "UNRESOLVED" : "MISSING"}`
          : `DIFF_${link.sourceField}`,
      });
      return {
        id: key(row), field: link.field, target: row[link.field], matched: link.targets.has(String(row[link.field])),
        sourceId: typeof sourceId === "string" ? sourceId : null, sourceTarget, sourceMatched,
      };
    });
  });
  for (const relation of relations) if (!relation.matched) {
    residuals.push({ entity: "relations", id: relation.id, reason: `MISSING_${relation.field.toUpperCase()}` });
  }
  const money = projection.financialItems.map(row => {
    const source = rows(archive.financialItems).find(item => key(item) === key(row));
    const fields = [
      ["netAmountKrw", "net_amount_krw"], ["vatAmountKrw", "vat_amount_krw"], ["grossAmountKrw", "gross_amount_krw"],
    ].map(([sourceField, normalizedField]) => {
      if (!sourceField || !normalizedField) throw new CustomerWorkOsV2Error("INVALID_ARCHIVE", "money field missing");
      const before = source?.[sourceField], after = row[normalizedField];
      if (typeof after !== "string" || !/^\d+$/.test(after)) {
        throw new CustomerWorkOsV2Error("INVALID_ARCHIVE", "normalized money must be exact integer strings");
      }
      const matched = typeof before === "string" ? before === after : null;
      if (matched !== true) residuals.push({
        entity: "money", id: key(row), reason: matched === null ? `SOURCE_${sourceField}_MISSING` : `DIFF_${sourceField}`,
      });
      return { field: sourceField, archive: typeof before === "string" ? before : null, normalized: after, matched };
    });
    return { id: key(row), fields };
  });
  // The established Notion snapshot/plan has no ACL, revision-history or partial-payment archive contract.
  for (const reason of ["SOURCE_ACL_CONTRACT_MISSING", "SOURCE_HISTORY_CONTRACT_MISSING",
    "SOURCE_PARTIAL_PAYMENT_CONTRACT_MISSING", "DOCUMENT_WORK_NATIVE_MAPPING_NOT_ADMITTED"]) {
    residuals.push({ entity: "coverage", id: null, reason });
  }
  return {
    schemaVersion: 1, authority: "ARCHIVE_PROJECTION_ONLY", approved: false,
    nativeRepresentation: "ARCHIVE_REFERENCES", businessMigrationComplete: false,
    workspaceId: reference.workspaceId, planId: reference.planId,
    archiveSHA256, sourceDigest: reference.sourceDigest, nativeReferenceId: reference.id,
    nativeVersion: input.nativeVersion, records, relations, money,
    quarantined, residuals,
  };
}
