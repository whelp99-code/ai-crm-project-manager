import { describe, expect, it } from "vitest";
import { CustomerWorkOsService, customerWorkOsPayloadHash, type ApprovalReceipt } from "@ai-crm/domain/customer-work-os";
import { notionCwosHash, type NotionCwosSnapshot } from "@ai-crm/imports";
import {
  CustomerWorkOsNotionService,
  InMemoryNotionPlanStore,
  applyNotionPlanToDomain,
} from "../src/customer-work-os-notion.js";

const WORKSPACE = "workspace-notion-integration";

function snapshot(): NotionCwosSnapshot {
  return {
    workspaceId: WORKSPACE,
    snapshotId: "snapshot-1",
    capturedAt: "2026-08-14T00:00:00Z",
    snapshotHash: "sha256:snapshot-1",
    accounts: [
      { sourceId: "account-customer", sourceUrl: "notion://account-customer", title: "고객 A", properties: { 구분: "고객", 관계상태: "활성", 담당자: "홍길동", "대표 이메일": "hong@example.test" } },
      { sourceId: "account-vendor", sourceUrl: "notion://account-vendor", title: "벤더 B", properties: { 구분: "파트너", 관계상태: "활성" } },
    ],
    projects: [
      { sourceId: "project-1", sourceUrl: "notion://project-1", title: "HCI 구축", properties: { 프로젝트ID: "PRJ-2026-001", 상태: "진행", "고객·파트너": ["account-customer"], 파트너: ["account-vendor"], "다음 행동": "검수 일정 확정", "date:종료일:start": "2026-09-30", 견적서: ["drive://quote"], 제안서: ["drive://proposal"], 계약서: ["drive://contract"], 완료보고서: [] } },
      { sourceId: "expense-row", sourceUrl: "notion://expense-row", title: "카드사용료", properties: { 상태: "진행" } },
    ],
    activities: [
      { sourceId: "activity-1", sourceUrl: "notion://activity-1", title: "고객 미팅", properties: { 프로젝트: ["project-1"], "고객·파트너": ["account-customer"], 유형: "미팅", "date:활동일:start": "2026-08-10", 요약: "구축 일정 확정", 결정사항: "9월 검수" } },
    ],
    finance: [
      { sourceId: "revenue", sourceUrl: "notion://revenue", title: "계약금", properties: { 프로젝트: ["project-1"], 거래처: ["account-customer"], 구분: "매출", 금액: 1000, 부가세: 100, 상태: "입금완료", 입금처리여부: true, "date:실제 처리일:start": "2026-08-12", 증빙: ["bank://revenue"] } },
      { sourceId: "partial-cost", sourceUrl: "notion://partial-cost", title: "장비 매입", properties: { 프로젝트: ["project-1"], 거래처: ["account-vendor"], 구분: "매입", 금액: 1000, 부가세: 100, 상태: "부분처리", 실제금액: 500, "date:실제 처리일:start": "2026-08-13", 증빙: ["bank://cost"] } },
      { sourceId: "orphan", sourceUrl: "notion://orphan", title: "거래처 없는 비용", properties: { 프로젝트: ["project-1"], 구분: "매입", 금액: 100, 부가세: 10 } },
    ],
  };
}

function approval(input: Omit<ApprovalReceipt, "workspaceId" | "status" | "approvedByPrincipalId">): ApprovalReceipt {
  return { ...input, workspaceId: WORKSPACE, status: "CONSUMED", approvedByPrincipalId: "owner-approver" };
}

describe("CustomerWorkOsNotionService", () => {
  it("creates an idempotent immutable plan with quarantines and reconciliation", async () => {
    const service = new CustomerWorkOsNotionService(new InMemoryNotionPlanStore(), () => "2026-08-14T00:01:00Z");
    const first = await service.plan(snapshot(), "owner-requester");
    const replay = await service.plan(snapshot(), "owner-requester");
    expect(replay).toEqual(first);
    expect(first.status).toBe("PLANNED");
    expect(first.plan.accounts).toHaveLength(2);
    expect(first.plan.engagements).toHaveLength(1);
    expect(first.plan.financialItems).toHaveLength(2);
    expect(first.plan.quarantined.map((item) => item.legacySourceId).sort()).toEqual(["expense-row", "orphan"]);
    expect(first.plan.reconciliation.orphanRelations).toBe(1);
  });

  it("requires approval bound to plan hash and then applies every accepted record atomically", async () => {
    let now = "2026-08-14T00:01:00Z";
    const notion = new CustomerWorkOsNotionService(new InMemoryNotionPlanStore(), () => now);
    const planned = await notion.plan(snapshot(), "owner-requester");
    const approvePayload = { planId: planned.id, planHash: planned.planHash, quarantine: planned.plan.reconciliation.quarantined, orphanRelations: planned.plan.reconciliation.orphanRelations, duplicateCandidates: planned.plan.reconciliation.duplicateCandidates };
    now = "2026-08-14T00:02:00Z";
    const approved = await notion.approve(WORKSPACE, planned.id, 1, "owner-approver", approval({ id: "approve-plan", resourceType: "import_plan", resourceId: planned.id, resourceVersion: 1, action: "NOTION_IMPORT_APPROVE", payloadHash: notionCwosHash(approvePayload) }), "격리 2건을 제외하고 적용");
    expect(approved.status).toBe("APPROVED");

    const domain = new CustomerWorkOsService();
    const applyPayload = { planId: approved.id, planVersion: approved.version, planHash: approved.planHash };
    const result = applyNotionPlanToDomain({ service: domain, record: approved, principalId: "owner-operator", receipt: approval({ id: "apply-plan", resourceType: "import_plan", resourceId: approved.id, resourceVersion: approved.version, action: "NOTION_IMPORT_APPLY", payloadHash: customerWorkOsPayloadHash(applyPayload) }) });
    expect(result).toMatchObject({ alreadyApplied: false, accounts: 2, contacts: 1, engagements: 1, activities: 1, commitments: 1, artifacts: 3, financialItems: 2, settlements: 2, quarantined: 2 });
    const state = domain.exportState();
    expect(state.accounts).toHaveLength(2);
    expect(state.engagements[0]?.projectKey).toBe("PRJ-2026-001");
    expect(state.artifacts).toHaveLength(3);
    expect(state.financialItems).toHaveLength(2);
    expect(state.settlements.map((item) => item.amountKrw).sort()).toEqual(["1100", "500"]);
    expect(state.appliedImportPlanHashes).toEqual([approved.planHash]);

    now = "2026-08-14T00:03:00Z";
    const marked = await notion.markApplied(WORKSPACE, approved.id, approved.version, "owner-operator", "domain CAS committed");
    expect(marked.status).toBe("APPLIED");
  });

  it("returns a safe no-op when the same approved plan is applied again", async () => {
    const notion = new CustomerWorkOsNotionService(new InMemoryNotionPlanStore(), () => "2026-08-14T00:00:00Z");
    const planned = await notion.plan(snapshot(), "owner");
    const approved = await notion.approve(WORKSPACE, planned.id, 1, "approver", approval({ id: "approve", resourceType: "import_plan", resourceId: planned.id, resourceVersion: 1, action: "NOTION_IMPORT_APPROVE", payloadHash: notionCwosHash({ planId: planned.id, planHash: planned.planHash, quarantine: planned.plan.reconciliation.quarantined, orphanRelations: planned.plan.reconciliation.orphanRelations, duplicateCandidates: planned.plan.reconciliation.duplicateCandidates }) }), "approved exclusions");
    const domain = new CustomerWorkOsService();
    const receipt = approval({ id: "apply", resourceType: "import_plan", resourceId: approved.id, resourceVersion: 2, action: "NOTION_IMPORT_APPLY", payloadHash: customerWorkOsPayloadHash({ planId: approved.id, planVersion: 2, planHash: approved.planHash }) });
    applyNotionPlanToDomain({ service: domain, record: approved, principalId: "owner", receipt });
    const replay = applyNotionPlanToDomain({ service: domain, record: approved, principalId: "owner", receipt });
    expect(replay.alreadyApplied).toBe(true);
    expect(domain.exportState().accounts).toHaveLength(2);
  });

  it("rejects a stale approval hash", async () => {
    const notion = new CustomerWorkOsNotionService(new InMemoryNotionPlanStore(), () => "2026-08-14T00:00:00Z");
    const planned = await notion.plan(snapshot(), "owner");
    await expect(notion.approve(WORKSPACE, planned.id, 1, "approver", approval({ id: "bad", resourceType: "import_plan", resourceId: planned.id, resourceVersion: 1, action: "NOTION_IMPORT_APPROVE", payloadHash: "tampered" }), "bad" )).rejects.toMatchObject({ code: "STALE_APPROVAL" });
  });
});
