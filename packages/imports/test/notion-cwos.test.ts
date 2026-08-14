import { describe, expect, it } from "vitest";
import { NotionCwosImportPlanner, notionCwosHash, type NotionCwosSnapshot } from "../src/notion-cwos.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";

function snapshot(): NotionCwosSnapshot {
  return {
    workspaceId: WORKSPACE,
    snapshotId: "snapshot-1",
    snapshotHash: "sha256:snapshot",
    capturedAt: "2026-08-14T00:00:00Z",
    accounts: [
      { sourceId: "account-customer", properties: { "회사/조직명": "선진엔지니어링", 구분: "고객", 관계상태: "활성", 담당자: "홍길동", "대표 이메일": "hong@example.com" } },
      { sourceId: "account-vendor", properties: { "회사/조직명": "총판 A", 구분: "파트너", 관계상태: "활성" } },
    ],
    projects: [
      {
        sourceId: "project-1",
        properties: {
          "프로젝트명(Title)": "선진엔지니어링 HCI 구축",
          프로젝트ID: "PRJ-2026-001",
          상태: "진행",
          중요도: "높음",
          "고객·파트너": ["account-customer"],
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
          "date:활동일:start": "2026-08-14T01:00:00Z",
          요약: "HCI 교체 요구 확인",
          결정사항: "10월 검수",
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
          합계: 110000000,
          상태: "청구",
          프로젝트: ["project-1"],
          거래처: ["account-customer"],
          "date:예상 입금일:start": "2026-10-31",
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
          합계: 66000000,
          상태: "예정",
          프로젝트: ["project-1"],
          거래처: ["account-vendor"],
          "date:예상 출금일:start": "2026-09-30",
          출금처리여부: false,
        },
      },
    ],
  };
}

describe("NotionCwosImportPlanner", () => {
  it("maps the four Notion operational databases into a deterministic read-only plan", () => {
    const planner = new NotionCwosImportPlanner();
    const first = planner.plan(snapshot());
    const second = planner.plan(snapshot());

    expect(first.readOnlySource).toBe(true);
    expect(first.planHash).toBe(second.planHash);
    expect(first.accounts).toHaveLength(2);
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
      { sourceId: "expense-project", properties: { "프로젝트명(Title)": "2월 카드사용료" } },
      { sourceId: "missing-key", properties: { "프로젝트명(Title)": "정상 고객 구축", "고객·파트너": ["account-customer"] } },
    );
    const plan = new NotionCwosImportPlanner().plan(input);
    expect(plan.quarantined.find((item) => item.sourceId === "expense-project")?.reasons).toContain("MIXED_EXPENSE_PROJECT");
    expect(plan.quarantined.find((item) => item.sourceId === "missing-key")?.reasons).toContain("MISSING_PROJECT_KEY");
    expect(plan.engagements).toHaveLength(1);
  });

  it("quarantines duplicate accounts, duplicate project keys and unknown relations", () => {
    const input = snapshot();
    input.accounts.push({ sourceId: "duplicate-account", properties: { "회사/조직명": "  선진엔지니어링  ", 구분: "고객" } });
    input.projects.push({ sourceId: "duplicate-project", properties: { "프로젝트명(Title)": "다른 이름", 프로젝트ID: "PRJ-2026-001", "고객·파트너": ["account-customer"] } });
    input.activities.push({ sourceId: "unknown-activity", properties: { 활동명: "미팅", "date:활동일:start": "2026-08-15", 요약: "알 수 없는 고객", 프로젝트: ["missing-project"] } });
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
    expect(plan.quarantined.find((item) => item.sourceId === "orphan")?.reasons).toContain("ORPHAN_FINANCE");
    expect(plan.quarantined.find((item) => item.sourceId === "bad-vat")?.reasons).toContain("VAT_MISMATCH");
    expect(plan.quarantined.find((item) => item.sourceId === "duplicate")?.reasons).toContain("DUPLICATE_FINANCE");
    expect(plan.financialItems).toHaveLength(2);
  });

  it("uses stable hashes independent of object key order", () => {
    expect(notionCwosHash({ a: 1, b: { c: 2 } })).toBe(notionCwosHash({ b: { c: 2 }, a: 1 }));
  });
});
