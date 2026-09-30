import { describe, expect, it } from "vitest";
import { NotionCwosImportError, NotionCwosImportPlanner, notionCwosHash, type NotionCwosSnapshot, type NotionSourceRow } from "../src/notion-cwos.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";

function snapshot(): NotionCwosSnapshot {
  return {
    workspaceId: WORKSPACE,
    snapshotId: "snapshot-1",
    snapshotHash: "sha256:snapshot",
    capturedAt: "2026-08-14T00:00:00Z",
    accounts: [
      { sourceId: "account-customer", properties: { "회사/조직명": "선진엔지니어링", 구분: "고객", 관계상태: "활성", 담당자: "홍길동", "대표 이메일": "hong@example.com", "대표 연락처": "02-000-0000", 자연키: "ACC-CUSTOMER", 근거등급: "T1", 확신도: "높음" } },
      { sourceId: "account-vendor", properties: { "회사/조직명": "총판 A", 구분: "파트너", 관계상태: "활성" } },
      { sourceId: "account-si", properties: { "회사/조직명": "원청 SI", 구분: "고객" } },
      { sourceId: "account-maker", properties: { "회사/조직명": "제조사 M", 구분: "제조사" } },
      { sourceId: "account-etc", properties: { "회사/조직명": "기타 조직", 구분: "기타" } },
    ],
    projects: [
      {
        sourceId: "project-1",
        properties: {
          프로젝트명: "선진엔지니어링 HCI 구축",
          프로젝트ID: "PRJ-2026-001",
          자연키: "PRJ-NK-001",
          근거등급: "T2",
          확신도: "중간",
          상태: "진행",
          거래처: "선진엔지니어링",
          "프로젝트 단계": "수행/검수",
          중요도: "높음",
          "고객·파트너": ["account-customer"],
          매출처: ["account-customer"],
          최종고객: ["account-customer"],
          매입처: ["account-vendor"],
          파트너: ["account-vendor"],
          "다음 행동": "수정 견적 전달",
          제안제품: "HCI",
          제안금액: 100000000,
          견적서: ["file://quote"],
          제안서: ["file://proposal"],
        },
      },
    ],
    activities: [
      {
        sourceId: "activity-1",
        properties: {
          활동명: "고객 미팅",
          유형: "미팅",
          자연키: "ACT-NK-001",
          근거등급: "T0",
          확신도: "높음",
          활동일: "2026-08-14T01:00:00Z",
          요약: "HCI 교체 요구 확인",
          결정사항: "10월 검수",
          "다음 행동": "검수 일정 확정",
          프로젝트: ["project-1"],
          "고객·파트너": ["account-customer"],
        },
      },
    ],
    finance: [
      {
        sourceId: "finance-in",
        properties: {
          거래명: "HCI 구축 매출",
          구분: "매출",
          금액: 100000000,
          부가세: 10000000,
          상태: "청구",
          "증거 상태": "교차확인",
          "프로젝트 매핑 상태": "확정",
          자연키: "FIN-NK-IN",
          "원천 revision": "rev-7",
          근거등급: "T1",
          확신도: "높음",
          프로젝트: ["project-1"],
          거래처: ["account-customer"],
          "예상 입금일": "2026-10-31",
          입금처리여부: "__NO__",
          증빙: ["file://invoice"],
        },
      },
      {
        sourceId: "finance-out",
        properties: {
          거래명: "HCI 장비 매입",
          구분: "매입",
          금액: 60000000,
          부가세: 6000000,
          상태: "예정",
          "증거 상태": "미확인",
          "프로젝트 매핑 상태": "후보",
          프로젝트: ["project-1"],
          거래처: ["account-vendor"],
          "예상 출금일": "2026-09-30",
          출금처리여부: false,
        },
      },
    ],
  };
}

function projectRow(sourceId: string, projectKey: string, properties: Record<string, unknown>): NotionSourceRow {
  return { sourceId, properties: { 프로젝트명: `프로젝트 ${projectKey}`, 프로젝트ID: projectKey, 최종고객: ["account-customer"], ...properties } };
}

function financeRow(sourceId: string, properties: Record<string, unknown>): NotionSourceRow {
  return {
    sourceId,
    properties: {
      거래명: `거래 ${sourceId}`,
      구분: "매출",
      금액: 100,
      부가세: 10,
      상태: "예정",
      프로젝트: ["project-1"],
      거래처: ["account-customer"],
      "예상 입금일": "2026-11-30",
      ...properties,
    },
  };
}

function reasonsOf(plan: ReturnType<NotionCwosImportPlanner["plan"]>, sourceId: string): string[] | undefined {
  return plan.quarantined.find((item) => item.sourceId === sourceId)?.reasons;
}

function rejectionCode(input: NotionCwosSnapshot): string | undefined {
  try {
    new NotionCwosImportPlanner().plan(input);
    return undefined;
  } catch (error) {
    return error instanceof NotionCwosImportError ? error.code : "UNEXPECTED";
  }
}

describe("NotionCwosImportPlanner", () => {
  it("maps the four Notion operational databases into a deterministic read-only plan", () => {
    const planner = new NotionCwosImportPlanner();
    const first = planner.plan(snapshot());
    const second = planner.plan(snapshot());

    expect(first.readOnlySource).toBe(true);
    expect(first.planHash).toBe(second.planHash);
    expect(first.accounts).toHaveLength(5);
    expect(first.engagements).toHaveLength(1);
    expect(first.activities).toHaveLength(1);
    expect(first.financialItems).toHaveLength(2);
    expect(first.engagements[0]?.projectKey).toBe("PRJ-2026-001");
    expect(first.financialItems[0]?.engagementSourceId).toBe("project-1");
    expect(first.reconciliation.finance.inboundGrossKrw).toBe("110000000");
    expect(first.reconciliation.finance.outboundGrossKrw).toBe("66000000");
    expect(first.reconciliation.quarantined).toBe(0);
  });

  it("quarantines expense rows mixed into projects and missing project keys", () => {
    const input = snapshot();
    input.projects.push(
      { sourceId: "expense-project", properties: { 프로젝트명: "2월 카드사용료" } },
      { sourceId: "missing-key", properties: { 프로젝트명: "정상 고객 구축", "프로젝트 단계": "제안/견적", "고객·파트너": ["account-customer"] } },
    );
    const plan = new NotionCwosImportPlanner().plan(input);
    expect(reasonsOf(plan, "expense-project")).toContain("MIXED_EXPENSE_PROJECT");
    expect(reasonsOf(plan, "missing-key")).toContain("MISSING_PROJECT_KEY");
    expect(plan.engagements).toHaveLength(1);
  });

  it("quarantines duplicate accounts, duplicate project keys and unknown relations", () => {
    const input = snapshot();
    input.accounts.push({ sourceId: "duplicate-account", properties: { "회사/조직명": "  선진엔지니어링  ", 구분: "고객" } });
    input.projects.push({ sourceId: "duplicate-project", properties: { 프로젝트명: "다른 이름", 프로젝트ID: "PRJ-2026-001", "고객·파트너": ["account-customer"] } });
    input.activities.push({ sourceId: "unknown-activity", properties: { 활동명: "미팅", 활동일: "2026-08-15", 요약: "알 수 없는 고객", 프로젝트: ["missing-project"] } });
    const plan = new NotionCwosImportPlanner().plan(input);
    expect(plan.quarantined.some((item) => item.reasons.includes("DUPLICATE_ACCOUNT"))).toBe(true);
    expect(plan.quarantined.some((item) => item.reasons.includes("DUPLICATE_PROJECT_KEY"))).toBe(true);
    expect(plan.quarantined.some((item) => item.reasons.includes("UNKNOWN_RELATION"))).toBe(true);
    expect(plan.reconciliation.duplicateCandidates).toBe(2);
    expect(plan.reconciliation.orphanRelations).toBe(1);
  });

  it("quarantines orphan project finance, invalid VAT and duplicate transactions", () => {
    const input = snapshot();
    input.finance.push(
      { sourceId: "orphan", properties: { 거래명: "장비 매입", 구분: "매입", 금액: 100, 부가세: 10, 합계: 110, 거래처: ["account-vendor"] } },
      { sourceId: "bad-vat", properties: { 거래명: "추가 매출", 구분: "매출", 금액: 100, 부가세: 10, 합계: 109, 프로젝트: ["project-1"], 거래처: ["account-customer"] } },
      { sourceId: "duplicate", properties: { ...input.finance[0]!.properties } },
    );
    const plan = new NotionCwosImportPlanner().plan(input);
    expect(reasonsOf(plan, "orphan")).toContain("ORPHAN_FINANCE");
    expect(reasonsOf(plan, "bad-vat")).toContain("VAT_MISMATCH");
    expect(reasonsOf(plan, "duplicate")).toContain("DUPLICATE_FINANCE");
    expect(plan.financialItems).toHaveLength(2);
  });

  it("reads only 프로젝트 단계 and maps the owner's nine stage values without a default", () => {
    const input = snapshot();
    const expected: Array<[string, string]> = [
      ["제안/견적", "PROPOSAL"],
      ["고객발주", "CONTRACTED"],
      ["매입발주", "DELIVERY"],
      ["수행/검수", "DELIVERY"],
      ["청구/수금", "BILLING"],
      ["완료", "CLOSED"],
      ["보류", "ON_HOLD"],
      ["실패", "LOST"],
    ];
    expected.forEach(([stage], index) => input.projects.push(projectRow(`stage-${index}`, `PRJ-STAGE-${index}`, { 상태: "진행", "프로젝트 단계": stage })));
    input.projects.push(
      projectRow("stage-unclassified", "PRJ-STAGE-U", { "프로젝트 단계": "미분류" }),
      projectRow("stage-unknown", "PRJ-STAGE-X", { "프로젝트 단계": "협상" }),
      projectRow("stage-status-only", "PRJ-STAGE-S", { 상태: "완료" }),
    );
    const plan = new NotionCwosImportPlanner().plan(input);
    expected.forEach(([label, stage], index) => {
      const engagement = plan.engagements.find((item) => item.legacySourceId === `stage-${index}`);
      expect(engagement?.stage).toBe(stage);
      expect(engagement?.sourceStage).toBe(label);
    });
    expect(reasonsOf(plan, "stage-unclassified")).toEqual(["UNMAPPED_STAGE"]);
    expect(reasonsOf(plan, "stage-unknown")).toEqual(["UNMAPPED_STAGE"]);
    expect(reasonsOf(plan, "stage-status-only")).toEqual(["MISSING_REQUIRED_FIELD"]);
    expect(plan.engagements.some((item) => item.stage === "INQUIRY")).toBe(false);
  });

  it("maps activity types onto the cwos_activities CHECK values and quarantines the rest", () => {
    const input = snapshot();
    const expected: Array<[string, string]> = [
      ["메일 수신", "email_in"],
      ["메일 발신", "email_out"],
      ["전화", "call"],
      ["미팅", "meeting"],
      ["메신저", "message"],
      ["결정", "decision"],
      ["메모", "note"],
    ];
    const base = { 활동일: "2026-08-20", 요약: "요약", 프로젝트: ["project-1"] };
    expected.forEach(([type], index) => input.activities.push({ sourceId: `type-${index}`, properties: { ...base, 유형: type } }));
    input.activities.push(
      { sourceId: "type-unknown", properties: { ...base, 유형: "방문" } },
      { sourceId: "type-missing", properties: { ...base } },
      { sourceId: "account-only", properties: { 유형: "전화", 활동일: "2026-08-20", 요약: "계정만 연결", "고객·파트너": ["account-customer"] } },
    );
    const plan = new NotionCwosImportPlanner().plan(input);
    expected.forEach(([, type], index) => {
      expect(plan.activities.find((item) => item.legacySourceId === `type-${index}`)?.activityType).toBe(type);
    });
    expect(reasonsOf(plan, "type-unknown")).toEqual(["UNMAPPED_ACTIVITY_TYPE"]);
    expect(reasonsOf(plan, "type-missing")).toEqual(["MISSING_REQUIRED_FIELD"]);
    expect(reasonsOf(plan, "account-only")).toEqual(["ORPHAN_ACTIVITY"]);
  });

  it("reads 매출처, 최종고객, 매입처 and 파트너 as engagement party roles", () => {
    const input = snapshot();
    input.projects.push(
      projectRow("indirect", "PRJ-INDIRECT", {
        "프로젝트 단계": "고객발주",
        매출처: ["account-si"],
        최종고객: ["account-customer"],
        매입처: ["account-vendor"],
        파트너: ["account-vendor"],
        "고객·파트너": ["account-customer", "account-maker"],
      }),
      projectRow("billed-only", "PRJ-BILLED", { "프로젝트 단계": "제안/견적", 최종고객: [], 매출처: ["account-si"] }),
      projectRow("generic-other", "PRJ-OTHER", { "프로젝트 단계": "제안/견적", "고객·파트너": ["account-etc"] }),
    );
    const plan = new NotionCwosImportPlanner().plan(input);
    const parties = (source: string) => plan.engagements.find((item) => item.legacySourceId === source)?.parties.map((party) => ({ account: party.accountSourceId, role: party.role, primary: party.primary, commercial: party.commercialResponsibility, delivery: party.deliveryResponsibility }));

    expect(parties("project-1")).toEqual([
      { account: "account-customer", role: "customer", primary: true, commercial: true, delivery: false },
      { account: "account-vendor", role: "vendor", primary: true, commercial: true, delivery: false },
      { account: "account-vendor", role: "partner", primary: true, commercial: false, delivery: true },
    ]);
    expect(parties("indirect")).toEqual([
      { account: "account-customer", role: "customer", primary: true, commercial: false, delivery: false },
      { account: "account-si", role: "prime_contractor", primary: true, commercial: true, delivery: false },
      { account: "account-vendor", role: "vendor", primary: true, commercial: true, delivery: false },
      { account: "account-vendor", role: "partner", primary: true, commercial: false, delivery: true },
      { account: "account-maker", role: "manufacturer", primary: true, commercial: false, delivery: false },
    ]);
    expect(parties("billed-only")).toEqual([{ account: "account-si", role: "customer", primary: true, commercial: true, delivery: false }]);
    expect(reasonsOf(plan, "generic-other")).toEqual(["UNMAPPED_PARTY_ROLE"]);
  });

  it("maps finance 구분, 상태 and 증거 상태 strictly and quarantines unknown or missing values", () => {
    const input = snapshot();
    input.projects.push(projectRow("two-billed", "PRJ-TWO-BILLED", { "프로젝트 단계": "청구/수금", 매출처: ["account-customer", "account-si"] }));
    input.finance.push(
      financeRow("settled-in", { 상태: "입금완료", "증거 상태": "은행확인", "실제 처리일": "2026-11-29" }),
      financeRow("settled-out", { 구분: "매입", 상태: "출금완료", 거래처: ["account-vendor"], "예상 입금일": undefined, "예상 출금일": "2026-11-15" }),
      financeRow("overdue", { 상태: "연체", "증거 상태": "WEHAGO확인" }),
      financeRow("partial", { 상태: "부분처리", "증거 상태": "사용자확인" }),
      financeRow("unknown-kind", { 구분: "환불" }),
      financeRow("missing-kind", { 구분: undefined }),
      financeRow("unknown-status", { 상태: "보류" }),
      financeRow("missing-status", { 상태: undefined }),
      financeRow("status-conflict", { 상태: "출금완료" }),
      financeRow("unknown-evidence", { "증거 상태": "추정" }),
      financeRow("missing-account", { 거래처: [], 프로젝트: ["two-billed"] }),
      financeRow("missing-expected", { "예상 입금일": undefined }),
    );
    const plan = new NotionCwosImportPlanner().plan(input);
    const item = (source: string) => plan.financialItems.find((row) => row.legacySourceId === source);

    expect(item("finance-in")).toMatchObject({ direction: "IN", lifecycle: "BILLED", provenance: { evidenceStatus: "cross_confirmed" } });
    expect(item("finance-out")).toMatchObject({ direction: "OUT", lifecycle: "PLANNED", provenance: { evidenceStatus: "unverified" } });
    expect(item("settled-in")).toMatchObject({ direction: "IN", lifecycle: "SETTLED", provenance: { evidenceStatus: "bank_confirmed" }, actualDate: "2026-11-29" });
    expect(item("settled-out")).toMatchObject({ direction: "OUT", lifecycle: "SETTLED", expectedDate: "2026-11-15" });
    expect(item("overdue")).toMatchObject({ lifecycle: "OVERDUE", provenance: { evidenceStatus: "wehago_confirmed" } });
    expect(item("partial")).toMatchObject({ lifecycle: "PARTIAL", provenance: { evidenceStatus: "user_confirmed" } });
    expect(reasonsOf(plan, "unknown-kind")).toEqual(["UNMAPPED_FINANCE_KIND"]);
    expect(reasonsOf(plan, "missing-kind")).toEqual(["MISSING_REQUIRED_FIELD"]);
    expect(reasonsOf(plan, "unknown-status")).toEqual(["UNMAPPED_FINANCE_STATUS"]);
    expect(reasonsOf(plan, "missing-status")).toEqual(["MISSING_REQUIRED_FIELD"]);
    expect(reasonsOf(plan, "status-conflict")).toEqual(["FINANCE_STATUS_CONFLICT"]);
    expect(reasonsOf(plan, "unknown-evidence")).toEqual(["UNMAPPED_EVIDENCE_STATUS"]);
    expect(reasonsOf(plan, "missing-account")).toEqual(["MISSING_REQUIRED_FIELD"]);
    expect(reasonsOf(plan, "missing-expected")).toEqual(["MISSING_REQUIRED_FIELD"]);
  });

  it("moves 기타입금/기타출금 rows into the price_ledger out-of-scope bucket instead of quarantine", () => {
    const input = snapshot();
    input.finance.push(
      financeRow("other-in", { 구분: "기타입금", 상태: "입금완료", 프로젝트: [], 거래처: [], "예상 입금일": undefined, "실제 처리일": "2026-11-01" }),
      financeRow("other-out", { 구분: "기타출금", 상태: "출금완료", 프로젝트: ["project-1"], "예상 입금일": undefined }),
    );
    const plan = new NotionCwosImportPlanner().plan(input);
    expect(plan.outOfScope).toEqual([
      { entity: "financial_item", sourceId: "other-in", bucket: "price_ledger", sourceKind: "기타입금" },
      { entity: "financial_item", sourceId: "other-out", bucket: "price_ledger", sourceKind: "기타출금" },
    ]);
    expect(reasonsOf(plan, "other-in")).toBeUndefined();
    expect(reasonsOf(plan, "other-out")).toBeUndefined();
    expect(plan.financialItems.map((item) => item.legacySourceId)).toEqual(["finance-in", "finance-out"]);
    expect(plan.reconciliation.outOfScope).toEqual({ priceLedger: 2 });
    expect(plan.reconciliation.source.finance).toBe(4);
    expect(plan.reconciliation.quarantined).toBe(0);
  });

  it("uses 실제 처리일 as expected_date only for 입금완료/출금완료 rows and marks the source", () => {
    const input = snapshot();
    input.finance.push(
      financeRow("settled-in-actual", { 상태: "입금완료", "예상 입금일": undefined, "실제 처리일": "2026-10-02" }),
      financeRow("settled-out-actual", { 구분: "매입", 상태: "출금완료", 거래처: ["account-vendor"], "예상 입금일": undefined, "실제 처리일": "2026-10-03" }),
      financeRow("settled-no-dates", { 상태: "입금완료", "예상 입금일": undefined }),
      financeRow("billed-actual-only", { 상태: "청구", "예상 입금일": undefined, "실제 처리일": "2026-10-04" }),
    );
    const plan = new NotionCwosImportPlanner().plan(input);
    const item = (source: string) => plan.financialItems.find((row) => row.legacySourceId === source);
    expect(item("settled-in-actual")).toMatchObject({ lifecycle: "SETTLED", expectedDate: "2026-10-02", actualDate: "2026-10-02", provenance: { expectedDateSource: "actual_date" } });
    expect(item("settled-out-actual")).toMatchObject({ direction: "OUT", lifecycle: "SETTLED", expectedDate: "2026-10-03", provenance: { expectedDateSource: "actual_date" } });
    expect(item("finance-in")?.provenance).not.toHaveProperty("expectedDateSource");
    expect(reasonsOf(plan, "settled-no-dates")).toEqual(["MISSING_REQUIRED_FIELD"]);
    expect(reasonsOf(plan, "billed-actual-only")).toEqual(["MISSING_REQUIRED_FIELD"]);
  });

  it("derives a missing 거래처 from exactly one project 매출처/매입처 and marks the source", () => {
    const input = snapshot();
    input.projects.push(
      projectRow("two-billed", "PRJ-TWO-BILLED", { "프로젝트 단계": "청구/수금", 매출처: ["account-customer", "account-si"], 매입처: ["account-vendor"] }),
      projectRow("no-supplier", "PRJ-NO-SUPPLIER", { "프로젝트 단계": "고객발주", 매출처: ["account-si"] }),
    );
    input.finance.push(
      financeRow("derived-in", { 거래처: [] }),
      financeRow("derived-out", { 구분: "매입", 거래처: [], "예상 입금일": undefined, "예상 출금일": "2026-12-01" }),
      financeRow("ambiguous-in", { 거래처: [], 프로젝트: ["two-billed"] }),
      financeRow("derived-out-two-billed", { 구분: "매입", 거래처: [], 프로젝트: ["two-billed"], "예상 입금일": undefined, "예상 출금일": "2026-12-02" }),
      financeRow("no-supplier-out", { 구분: "매입", 거래처: [], 프로젝트: ["no-supplier"], "예상 입금일": undefined, "예상 출금일": "2026-12-03" }),
      financeRow("no-project", { 구분: "매출", 거래처: [], 프로젝트: [] }),
    );
    const plan = new NotionCwosImportPlanner().plan(input);
    const item = (source: string) => plan.financialItems.find((row) => row.legacySourceId === source);
    expect(item("derived-in")).toMatchObject({ accountSourceId: "account-customer", provenance: { accountSource: "project_party" } });
    expect(item("derived-out")).toMatchObject({ accountSourceId: "account-vendor", provenance: { accountSource: "project_party" } });
    expect(item("derived-out-two-billed")).toMatchObject({ accountSourceId: "account-vendor", provenance: { accountSource: "project_party" } });
    expect(item("finance-in")?.provenance).not.toHaveProperty("accountSource");
    expect(reasonsOf(plan, "ambiguous-in")).toEqual(["MISSING_REQUIRED_FIELD"]);
    expect(reasonsOf(plan, "no-supplier-out")).toEqual(["MISSING_REQUIRED_FIELD"]);
    expect(reasonsOf(plan, "no-project")).toEqual(["ORPHAN_FINANCE"]);
  });

  it("rejects legacy money tables and the todo board on the snapshot path", () => {
    const withExtraTable = { ...snapshot(), receivables: [{ sourceId: "r-1", properties: {} }] } as NotionCwosSnapshot;
    expect(rejectionCode(withExtraTable)).toBe("FORBIDDEN_SOURCE_TABLE");

    const legacyRows: Array<[keyof Pick<NotionCwosSnapshot, "finance" | "projects">, NotionSourceRow]> = [
      ["finance", { sourceId: "receivable", properties: { 입금상태: "미수", 공급가액: 100, 입금액: 0, 프로젝트: ["project-1"] } }],
      ["finance", { sourceId: "cashflow", properties: { 거래처: "은행", 유형: "매출입금", 입금계좌: "법인통장", 금액: 100, 프로젝트: ["project-1"] } }],
      ["finance", { sourceId: "expense", properties: { 지출명: "장비", 매입처: "총판", 결재수단: "법인카드", 공급가액: 100, 납입여부: true } }],
      ["projects", { sourceId: "todo", properties: { 이름: "안건", 상태: "시작 전", 담당자: ["user"] } }],
    ];
    for (const [table, row] of legacyRows) {
      const input = snapshot();
      input[table].push(row);
      expect(rejectionCode(input), row.sourceId).toBe("FORBIDDEN_SOURCE_TABLE");
    }
  });

  it("preserves legacy source ids and Notion provenance on every imported record", () => {
    const plan = new NotionCwosImportPlanner().plan(snapshot());
    expect(plan.accounts.find((item) => item.legacySourceId === "account-customer")?.provenance).toEqual({ naturalKey: "ACC-CUSTOMER", evidenceGrade: "T1", confidence: "높음" });
    expect(plan.accounts.find((item) => item.legacySourceId === "account-vendor")?.provenance).toEqual({});
    expect(plan.engagements[0]).toMatchObject({ legacySourceId: "project-1", provenance: { naturalKey: "PRJ-NK-001", evidenceGrade: "T2", confidence: "중간" } });
    expect(plan.activities[0]).toMatchObject({ legacySourceId: "activity-1", provenance: { naturalKey: "ACT-NK-001", evidenceGrade: "T0", confidence: "높음" } });
    expect(plan.financialItems.find((item) => item.legacySourceId === "finance-in")?.provenance).toEqual({
      naturalKey: "FIN-NK-IN",
      sourceRevision: "rev-7",
      evidenceGrade: "T1",
      confidence: "높음",
      evidenceStatus: "cross_confirmed",
      projectMappingStatus: "확정",
    });
    expect(plan.financialItems.find((item) => item.legacySourceId === "finance-out")?.provenance).toEqual({ evidenceStatus: "unverified", projectMappingStatus: "후보" });
  });

  it("uses stable hashes independent of object key order", () => {
    expect(notionCwosHash({ a: 1, b: { c: 2 } })).toBe(notionCwosHash({ b: { c: 2 }, a: 1 }));
  });
});
