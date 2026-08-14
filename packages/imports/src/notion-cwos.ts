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
  | "UNKNOWN_RELATION";

export interface QuarantinedRow {
  entity: "account" | "engagement" | "activity" | "financial_item";
  sourceId: string;
  reasons: QuarantineReason[];
  message: string;
  rawFingerprint: string;
}

export interface AccountImportRecord {
  id: string;
  workspaceId: string;
  legacySourceId: string;
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

export interface EngagementImportRecord {
  id: string;
  workspaceId: string;
  legacySourceId: string;
  sourceUrl?: string;
  projectKey: string;
  name: string;
  stage: string;
  priority?: string;
  startDate?: string;
  targetDate?: string;
  nextAction?: string;
  proposedProducts?: string;
  proposedAmountKrw?: string;
  accountSourceIds: string[];
  partnerSourceIds: string[];
  artifactRefs: Record<string, string[]>;
}

export interface ActivityImportRecord {
  id: string;
  workspaceId: string;
  legacySourceId: string;
  sourceUrl?: string;
  activityType: string;
  occurredAt: string;
  summary: string;
  decision?: string;
  nextAction?: string;
  nextContactDate?: string;
  accountSourceIds: string[];
  projectSourceIds: string[];
  attachmentRefs: string[];
}

export interface FinancialItemImportRecord {
  id: string;
  workspaceId: string;
  legacySourceId: string;
  sourceUrl?: string;
  engagementSourceId: string | null;
  accountSourceId: string | null;
  direction: "IN" | "OUT";
  category: string;
  lifecycle: string;
  netAmountKrw: string;
  vatAmountKrw: string;
  grossAmountKrw: string;
  expectedDate?: string;
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
  reconciliation: NotionCwosReconciliation;
  readOnlySource: true;
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

function mapProjectStage(value: string | undefined): string {
  switch (value) {
    case "문의": return "INQUIRY";
    case "제안": return "PROPOSAL";
    case "협상": return "NEGOTIATION";
    case "계약": return "CONTRACTED";
    case "진행": return "DELIVERY";
    case "검수": return "ACCEPTANCE";
    case "수금": return "COLLECTION";
    case "완료": return "CLOSED";
    case "보류": return "ON_HOLD";
    case "실주": return "LOST";
    default: return "INQUIRY";
  }
}

function looksLikeExpenseProject(name: string, projectKey: string | undefined, accountRelations: string[]): boolean {
  const expensePattern = /(카드사용료|통신비|출장비|식비|숙박비|라이센스구매|라이선스구매|매입|비용|수수료)/i;
  return expensePattern.test(name) && !projectKey && accountRelations.length === 0;
}

function financeCategory(direction: "IN" | "OUT", kind: string | undefined, memo: string): string {
  if (direction === "IN") return kind === "기타입금" ? "other" : "contract_revenue";
  if (/라이[센선]스/i.test(memo)) return "license_cost";
  if (/장비|서버|스위치|방화벽|HCI/i.test(memo)) return "hardware_cost";
  if (/외주|설치/i.test(memo)) return "outsourcing_cost";
  if (/출장|숙박|교통/i.test(memo)) return "travel_cost";
  return kind === "기타출금" ? "overhead" : "other";
}

function financialLifecycle(kind: string | undefined, incomingDone: boolean, outgoingDone: boolean, state: string | undefined): string {
  if ((kind === "매출" || kind === "기타입금") && incomingDone) return "SETTLED";
  if ((kind === "매입" || kind === "기타출금") && outgoingDone) return "SETTLED";
  if (state === "연체") return "OVERDUE";
  if (state === "부분처리") return "PARTIAL";
  if (state === "청구") return "BILLED";
  if (kind === "매입") return "INCURRED";
  return "PLANNED";
}

export class NotionCwosImportPlanner {
  plan(snapshot: NotionCwosSnapshot): NotionCwosImportPlan {
    if (!snapshot.workspaceId.trim() || !snapshot.snapshotId.trim() || !snapshot.snapshotHash.trim()) {
      throw new NotionCwosImportError("INVALID_SNAPSHOT", "workspaceId, snapshotId and snapshotHash are required");
    }

    const quarantined: QuarantinedRow[] = [];
    const accounts: AccountImportRecord[] = [];
    const engagements: EngagementImportRecord[] = [];
    const activities: ActivityImportRecord[] = [];
    const financialItems: FinancialItemImportRecord[] = [];
    const accountSourceIds = new Set<string>();
    const projectSourceIds = new Set<string>();
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
        const primaryContactName = text(row.properties, ["담당자", "주요 담당자"]);
        const primaryEmail = text(row.properties, ["대표 이메일", "이메일"]);
        const primaryPhone = text(row.properties, ["대표 연락처", "전화", "연락처"]);
        const recentContactDate = dateValue(row.properties, ["date:최근 연락일:start", "최근 연락일"]);
        const nextContactDate = dateValue(row.properties, ["date:다음 연락일:start", "다음 연락일"]);
        accounts.push({
          id: id("account", snapshot.workspaceId, legacySourceId),
          workspaceId: snapshot.workspaceId,
          legacySourceId,
          ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
          name,
          normalizedName: normalized,
          kinds: classifyAccountKind(text(row.properties, ["구분", "유형"])),
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
        const key = text(row.properties, ["프로젝트ID", "프로젝트 ID", "Project Key"]);
        const accountIds = stringArray(row.properties, ["고객·파트너", "고객", "accountSourceIds"]);
        const partnerIds = stringArray(row.properties, ["파트너", "partnerSourceIds"]);
        if (looksLikeExpenseProject(name, key, accountIds)) {
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
        const unknownRelations = [...accountIds, ...partnerIds].filter((relation) => !accountSourceIds.has(relation));
        if (unknownRelations.length > 0) {
          orphanRelations += unknownRelations.length;
          quarantine("engagement", row, ["UNKNOWN_RELATION"], `unknown account relations: ${unknownRelations.join(", ")}`);
          continue;
        }
        projectKeys.set(key, legacySourceId);
        projectSourceIds.add(legacySourceId);
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
          ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
          projectKey: key,
          name,
          stage: mapProjectStage(text(row.properties, ["상태", "단계"])),
          ...(priority !== undefined ? { priority } : {}),
          ...(startDate !== undefined ? { startDate } : {}),
          ...(targetDate !== undefined ? { targetDate } : {}),
          ...(nextAction !== undefined ? { nextAction } : {}),
          ...(proposedProducts !== undefined ? { proposedProducts } : {}),
          ...(proposed !== undefined ? { proposedAmountKrw: proposed.toString() } : {}),
          accountSourceIds: accountIds,
          partnerSourceIds: partnerIds,
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
        const accountIds = stringArray(row.properties, ["고객·파트너", "accountSourceIds"]);
        if (projectIds.length === 0 && accountIds.length === 0) {
          quarantine("activity", row, ["ORPHAN_ACTIVITY"], "activity has no account or project relation");
          continue;
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
        if (!summary || !occurredAt) {
          quarantine("activity", row, ["MISSING_REQUIRED_FIELD"], "activity summary or date is missing");
          continue;
        }
        const decision = text(row.properties, ["결정사항"]);
        const nextAction = text(row.properties, ["다음 행동"]);
        const nextContactDate = dateValue(row.properties, ["date:다음 연락일:start", "다음 연락일"]);
        activities.push({
          id: id("activity", snapshot.workspaceId, legacySourceId),
          workspaceId: snapshot.workspaceId,
          legacySourceId,
          ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
          activityType: text(row.properties, ["유형", "활동 유형"]) ?? "메모",
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
        const direction: "IN" | "OUT" = kind === "매출" || kind === "기타입금" ? "IN" : "OUT";
        const name = text(row.properties, ["거래명", "제목", "Name"]) ?? legacySourceId;
        const projectRelations = stringArray(row.properties, ["프로젝트", "projectSourceIds"]);
        const accountRelations = stringArray(row.properties, ["거래처", "accountSourceIds"]);
        const category = financeCategory(direction, kind, name);
        const engagementSourceId = projectRelations[0] ?? null;
        if (engagementSourceId === null && category !== "overhead") {
          orphanRelations += 1;
          quarantine("financial_item", row, ["ORPHAN_FINANCE"], "project financial item has no project relation");
          continue;
        }
        if (engagementSourceId && !projectSourceIds.has(engagementSourceId)) {
          orphanRelations += 1;
          quarantine("financial_item", row, ["UNKNOWN_RELATION"], "financial item references unknown project");
          continue;
        }
        const accountSourceId = accountRelations[0] ?? null;
        if (accountSourceId && !accountSourceIds.has(accountSourceId)) {
          orphanRelations += 1;
          quarantine("financial_item", row, ["UNKNOWN_RELATION"], "financial item references unknown account");
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
        const expectedDate = direction === "IN"
          ? dateValue(row.properties, ["date:예상 입금일:start", "예상 입금일"])
          : dateValue(row.properties, ["date:예상 출금일:start", "예상 출금일"]);
        const actualDate = dateValue(row.properties, ["date:실제 처리일:start", "실제 처리일"]);
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
          ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
          engagementSourceId,
          accountSourceId,
          direction,
          category,
          lifecycle: financialLifecycle(kind, booleanValue(row.properties, ["입금처리여부"]), booleanValue(row.properties, ["출금처리여부"]), text(row.properties, ["상태"])),
          netAmountKrw: net.toString(),
          vatAmountKrw: vat.toString(),
          grossAmountKrw: gross.toString(),
          ...(expectedDate ? { expectedDate } : {}),
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

    const planCore = { workspaceId: snapshot.workspaceId, snapshotId: snapshot.snapshotId, snapshotHash: snapshot.snapshotHash, accounts, engagements, activities, financialItems, quarantined, reconciliation };
    return { ...planCore, capturedAt: snapshot.capturedAt, planHash: notionCwosHash(planCore), readOnlySource: true };
  }
}
