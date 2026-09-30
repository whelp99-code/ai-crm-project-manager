import { createHash } from "node:crypto";

/** RFC 4122 URL namespace. Dry-run workspace binding is fixed to this value. */
export const NOTION_CWOS_WORKSPACE_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveNotionWorkspaceId(workspaceId: string): { workspaceId: string; rewritten: boolean } {
  if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
    throw new NotionCwosImportError("INVALID_SNAPSHOT", "workspaceId, snapshotId and snapshotHash are required");
  }
  const trimmed = workspaceId.trim();
  if (UUID_PATTERN.test(trimmed)) return { workspaceId: trimmed, rewritten: false };
  return { workspaceId: uuidV5(NOTION_CWOS_WORKSPACE_NAMESPACE, trimmed), rewritten: true };
}

function uuidV5(namespace: string, name: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (namespaceBytes.length !== 16) throw new NotionCwosImportError("INVALID_SNAPSHOT", "workspace namespace is not a UUID");
  const hash = createHash("sha1").update(namespaceBytes).update(name, "utf8").digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class NotionCwosImportError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NotionCwosImportError";
  }
}

export interface NotionSourceRow {
  sourceId: string;
  sourceUrl?: string;
  properties: Record<string, unknown>;
}

export interface NotionCwosSnapshot {
  workspaceId: string;
  snapshotId: string;
  snapshotHash: string;
  capturedAt: string;
  accounts: NotionSourceRow[];
  projects: NotionSourceRow[];
  activities: NotionSourceRow[];
  finance: NotionSourceRow[];
}

export type QuarantineReason =
  | "INVALID_SOURCE_ID"
  | "MISSING_REQUIRED_FIELD"
  | "MISSING_PROJECT_KEY"
  | "MIXED_EXPENSE_PROJECT"
  | "DUPLICATE_ACCOUNT"
  | "DUPLICATE_PROJECT_KEY"
  | "ORPHAN_ACTIVITY"
  | "ORPHAN_FINANCE"
  | "INVALID_AMOUNT"
  | "VAT_MISMATCH"
  | "DUPLICATE_FINANCE"
  | "UNKNOWN_RELATION"
  | "UNMAPPED_STAGE"
  | "UNMAPPED_ACTIVITY_TYPE"
  | "UNMAPPED_PARTY_ROLE"
  | "UNMAPPED_FINANCE_KIND"
  | "UNMAPPED_FINANCE_STATUS"
  | "UNMAPPED_EVIDENCE_STATUS"
  | "FINANCE_STATUS_CONFLICT";

export interface OutOfScopeRow {
  entity: "financial_item";
  sourceId: string;
  bucket: "price_ledger";
  sourceKind: string;
}

export interface QuarantinedRow {
  entity: "account" | "engagement" | "activity" | "financial_item";
  sourceId: string;
  reasons: QuarantineReason[];
  message: string;
  rawFingerprint: string;
}

export interface NotionProvenance {
  naturalKey?: string;
  evidenceGrade?: string;
  confidence?: string;
  sourceRevision?: string;
}

export interface NotionFinanceProvenance extends NotionProvenance {
  evidenceStatus?: FinanceEvidenceStatus;
  projectMappingStatus?: string;
  expectedDateSource?: "actual_date";
  accountSource?: "project_party" | "owner_override";
}

export interface AccountImportRecord {
  id: string;
  workspaceId: string;
  legacySourceId: string;
  provenance: NotionProvenance;
  sourceUrl?: string;
  name: string;
  normalizedName: string;
  kinds: string[];
  status: "active" | "inactive" | "at_risk";
  primaryContactName?: string;
  primaryEmail?: string;
  primaryPhone?: string;
  recentContactDate?: string;
  nextContactDate?: string;
}

export type EngagementPartyRole = "customer" | "prime_contractor" | "partner" | "vendor" | "manufacturer" | "outsourcer";

export interface EngagementPartyImportRecord {
  accountSourceId: string;
  role: EngagementPartyRole;
  notionRelation: string;
  primary: boolean;
  commercialResponsibility: boolean;
  deliveryResponsibility: boolean;
}

export interface EngagementImportRecord {
  id: string;
  workspaceId: string;
  legacySourceId: string;
  provenance: NotionProvenance;
  sourceUrl?: string;
  projectKey: string;
  name: string;
  stage: string;
  /** Set only by an owner stage override. Apply must not recompute type from stage when this is present. */
  engagementType?: "inquiry" | "opportunity" | "consulting" | "delivery" | "support" | "maintenance" | "renewal" | "internal";
  /** Original Notion 프로젝트 단계. Mapped `stage` collapses 매입발주 and 수행/검수. */
  sourceStage?: string;
  priority?: string;
  startDate?: string;
  targetDate?: string;
  nextAction?: string;
  proposedProducts?: string;
  proposedAmountKrw?: string;
  parties: EngagementPartyImportRecord[];
  artifactRefs: Record<string, string[]>;
}

export type ActivityImportType = "email_in" | "email_out" | "call" | "meeting" | "message" | "decision" | "note";

export interface ActivityImportRecord {
  id: string;
  workspaceId: string;
  legacySourceId: string;
  provenance: NotionProvenance;
  sourceUrl?: string;
  activityType: ActivityImportType;
  occurredAt: string;
  summary: string;
  decision?: string;
  nextAction?: string;
  nextContactDate?: string;
  accountSourceIds: string[];
  projectSourceIds: string[];
  attachmentRefs: string[];
}

export type FinanceEvidenceStatus = "unverified" | "bank_confirmed" | "wehago_confirmed" | "cross_confirmed" | "user_confirmed";

export interface FinancialItemImportRecord {
  id: string;
  workspaceId: string;
  legacySourceId: string;
  provenance: NotionFinanceProvenance;
  sourceUrl?: string;
  engagementSourceId: string | null;
  accountSourceId: string | null;
  direction: "IN" | "OUT";
  category: string;
  lifecycle: string;
  netAmountKrw: string;
  vatAmountKrw: string;
  grossAmountKrw: string;
  expectedDate: string | null;
  importAssignment?: "assigned" | "unassigned";
  actualDate?: string;
  evidenceRefs: string[];
  sourceFingerprint: string;
}

export interface NotionCwosReconciliation {
  source: {
    accounts: number;
    projects: number;
    activities: number;
    finance: number;
  };
  imported: {
    accounts: number;
    engagements: number;
    activities: number;
    financialItems: number;
  };
  quarantined: number;
  outOfScope: {
    priceLedger: number;
  };
  finance: {
    inboundNetKrw: string;
    inboundVatKrw: string;
    inboundGrossKrw: string;
    outboundNetKrw: string;
    outboundVatKrw: string;
    outboundGrossKrw: string;
  };
  orphanRelations: number;
  duplicateCandidates: number;
}

export interface NotionCwosImportPlan {
  workspaceId: string;
  snapshotId: string;
  snapshotHash: string;
  capturedAt: string;
  planHash: string;
  accounts: AccountImportRecord[];
  engagements: EngagementImportRecord[];
  activities: ActivityImportRecord[];
  financialItems: FinancialItemImportRecord[];
  quarantined: QuarantinedRow[];
  outOfScope: OutOfScopeRow[];
  reconciliation: NotionCwosReconciliation;
  readOnlySource: true;
  workspaceBinding?: {
    algorithm: "uuidv5";
    namespace: string;
    sourceWorkspaceKey: string;
    workspaceId: string;
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

/** Drop signed-URL query and fragment. Notion S3 signatures change every snapshot; the path does not. */
export function stableNotionStorageKey(uri: string): string {
  const trimmed = uri.trim();
  const hashAt = trimmed.indexOf("#");
  const noHash = hashAt === -1 ? trimmed : trimmed.slice(0, hashAt);
  const queryAt = noHash.indexOf("?");
  const noQuery = queryAt === -1 ? noHash : noHash.slice(0, queryAt);
  try {
    const url = new URL(noQuery);
    return `${url.origin}${decodeURIComponent(url.pathname)}`;
  } catch {
    return noQuery;
  }
}

export function notionArtifactIdentity(input: { engagementId: string; pageId: string; kind: string; storageUri: string }): { id: string; notionPageId: string } {
  const file = stableNotionStorageKey(input.storageUri);
  return {
    id: `artifact-${notionCwosHash({ engagement: input.engagementId, kind: input.kind, file }).slice(-8)}`,
    notionPageId: `artifact:${input.pageId}:${input.kind}:${notionCwosHash(file).slice(-8)}`,
  };
}

export function notionCwosHash(value: unknown): string {
  const serialized = JSON.stringify(canonical(value)) ?? "undefined";
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function sourceId(row: NotionSourceRow): string {
  const value = row.sourceId?.trim();
  if (!value) throw new NotionCwosImportError("INVALID_SOURCE_ID", "sourceId is required");
  return value;
}

function text(properties: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = properties[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function stringArray(properties: Record<string, unknown>, names: string[]): string[] {
  for (const name of names) {
    const value = properties[name];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
    }
    if (typeof value === "string" && value.trim()) {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
      } catch {
        return [value.trim()];
      }
    }
  }
  return [];
}

function booleanValue(properties: Record<string, unknown>, names: string[]): boolean {
  for (const name of names) {
    const value = properties[name];
    if (value === true || value === "__YES__" || value === "true") return true;
  }
  return false;
}

function integerMoney(properties: Record<string, unknown>, names: string[]): bigint | undefined {
  for (const name of names) {
    const value = properties[name];
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) throw new NotionCwosImportError("INVALID_AMOUNT", `${name} must be a safe integer`);
      return BigInt(value);
    }
    if (typeof value === "string" && value.trim()) {
      const normalized = value.replace(/[₩,\s]/g, "");
      if (!/^-?\d+$/.test(normalized)) throw new NotionCwosImportError("INVALID_AMOUNT", `${name} is not integer KRW`);
      return BigInt(normalized);
    }
  }
  return undefined;
}

function dateValue(properties: Record<string, unknown>, names: string[]): string | undefined {
  const value = text(properties, names);
  if (!value) return undefined;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
  return match?.[0];
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase("ko-KR").replace(/\s+/g, " ");
}

function id(prefix: string, workspaceId: string, source: string): string {
  return `${prefix}-${notionCwosHash({ workspaceId, source }).slice(-8)}`;
}

function classifyAccountKind(value: string | undefined): string[] {
  switch (value) {
    case "고객": return ["customer"];
    case "파트너": return ["partner"];
    case "제조사": return ["manufacturer"];
    case "벤더": return ["vendor"];
    case "외주": return ["outsourcer"];
    default: return ["other"];
  }
}

function mapAccountStatus(value: string | undefined): AccountImportRecord["status"] {
  if (value === "주의") return "at_risk";
  if (value === "휴면" || value === "종료") return "inactive";
  return "active";
}

function scalarText(properties: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = properties[name];
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function provenanceOf(properties: Record<string, unknown>): NotionProvenance {
  const naturalKey = text(properties, ["자연키"]);
  const evidenceGrade = text(properties, ["근거등급"]);
  const confidence = scalarText(properties, ["확신도"]);
  const sourceRevision = scalarText(properties, ["원천 revision"]);
  return {
    ...(naturalKey !== undefined ? { naturalKey } : {}),
    ...(evidenceGrade !== undefined ? { evidenceGrade } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
  };
}

const PROJECT_STAGES = new Map<string, string>([
  ["제안/견적", "PROPOSAL"],
  ["고객발주", "CONTRACTED"],
  ["매입발주", "DELIVERY"],
  ["수행/검수", "DELIVERY"],
  ["청구/수금", "BILLING"],
  ["완료", "CLOSED"],
  ["보류", "ON_HOLD"],
  ["실패", "LOST"],
]);

const ACTIVITY_TYPES = new Map<string, ActivityImportType>([
  ["메일 수신", "email_in"],
  ["메일 발신", "email_out"],
  ["전화", "call"],
  ["미팅", "meeting"],
  ["메신저", "message"],
  ["결정", "decision"],
  ["메모", "note"],
]);

const PARTY_ROLE_BY_ACCOUNT_KIND = new Map<string, EngagementPartyRole>([
  ["customer", "customer"],
  ["partner", "partner"],
  ["manufacturer", "manufacturer"],
  ["vendor", "vendor"],
  ["outsourcer", "outsourcer"],
]);

const FINANCE_DIRECTIONS = new Map<string, "IN" | "OUT">([
  ["매출", "IN"],
  ["매입", "OUT"],
]);

const PRICE_LEDGER_KINDS = new Set(["기타입금", "기타출금"]);

const FINANCE_LIFECYCLES = new Map<string, string>([
  ["예정", "PLANNED"],
  ["청구", "BILLED"],
  ["부분처리", "PARTIAL"],
  ["입금완료", "SETTLED"],
  ["출금완료", "SETTLED"],
  ["연체", "OVERDUE"],
]);

const FINANCE_EVIDENCE_STATUSES = new Map<string, FinanceEvidenceStatus>([
  ["미확인", "unverified"],
  ["은행확인", "bank_confirmed"],
  ["WEHAGO확인", "wehago_confirmed"],
  ["교차확인", "cross_confirmed"],
  ["사용자확인", "user_confirmed"],
]);

const SNAPSHOT_TABLES = ["accounts", "projects", "activities", "finance"] as const;

const LEGACY_TABLE_PROPERTIES: Array<[string, string[]]> = [
  ["미수금/입금관리", ["입금상태", "입금액"]],
  ["자금흐름 DB", ["입금계좌", "출금계좌", "현금변동"]],
  ["매입/비용 DB", ["지출명", "결재수단", "납입여부"]],
];

const TODO_BOARD_PROPERTIES = new Set(["이름", "상태", "담당자"]);

function assertSupportedSourceTables(snapshot: NotionCwosSnapshot): void {
  const allowed = new Set<string>(SNAPSHOT_TABLES);
  for (const [key, value] of Object.entries(snapshot)) {
    if (Array.isArray(value) && !allowed.has(key)) {
      throw new NotionCwosImportError("FORBIDDEN_SOURCE_TABLE", `snapshot table ${key} is not an importable Notion database`);
    }
  }
  for (const table of SNAPSHOT_TABLES) {
    for (const row of snapshot[table]) {
      const names = Object.keys(row.properties ?? {});
      const legacy = LEGACY_TABLE_PROPERTIES.find(([, properties]) => properties.some((name) => names.includes(name)));
      if (legacy) {
        throw new NotionCwosImportError("FORBIDDEN_SOURCE_TABLE", `${table} row ${row.sourceId} carries ${legacy[0]} properties; legacy money tables must not enter the snapshot`);
      }
      if (names.includes("이름") && names.every((name) => TODO_BOARD_PROPERTIES.has(name))) {
        throw new NotionCwosImportError("FORBIDDEN_SOURCE_TABLE", `${table} row ${row.sourceId} looks like the CFO OS todo board`);
      }
    }
  }
}

function engagementParties(
  relations: { generic: string[]; billed: string[]; endCustomers: string[]; suppliers: string[]; partners: string[] },
  accountKinds: Map<string, string[]>,
): EngagementPartyImportRecord[] | undefined {
  const parties: EngagementPartyImportRecord[] = [];
  const add = (accountSourceId: string, role: EngagementPartyRole, notionRelation: string, commercialResponsibility: boolean, deliveryResponsibility: boolean): void => {
    if (parties.some((party) => party.accountSourceId === accountSourceId && party.role === role)) return;
    const primary = !parties.some((party) => party.role === role);
    parties.push({ accountSourceId, role, notionRelation, primary, commercialResponsibility, deliveryResponsibility });
  };
  for (const source of relations.endCustomers) add(source, "customer", "최종고객", relations.billed.includes(source), false);
  for (const source of relations.billed) {
    if (relations.endCustomers.includes(source)) continue;
    add(source, relations.endCustomers.length === 0 ? "customer" : "prime_contractor", "매출처", true, false);
  }
  for (const source of relations.suppliers) add(source, "vendor", "매입처", true, false);
  for (const source of relations.partners) add(source, "partner", "파트너", false, true);
  for (const source of relations.generic) {
    if (parties.some((party) => party.accountSourceId === source)) continue;
    const role = PARTY_ROLE_BY_ACCOUNT_KIND.get(accountKinds.get(source)?.[0] ?? "");
    if (!role) return undefined;
    add(source, role, "고객·파트너", role === "customer", false);
  }
  return parties;
}

function looksLikeExpenseProject(name: string, projectKey: string | undefined, accountRelations: string[]): boolean {
  const expensePattern = /(카드사용료|통신비|출장비|식비|숙박비|라이센스구매|라이선스구매|매입|비용|수수료)/i;
  return expensePattern.test(name) && !projectKey && accountRelations.length === 0;
}

function financeCategory(direction: "IN" | "OUT", memo: string): string {
  if (direction === "IN") return "contract_revenue";
  if (/라이[센선]스/i.test(memo)) return "license_cost";
  if (/장비|서버|스위치|방화벽|HCI/i.test(memo)) return "hardware_cost";
  if (/외주|설치/i.test(memo)) return "outsourcing_cost";
  if (/출장|숙박|교통/i.test(memo)) return "travel_cost";
  return "other";
}


export interface NotionOwnerStageOverride {
  stage: string;
  engagementType: NonNullable<EngagementImportRecord["engagementType"]>;
  projectKey?: string;
}

export interface NotionOwnerOverrides {
  stages: Record<string, NotionOwnerStageOverride>;
  unassignedFinance: string[];
  accountActivities: Record<string, { accountSourceId: string }>;
  nullExpectedDate: string[];
  counterparties: Record<string, { accountSourceId: string }>;
}

export interface NotionCwosPlanRules {
  stage: boolean;
  unassignedFinance: boolean;
  accountActivity: boolean;
  nullExpectedDate: boolean;
  counterparty: boolean;
}

export interface NotionCwosPlanOptions {
  rules?: Partial<NotionCwosPlanRules>;
  overrides?: NotionOwnerOverrides;
}

const ALLOWED_OVERRIDE_STAGES = new Set(PROJECT_STAGES.values());
const ALLOWED_OVERRIDE_TYPES = new Set(["inquiry", "opportunity", "consulting", "delivery", "support", "maintenance", "renewal", "internal"]);

export const NOTION_OWNER_RULES_OFF: NotionCwosPlanRules = {
  stage: false,
  unassignedFinance: false,
  accountActivity: false,
  nullExpectedDate: false,
  counterparty: false,
};

export class NotionCwosImportPlanner {
  plan(snapshot: NotionCwosSnapshot, options?: NotionCwosPlanOptions): NotionCwosImportPlan {
    const rules: NotionCwosPlanRules = { ...NOTION_OWNER_RULES_OFF, ...options?.rules };
    const overrides = options?.overrides;
    if (!snapshot.workspaceId.trim() || !snapshot.snapshotId.trim() || !snapshot.snapshotHash.trim()) {
      throw new NotionCwosImportError("INVALID_SNAPSHOT", "workspaceId, snapshotId and snapshotHash are required");
    }
    assertSupportedSourceTables(snapshot);

    const quarantined: QuarantinedRow[] = [];
    const outOfScope: OutOfScopeRow[] = [];
    const accounts: AccountImportRecord[] = [];
    const engagements: EngagementImportRecord[] = [];
    const activities: ActivityImportRecord[] = [];
    const financialItems: FinancialItemImportRecord[] = [];
    const accountSourceIds = new Set<string>();
    const projectSourceIds = new Set<string>();
    const projectCounterparties = new Map<string, { billed: string[]; suppliers: string[] }>();
    const accountKinds = new Map<string, string[]>();
    const accountNames = new Map<string, string>();
    const projectKeys = new Map<string, string>();
    const financeFingerprints = new Set<string>();
    let duplicateCandidates = 0;
    let orphanRelations = 0;

    const quarantine = (entity: QuarantinedRow["entity"], row: NotionSourceRow, reasons: QuarantineReason[], message: string): void => {
      quarantined.push({ entity, sourceId: row.sourceId || "<missing>", reasons: [...new Set(reasons)], message, rawFingerprint: notionCwosHash(row) });
    };

    for (const row of snapshot.accounts) {
      try {
        const legacySourceId = sourceId(row);
        const name = text(row.properties, ["회사/조직명", "회사명", "Name", "title"]);
        if (!name) {
          quarantine("account", row, ["MISSING_REQUIRED_FIELD"], "account name is missing");
          continue;
        }
        const normalized = normalizedName(name);
        const prior = accountNames.get(normalized);
        if (prior) {
          duplicateCandidates += 1;
          quarantine("account", row, ["DUPLICATE_ACCOUNT"], `duplicate account candidate of ${prior}`);
          continue;
        }
        accountNames.set(normalized, legacySourceId);
        accountSourceIds.add(legacySourceId);
        const kinds = classifyAccountKind(text(row.properties, ["구분", "유형"]));
        accountKinds.set(legacySourceId, kinds);
        const provenance = provenanceOf(row.properties);
        const primaryContactName = text(row.properties, ["담당자", "주요 담당자"]);
        const primaryEmail = text(row.properties, ["대표 이메일", "이메일"]);
        const primaryPhone = text(row.properties, ["대표 연락처", "전화", "연락처"]);
        const recentContactDate = dateValue(row.properties, ["date:최근 연락일:start", "최근 연락일"]);
        const nextContactDate = dateValue(row.properties, ["date:다음 연락일:start", "다음 연락일"]);
        accounts.push({
          id: id("account", snapshot.workspaceId, legacySourceId),
          workspaceId: snapshot.workspaceId,
          legacySourceId,
          provenance,
          ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
          name,
          normalizedName: normalized,
          kinds,
          status: mapAccountStatus(text(row.properties, ["관계상태", "상태"])),
          ...(primaryContactName !== undefined ? { primaryContactName } : {}),
          ...(primaryEmail !== undefined ? { primaryEmail } : {}),
          ...(primaryPhone !== undefined ? { primaryPhone } : {}),
          ...(recentContactDate !== undefined ? { recentContactDate } : {}),
          ...(nextContactDate !== undefined ? { nextContactDate } : {}),
        });
      } catch (error) {
        quarantine("account", row, [error instanceof NotionCwosImportError ? error.code as QuarantineReason : "MISSING_REQUIRED_FIELD"], error instanceof Error ? error.message : "account mapping failed");
      }
    }

    for (const row of snapshot.projects) {
      try {
        const legacySourceId = sourceId(row);
        const name = text(row.properties, ["프로젝트명(Title)", "프로젝트명", "Name", "title"]);
        if (!name) {
          quarantine("engagement", row, ["MISSING_REQUIRED_FIELD"], "project name is missing");
          continue;
        }
        const stageOverride = rules.stage ? overrides?.stages[legacySourceId] : undefined;
        const key = text(row.properties, ["프로젝트ID", "프로젝트 ID", "Project Key"]) ?? stageOverride?.projectKey;
        const relations = {
          generic: stringArray(row.properties, ["고객·파트너", "고객", "accountSourceIds"]),
          billed: stringArray(row.properties, ["매출처"]),
          endCustomers: stringArray(row.properties, ["최종고객"]),
          suppliers: stringArray(row.properties, ["매입처"]),
          partners: stringArray(row.properties, ["파트너", "partnerSourceIds"]),
        };
        const relatedAccountIds = [...new Set(Object.values(relations).flat())];
        if (looksLikeExpenseProject(name, key, relatedAccountIds)) {
          quarantine("engagement", row, ["MIXED_EXPENSE_PROJECT"], "expense-like row is mixed into the project database");
          continue;
        }
        if (!key) {
          quarantine("engagement", row, ["MISSING_PROJECT_KEY"], `project key is missing; candidate LEGACY-${notionCwosHash(legacySourceId).slice(-8)}`);
          continue;
        }
        const prior = projectKeys.get(key);
        if (prior) {
          duplicateCandidates += 1;
          quarantine("engagement", row, ["DUPLICATE_PROJECT_KEY"], `project key duplicates ${prior}`);
          continue;
        }
        const unknownRelations = relatedAccountIds.filter((relation) => !accountSourceIds.has(relation));
        if (unknownRelations.length > 0) {
          orphanRelations += unknownRelations.length;
          quarantine("engagement", row, ["UNKNOWN_RELATION"], `unknown account relations: ${unknownRelations.join(", ")}`);
          continue;
        }
        const stageLabel = text(row.properties, ["프로젝트 단계"]);
        let stage = stageLabel ? PROJECT_STAGES.get(stageLabel) : undefined;
        let engagementType: EngagementImportRecord["engagementType"];
        if (stageOverride) {
          if (!ALLOWED_OVERRIDE_STAGES.has(stageOverride.stage) || !ALLOWED_OVERRIDE_TYPES.has(stageOverride.engagementType)) {
            quarantine("engagement", row, ["UNMAPPED_STAGE"], "owner stage override is outside the existing stage and engagement_type checks");
            continue;
          }
          stage = stageOverride.stage;
          engagementType = stageOverride.engagementType;
        } else if (!stageLabel) {
          quarantine("engagement", row, ["MISSING_REQUIRED_FIELD"], "프로젝트 단계 is missing");
          continue;
        } else if (!stage) {
          quarantine("engagement", row, ["UNMAPPED_STAGE"], `프로젝트 단계 ${stageLabel} has no core5 stage`);
          continue;
        }
        const parties = engagementParties(relations, accountKinds);
        if (!parties) {
          quarantine("engagement", row, ["UNMAPPED_PARTY_ROLE"], "고객·파트너 relation points at an account whose 구분 has no party role");
          continue;
        }
        const provenance = provenanceOf(row.properties);
        projectKeys.set(key, legacySourceId);
        projectSourceIds.add(legacySourceId);
        projectCounterparties.set(legacySourceId, { billed: relations.billed, suppliers: relations.suppliers });
        const proposed = integerMoney(row.properties, ["제안금액", "예상 매출"]);
        const priority = text(row.properties, ["중요도"]);
        const startDate = dateValue(row.properties, ["date:시작일:start", "시작일"]);
        const targetDate = dateValue(row.properties, ["date:종료일:start", "종료일"]);
        const nextAction = text(row.properties, ["다음 행동"]);
        const proposedProducts = text(row.properties, ["제안제품"]);
        engagements.push({
          id: id("engagement", snapshot.workspaceId, legacySourceId),
          workspaceId: snapshot.workspaceId,
          legacySourceId,
          provenance,
          ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
          projectKey: key,
          name,
          stage,
          ...(engagementType ? { engagementType } : {}),
          ...(stageLabel ? { sourceStage: stageLabel } : {}),
          ...(priority !== undefined ? { priority } : {}),
          ...(startDate !== undefined ? { startDate } : {}),
          ...(targetDate !== undefined ? { targetDate } : {}),
          ...(nextAction !== undefined ? { nextAction } : {}),
          ...(proposedProducts !== undefined ? { proposedProducts } : {}),
          ...(proposed !== undefined ? { proposedAmountKrw: proposed.toString() } : {}),
          parties,
          artifactRefs: {
            quote: stringArray(row.properties, ["견적서"]),
            proposal: stringArray(row.properties, ["제안서"]),
            contract: stringArray(row.properties, ["계약서"]),
            completion: stringArray(row.properties, ["완료보고서"]),
          },
        });
      } catch (error) {
        const reason = error instanceof NotionCwosImportError ? error.code as QuarantineReason : "MISSING_REQUIRED_FIELD";
        quarantine("engagement", row, [reason], error instanceof Error ? error.message : "project mapping failed");
      }
    }

    for (const row of snapshot.activities) {
      try {
        const legacySourceId = sourceId(row);
        const projectIds = stringArray(row.properties, ["프로젝트", "projectSourceIds"]);
        let accountIds = stringArray(row.properties, ["고객·파트너", "accountSourceIds"]);
        const accountActivity = rules.accountActivity ? overrides?.accountActivities[legacySourceId] : undefined;
        if (projectIds.length === 0) {
          if (!accountActivity || !accountSourceIds.has(accountActivity.accountSourceId)) {
            quarantine("activity", row, ["ORPHAN_ACTIVITY"], "activity has no project relation; cwos_activities.engagement_id is required");
            continue;
          }
          if (!accountIds.includes(accountActivity.accountSourceId)) accountIds = [accountActivity.accountSourceId, ...accountIds];
        }
        const unknownProjects = projectIds.filter((relation) => !projectSourceIds.has(relation));
        const unknownAccounts = accountIds.filter((relation) => !accountSourceIds.has(relation));
        if (unknownProjects.length + unknownAccounts.length > 0) {
          orphanRelations += unknownProjects.length + unknownAccounts.length;
          quarantine("activity", row, ["UNKNOWN_RELATION"], "activity references unknown account or project");
          continue;
        }
        const summary = text(row.properties, ["요약", "활동명", "내용"]);
        const occurredAt = text(row.properties, ["date:활동일:start", "활동일", "일시"]);
        const typeLabel = text(row.properties, ["유형", "활동 유형"]);
        if (!summary || !occurredAt || !typeLabel) {
          quarantine("activity", row, ["MISSING_REQUIRED_FIELD"], "activity summary, date or 유형 is missing");
          continue;
        }
        const activityType = ACTIVITY_TYPES.get(typeLabel);
        if (!activityType) {
          quarantine("activity", row, ["UNMAPPED_ACTIVITY_TYPE"], `activity 유형 ${typeLabel} has no cwos_activities type`);
          continue;
        }
        const provenance = provenanceOf(row.properties);
        const decision = text(row.properties, ["결정사항"]);
        const nextAction = text(row.properties, ["다음 행동"]);
        const nextContactDate = dateValue(row.properties, ["date:다음 연락일:start", "다음 연락일"]);
        activities.push({
          id: id("activity", snapshot.workspaceId, legacySourceId),
          workspaceId: snapshot.workspaceId,
          legacySourceId,
          provenance,
          ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
          activityType,
          occurredAt,
          summary,
          ...(decision !== undefined ? { decision } : {}),
          ...(nextAction !== undefined ? { nextAction } : {}),
          ...(nextContactDate !== undefined ? { nextContactDate } : {}),
          accountSourceIds: accountIds,
          projectSourceIds: projectIds,
          attachmentRefs: stringArray(row.properties, ["첨부"]),
        });
      } catch (error) {
        quarantine("activity", row, ["MISSING_REQUIRED_FIELD"], error instanceof Error ? error.message : "activity mapping failed");
      }
    }

    for (const row of snapshot.finance) {
      try {
        const legacySourceId = sourceId(row);
        const kind = text(row.properties, ["구분", "유형"]);
        if (!kind) {
          quarantine("financial_item", row, ["MISSING_REQUIRED_FIELD"], "finance 구분 is missing");
          continue;
        }
        if (PRICE_LEDGER_KINDS.has(kind)) {
          outOfScope.push({ entity: "financial_item", sourceId: legacySourceId, bucket: "price_ledger", sourceKind: kind });
          continue;
        }
        const direction = FINANCE_DIRECTIONS.get(kind);
        if (!direction) {
          quarantine("financial_item", row, ["UNMAPPED_FINANCE_KIND"], `finance 구분 ${kind} is not 매출/매입/기타입금/기타출금`);
          continue;
        }
        const name = text(row.properties, ["거래명", "제목", "Name"]) ?? legacySourceId;
        const projectRelations = stringArray(row.properties, ["프로젝트", "projectSourceIds"]);
        const accountRelations = stringArray(row.properties, ["거래처", "accountSourceIds"]);
        const category = financeCategory(direction, name);
        const listedForUnassigned = rules.unassignedFinance && overrides?.unassignedFinance.includes(legacySourceId) === true;
        let engagementSourceId = projectRelations[0] ?? null;
        let unassigned = false;
        if (engagementSourceId === null) {
          if (!listedForUnassigned) {
            orphanRelations += 1;
            quarantine("financial_item", row, ["ORPHAN_FINANCE"], "project financial item has no project relation");
            continue;
          }
          unassigned = true;
        } else if (!projectSourceIds.has(engagementSourceId)) {
          if (!listedForUnassigned) {
            orphanRelations += 1;
            quarantine("financial_item", row, ["UNKNOWN_RELATION"], "financial item references unknown project");
            continue;
          }
          engagementSourceId = null;
          unassigned = true;
        }
        const counterpartyOverride = rules.counterparty ? overrides?.counterparties[legacySourceId] : undefined;
        const listedAccountSourceId = accountRelations[0] ?? (counterpartyOverride && !accountRelations[0] ? counterpartyOverride.accountSourceId : undefined);
        if (listedAccountSourceId && !accountSourceIds.has(listedAccountSourceId)) {
          orphanRelations += 1;
          quarantine("financial_item", row, ["UNKNOWN_RELATION"], "financial item references unknown account");
          continue;
        }
        const projectPartyName = direction === "IN" ? "매출처" : "매입처";
        const projectParties = engagementSourceId
          ? [...new Set(projectCounterparties.get(engagementSourceId)?.[direction === "IN" ? "billed" : "suppliers"] ?? [])]
          : [];
        const accountSourceId = listedAccountSourceId ?? (projectParties.length === 1 ? projectParties[0] : undefined);
        if (!accountSourceId) {
          quarantine("financial_item", row, ["MISSING_REQUIRED_FIELD"], `financial item has no 거래처 and its project has ${projectParties.length} ${projectPartyName}; cwos_financial_items.account_id is required`);
          continue;
        }
        const net = integerMoney(row.properties, ["금액", "공급가액"]);
        if (net === undefined || net < 0n) {
          quarantine("financial_item", row, ["INVALID_AMOUNT"], "financial net amount is missing or negative");
          continue;
        }
        const vat = integerMoney(row.properties, ["부가세"]) ?? 0n;
        const suppliedGross = integerMoney(row.properties, ["합계", "합계금액"]);
        const gross = suppliedGross ?? net + vat;
        if (net + vat !== gross) {
          quarantine("financial_item", row, ["VAT_MISMATCH"], "gross amount does not equal net plus VAT");
          continue;
        }
        const statusLabel = text(row.properties, ["상태"]);
        if (!statusLabel) {
          quarantine("financial_item", row, ["MISSING_REQUIRED_FIELD"], "finance 상태 is missing");
          continue;
        }
        const statusLifecycle = FINANCE_LIFECYCLES.get(statusLabel);
        if (!statusLifecycle) {
          quarantine("financial_item", row, ["UNMAPPED_FINANCE_STATUS"], `finance 상태 ${statusLabel} has no lifecycle`);
          continue;
        }
        if ((statusLabel === "입금완료" && direction !== "IN") || (statusLabel === "출금완료" && direction !== "OUT")) {
          quarantine("financial_item", row, ["FINANCE_STATUS_CONFLICT"], `finance 상태 ${statusLabel} contradicts 구분 ${kind}`);
          continue;
        }
        const settledByCheckbox = booleanValue(row.properties, [direction === "IN" ? "입금처리여부" : "출금처리여부"]);
        const lifecycle = settledByCheckbox ? "SETTLED" : statusLifecycle;
        const plannedDate = direction === "IN"
          ? dateValue(row.properties, ["date:예상 입금일:start", "예상 입금일"])
          : dateValue(row.properties, ["date:예상 출금일:start", "예상 출금일"]);
        const actualDate = dateValue(row.properties, ["date:실제 처리일:start", "실제 처리일"]);
        const settledByStatus = statusLabel === "입금완료" || statusLabel === "출금완료";
        const plannedOrActual = plannedDate ?? (settledByStatus ? actualDate : undefined);
        const nullDateAllowed = rules.nullExpectedDate && overrides?.nullExpectedDate.includes(legacySourceId) === true;
        const expectedDate = plannedOrActual ?? (nullDateAllowed || unassigned ? null : undefined);
        if (expectedDate === undefined) {
          quarantine("financial_item", row, ["MISSING_REQUIRED_FIELD"], `finance ${direction === "IN" ? "예상 입금일" : "예상 출금일"} is missing${settledByStatus ? " and 실제 처리일 is missing" : ""}; cwos_financial_items.expected_date is required`);
          continue;
        }
        const evidenceLabel = text(row.properties, ["증거 상태"]);
        const evidenceStatus = evidenceLabel === undefined ? undefined : FINANCE_EVIDENCE_STATUSES.get(evidenceLabel);
        if (evidenceLabel !== undefined && !evidenceStatus) {
          quarantine("financial_item", row, ["UNMAPPED_EVIDENCE_STATUS"], `finance 증거 상태 ${evidenceLabel} is unknown`);
          continue;
        }
        const projectMappingStatus = text(row.properties, ["프로젝트 매핑 상태"]);
        const provenance: NotionFinanceProvenance = {
          ...provenanceOf(row.properties),
          ...(evidenceStatus ? { evidenceStatus } : {}),
          ...(unassigned ? { projectMappingStatus: "unassigned" } : projectMappingStatus !== undefined ? { projectMappingStatus } : {}),
          ...(plannedDate === undefined && expectedDate !== null ? { expectedDateSource: "actual_date" as const } : {}),
          ...(accountRelations[0] === undefined && counterpartyOverride
            ? { accountSource: "owner_override" as const }
            : accountRelations[0] === undefined ? { accountSource: "project_party" as const } : {}),
        };
        const fingerprint = notionCwosHash({ direction, name, net: net.toString(), vat: vat.toString(), expectedDate, actualDate, engagementSourceId, accountSourceId });
        if (financeFingerprints.has(fingerprint)) {
          duplicateCandidates += 1;
          quarantine("financial_item", row, ["DUPLICATE_FINANCE"], "duplicate financial source/date/amount/memo candidate");
          continue;
        }
        financeFingerprints.add(fingerprint);
        financialItems.push({
          id: id("financial", snapshot.workspaceId, legacySourceId),
          workspaceId: snapshot.workspaceId,
          legacySourceId,
          provenance,
          ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
          engagementSourceId,
          accountSourceId,
          direction,
          category,
          lifecycle,
          netAmountKrw: net.toString(),
          vatAmountKrw: vat.toString(),
          grossAmountKrw: gross.toString(),
          expectedDate,
          ...(unassigned ? { importAssignment: "unassigned" as const } : {}),
          ...(actualDate ? { actualDate } : {}),
          evidenceRefs: stringArray(row.properties, ["증빙"]),
          sourceFingerprint: fingerprint,
        });
      } catch (error) {
        const reason = error instanceof NotionCwosImportError ? error.code as QuarantineReason : "INVALID_AMOUNT";
        quarantine("financial_item", row, [reason], error instanceof Error ? error.message : "finance mapping failed");
      }
    }

    const sums = financialItems.reduce(
      (current, item) => {
        const target = item.direction === "IN" ? current.inbound : current.outbound;
        target.net += BigInt(item.netAmountKrw);
        target.vat += BigInt(item.vatAmountKrw);
        target.gross += BigInt(item.grossAmountKrw);
        return current;
      },
      { inbound: { net: 0n, vat: 0n, gross: 0n }, outbound: { net: 0n, vat: 0n, gross: 0n } },
    );

    const reconciliation: NotionCwosReconciliation = {
      source: { accounts: snapshot.accounts.length, projects: snapshot.projects.length, activities: snapshot.activities.length, finance: snapshot.finance.length },
      imported: { accounts: accounts.length, engagements: engagements.length, activities: activities.length, financialItems: financialItems.length },
      quarantined: quarantined.length,
      outOfScope: { priceLedger: outOfScope.filter((row) => row.bucket === "price_ledger").length },
      finance: {
        inboundNetKrw: sums.inbound.net.toString(),
        inboundVatKrw: sums.inbound.vat.toString(),
        inboundGrossKrw: sums.inbound.gross.toString(),
        outboundNetKrw: sums.outbound.net.toString(),
        outboundVatKrw: sums.outbound.vat.toString(),
        outboundGrossKrw: sums.outbound.gross.toString(),
      },
      orphanRelations,
      duplicateCandidates,
    };

    const planCore = { workspaceId: snapshot.workspaceId, snapshotId: snapshot.snapshotId, snapshotHash: snapshot.snapshotHash, accounts, engagements, activities, financialItems, quarantined, outOfScope, reconciliation };
    return { ...planCore, capturedAt: snapshot.capturedAt, planHash: notionCwosHash(planCore), readOnlySource: true };
  }
}
