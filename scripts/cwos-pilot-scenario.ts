/**
 * PILOT-01 scenario runner: exercises CRM API (v1) + Customer Work OS v2 on
 * the single pilot server via real HTTP injects, then prints a machine-
 * readable result record consumed by docs/customer-work-os/pilot/PILOT-01-RESULT.md.
 *
 * Scenarios:
 *   1. PRJ-PILOT-001 project against a seeded customer + partner contract.
 *   2. Customer/partner/activity/next-action/finance (revenue + expense) seed.
 *   3. Project P&L verification from the customer-360 finance projection.
 *   4. Adversarial: duplicate idempotency, unbalanced/VAT error, cross-workspace.
 *   5. CWOS v2: bootstrap, PSA, milestones, findings, release manifest gate,
 *      readiness. The release gate is exercised WITHOUT relaxing it — the
 *      operations sub-aggregates (drill/pilot/runbook/cutover/security) are
 *      not exposed as v2 commands, so the manifest gate correctly blocks.
 *
 * No real credentials/API keys/server accounts/bank details are used — all
 * identifiers are pilot fixtures.
 *
 * Run:
 *   pnpm exec tsx scripts/cwos-pilot-scenario.ts
 */
import { pathToFileURL } from "node:url";

const WS = "ws-pilot-01";
const OTHER_WS = "ws-pilot-other";
const CUSTOMER = "customer-pilot-01";
const PROJECT = "PRJ-PILOT-001";
const OWNER = "principal-pilot-owner";
const APPROVER = "principal-pilot-approver";
const VERIFIER = "principal-pilot-verifier";
const POSTER = "principal-pilot-poster";
const IMPORT_OPERATOR = "principal-pilot-import";
const NOW = "2026-08-15T00:00:00.000Z";

const headers = { "x-workspace-id": WS, "content-type": "application/json" };
const otherHeaders = { "x-workspace-id": OTHER_WS, "content-type": "application/json" };

interface Step {
  id: string;
  description: string;
  ok: boolean;
  detail?: string;
}

export async function runScenario(app: { inject: (opts: unknown) => Promise<{ statusCode: number; body: string; json(): unknown }> }): Promise<void> {
  const steps: Step[] = [];
  function record(id: string, description: string, ok: boolean, detail?: string): void {
    steps.push({ id, description, ok, detail });
  }
  function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
  }
    // ---------------------------------------------------------------- 1. 고객/계약/파트너
    const customer = await app.inject({
      method: "POST",
      url: "/api/customers",
      headers,
      payload: { id: CUSTOMER, name: "Pilot Partner Corp", status: "active", createdAt: NOW },
    });
    assert(customer.statusCode === 201, `customer create: ${customer.statusCode}`);
    record("seed-customer", "고객 등록 (customer-pilot-01)", true, `201 ${customer.json().name}`);

    // 파트너십 = 고객 계약(contract) + 커뮤니케이션으로 표현 (별도 파트너 모델 없음)
    const contract = await app.inject({
      method: "POST",
      url: `/api/customers/${CUSTOMER}/contracts`,
      headers,
      payload: {
        id: "contract-pilot-01",
        title: "Pilot Partner Agreement",
        scope: "CWOS v2 pilot 파트너십 (가상 데이터)",
        effectiveFrom: "2026-08-01",
        effectiveTo: "2026-12-31",
        valueKrw: "1000000000",
      },
    });
    assert(contract.statusCode === 201, `contract create: ${contract.statusCode}`);
    record("seed-partner", "파트너십 계약 등록 (contract-pilot-01)", true, `201 ${contract.json().title}`);

    const comm = await app.inject({
      method: "POST",
      url: `/api/customers/${CUSTOMER}/communications`,
      headers,
      payload: {
        id: "comm-pilot-01",
        channel: "meeting",
        summary: "PILOT-01 킥오프 미팅 — 가상 일정",
        occurredAt: "2026-08-10T09:00:00Z",
      },
    });
    assert(comm.statusCode === 201, `communication: ${comm.statusCode}`);
    record("seed-activity", "활동(커뮤니케이션) 등록", true, "201 meeting");

    const action = await app.inject({
      method: "POST",
      url: `/api/customers/${CUSTOMER}/next-actions`,
      headers,
      payload: { id: "next-pilot-01", title: "PILOT-01 결과 리뷰 미팅", priority: 1, dueAt: "2026-08-20T10:00:00Z" },
    });
    assert(action.statusCode === 201, `next action: ${action.statusCode}`);
    record("seed-next-action", "다음 행동 등록", true, "201 priority 1");

    // ---------------------------------------------------------------- 2. PRJ-PILOT-001 프로젝트
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload: {
        id: PROJECT,
        customerId: CUSTOMER,
        name: "CWOS v2 PILOT-01 프로젝트",
        contractId: "contract-pilot-01",
        contractScope: "PILOT-01 스코프: CRM+CWOS v2 통합 검증",
        scheduleStart: "2026-08-01",
        scheduleEnd: "2026-12-31",
        deliverables: [
          { id: "deliverable-pilot-01", title: "PILOT-01 결과 리포트", required: true, status: "pending", requirementIds: ["req-pilot-01"] },
        ],
        riskThreshold: 0.7,
        requirementIds: ["req-pilot-01"],
      },
    });
    assert(project.statusCode === 201, `project create: ${project.statusCode}`);
    record("seed-project", "PRJ-PILOT-001 프로젝트 생성", true, `201 ${project.json().name}`);

    // ---------------------------------------------------------------- 3. 매출/비용 전표 (DRAFT→VERIFY→POST, governance)
    const revenueEntry = await app.inject({
      method: "POST",
      url: "/api/finance/journal-entries",
      headers,
      payload: {
        id: "entry-revenue-pilot-01",
        entryDate: "2026-08-15",
        description: "PILOT-01 용역매출 인식 (가상)",
        evidenceRef: "evidence://pilot-01/revenue",
        createdByPrincipalId: OWNER,
        lines: [
          { accountCode: "1200", debitKrw: "1000000000", creditKrw: "0", description: "매출채권" },
          { accountCode: "4000", debitKrw: "0", creditKrw: "1000000000", description: "용역매출" },
        ],
      },
    });
    assert(revenueEntry.statusCode === 201, `revenue draft: ${revenueEntry.statusCode}`);

    const expenseEntry = await app.inject({
      method: "POST",
      url: "/api/finance/journal-entries",
      headers,
      payload: {
        id: "entry-expense-pilot-01",
        entryDate: "2026-08-15",
        description: "PILOT-01 외주비 인식 (가상)",
        evidenceRef: "evidence://pilot-01/expense",
        createdByPrincipalId: OWNER,
        lines: [
          { accountCode: "5000", debitKrw: "600000000", creditKrw: "0", description: "외주비" },
          { accountCode: "2100", debitKrw: "0", creditKrw: "600000000", description: "매입채무" },
        ],
      },
    });
    assert(expenseEntry.statusCode === 201, `expense draft: ${expenseEntry.statusCode}`);

    for (const entryId of ["entry-revenue-pilot-01", "entry-expense-pilot-01"]) {
      const verified = await app.inject({
        method: "POST",
        url: `/api/finance/journal-entries/${entryId}/verify`,
        headers,
        payload: { verifierPrincipalId: VERIFIER },
      });
      assert(verified.statusCode === 200, `${entryId} verify: ${verified.statusCode}`);
      // LEDGER_POST is REQUIRE_APPROVAL: authorize -> independent approve -> consume
      const authorized = await app.inject({
        method: "POST",
        url: "/api/governance/authorize",
        headers,
        payload: {
          command: "finance.ledger_post",
          resourceId: entryId,
          resourceVersion: 2,
          payload: { entryId },
          requesterPrincipalId: VERIFIER,
        },
      });
      assert(authorized.statusCode === 201, `${entryId} authorize: ${authorized.statusCode}`);
      const control = authorized.json().control as { id: string; payloadHash: string; policyVersion: number };
      const decided = await app.inject({
        method: "POST",
        url: `/api/governance/controls/${control.id}/decide`,
        headers,
        payload: { principalId: APPROVER, decision: "APPROVE" },
      });
      assert(decided.statusCode === 200, `${entryId} approve: ${decided.statusCode}`);
      const consumed = await app.inject({
        method: "POST",
        url: `/api/governance/controls/${control.id}/consume`,
        headers,
        payload: {
          resourceId: entryId,
          resourceVersion: 2,
          payloadHash: control.payloadHash,
          policyVersion: control.policyVersion,
        },
      });
      assert(consumed.statusCode === 201, `${entryId} consume: ${consumed.statusCode}`);
      const posted = await app.inject({
        method: "POST",
        url: `/api/finance/journal-entries/${entryId}/post`,
        headers,
        payload: { posterPrincipalId: POSTER, intentId: consumed.json().id as string },
      });
      assert(posted.statusCode === 200, `${entryId} post: ${posted.statusCode}`);
    }
    record("seed-finance", "매출/비용 전표 등록·검증·승인·전기", true, "매출 1,000,000,000 / 비용 600,000,000 POSTED");

    // ---------------------------------------------------------------- 4. BANK_STATEMENT freshness
    const bank = await app.inject({
      method: "POST",
      url: "/api/imports",
      headers,
      payload: {
        id: "bank-pilot-01",
        sourceKind: "BANK_STATEMENT",
        schemaVersion: 1,
        content: [
          "account,statement_period,posted_at,amount_krw,balance_krw,description",
          "acct-pilot-01,2026-08,2026-08-15,1000000000,1000000000,Net",
        ].join("\n"),
        operatorPrincipalId: IMPORT_OPERATOR,
        submittedAt: "2026-08-15T09:00:00+09:00",
      },
    });
    assert(bank.statusCode === 201, `bank import: ${bank.statusCode}`);
    const freshness = await app.inject({ method: "GET", url: "/api/imports/bank/freshness", headers });
    assert(freshness.statusCode === 200 && freshness.json().asOf, "bank freshness asOf");
    record("seed-bank-freshness", "은행명세 freshness 확보", true, `asOf=${freshness.json().asOf}`);

    // ---------------------------------------------------------------- 5. 손익(P&L) 검증
    const overview = await app.inject({ method: "GET", url: `/api/customers/${CUSTOMER}/overview`, headers });
    assert(overview.statusCode === 200, `overview: ${overview.statusCode}`);
    const finance = overview.json().finance;
    assert(finance.status === "available", `finance available: ${JSON.stringify(finance)}`);
    assert(finance.projectMarginKrw === "400000000", `margin ${finance.projectMarginKrw}`);
    const projects = overview.json().projects as Array<{ id: string; name: string }>;
    assert(projects.some((item) => item.id === PROJECT), "overview includes PRJ-PILOT-001");
    record("verify-pnl", "프로젝트 손익 검증", true, "매출 1,000,000,000 − 비용 600,000,000 = 마진 400,000,000 KRW");

    // ---------------------------------------------------------------- 6. 적대검증
    // 6a. 중복 요청: 같은 고객 ID 재등록
    const dupCustomer = await app.inject({
      method: "POST",
      url: "/api/customers",
      headers,
      payload: { id: CUSTOMER, name: "Duplicate", status: "active", createdAt: NOW },
    });
    assert(dupCustomer.statusCode === 409, `dup customer expected 409: ${dupCustomer.statusCode}`);
    assert(dupCustomer.json().error === "DUPLICATE_ID", `dup error ${dupCustomer.json().error}`);
    record("adversarial-duplicate", "중복 요청 차단 (DUPLICATE_ID)", true, "409 DUPLICATE_ID");

    // 6b. VAT/불균형 오류: 차변 1,100,000,000 vs 대변 1,000,000,000 (부가세 불일치)
    const vatEntry = await app.inject({
      method: "POST",
      url: "/api/finance/journal-entries",
      headers,
      payload: {
        id: "entry-vat-bad-pilot-01",
        entryDate: "2026-08-15",
        description: "VAT 오류 전표 (의도적 실패)",
        evidenceRef: "evidence://pilot-01/vat-bad",
        createdByPrincipalId: OWNER,
        lines: [
          { accountCode: "1200", debitKrw: "1100000000", creditKrw: "0", description: "부가세 포함 오류" },
          { accountCode: "4000", debitKrw: "0", creditKrw: "1000000000", description: "용역매출" },
        ],
      },
    });
    assert(vatEntry.statusCode === 400, `vat entry expected 400: ${vatEntry.statusCode}`);
    assert(vatEntry.json().error === "UNBALANCED_ENTRY", `vat error ${vatEntry.json().error}`);
    record("adversarial-vat", "VAT 오류 차단 (UNBALANCED_ENTRY)", true, "400 UNBALANCED_ENTRY");

    // 6c. Cross-workspace: 다른 워크스페이스로 프로젝트 조회
    const crossRead = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT}`,
      headers: otherHeaders,
    });
    assert(crossRead.statusCode === 400, `cross-read expected 400: ${crossRead.statusCode}`);
    assert(crossRead.json().error === "CROSS_WORKSPACE", `cross-read error ${crossRead.json().error}`);
    const crossWrite = await app.inject({
      method: "POST",
      url: `/api/customers/${CUSTOMER}/next-actions`,
      headers: otherHeaders,
      payload: {
        id: "next-cross-pilot-01",
        title: "cross-workspace 침입 (의도적 실패)",
        priority: 1,
        dueAt: "2026-08-20T10:00:00Z",
      },
    });
    assert(crossWrite.statusCode === 400, `cross-write expected 400: ${crossWrite.statusCode}`);
    assert(crossWrite.json().error === "CROSS_WORKSPACE", `cross-write error ${crossWrite.json().error}`);
    record("adversarial-cross-workspace", "Cross-workspace 차단", true, "다른 워크스페이스 접근 400 CROSS_WORKSPACE");

    // ---------------------------------------------------------------- 7. CWOS v2
    const v2Headers = {
      "x-workspace-id": WS,
      "x-principal-id": OWNER,
      "x-principal-kind": "human",
      "x-step-up": "true",
      "content-type": "application/json",
    };

    let version = 0;
    const run = async (command: string, payload: unknown, key: string, expectedStatus: number, id: string, desc: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/cwos/v2/commands",
        headers: { ...v2Headers, "idempotency-key": key },
        payload: { command, expectedVersion: version, payload },
      });
      assert(response.statusCode === expectedStatus, `${command} expected ${expectedStatus}: ${response.statusCode} ${response.body}`);
      if (response.statusCode === 200) version = response.json().runtimeVersion as number;
      record(id, desc, response.statusCode === expectedStatus, `${response.statusCode} → v${version}`);
      return response;
    };

    // 부트스트랩: 최초 커맨드는 등록 + 멤버십
    await run("identity.registerPrincipal", { id: OWNER, kind: "human", displayName: "Pilot Owner", active: true }, "v2-register", 200, "v2-bootstrap-principal", "v2 부트스트랩: principal 등록");
    await run("identity.addMembership", { id: "membership-pilot-owner", principalId: OWNER }, "v2-membership", 200, "v2-bootstrap-membership", "v2 부트스트랩: 멤버십 추가");
    await run("identity.addTeam", { id: "team-pilot", name: "Pilot Team" }, "v2-team", 200, "v2-team", "v2 팀 등록");

    // PSA 리소스/캐파시티
    await run("psa.addResource", { id: "resource-pilot-01", principalId: OWNER, displayName: "Pilot Owner", hourlyCostKrw: 100000 }, "v2-resource", 200, "v2-psa-resource", "v2 PSA 리소스 등록");
    await run("psa.setCapacity", { id: "capacity-pilot-01", resourceId: "resource-pilot-01", date: "2026-08-15", availableHours: 8, leave: false }, "v2-capacity", 200, "v2-psa-capacity", "v2 PSA 캐파시티 설정");
    await run("psa.assign", { id: "assign-pilot-01", resourceId: "resource-pilot-01", projectId: PROJECT, date: "2026-08-15", plannedHours: 8 }, "v2-assign", 200, "v2-psa-assign", "v2 PSA 배정");

    // operations: SLO 정의 (HTTP로 노출된 유일한 operations 커맨드)
    await run("operations.defineSlo", { id: "slo-pilot-api", service: "cwos-v2-api", availabilityTarget: 0.999, latencyP95Ms: 1000, errorBudgetMinutes: 43 }, "v2-slo", 200, "v2-slo", "v2 operations SLO 정의");

    // 마일스톤 10개 (1.1.0 ~ 2.0.0) 시작 → 완료
    const versions = ["1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0", "1.6.0", "1.7.0", "1.8.0", "1.9.0", "2.0.0"];
    for (const milestoneVersion of versions) {
      await run("release.startMilestone", { version: milestoneVersion }, `v2-start-${milestoneVersion}`, 200, `v2-milestone-start-${milestoneVersion}`, `v2 마일스톤 ${milestoneVersion} 시작`);
      await run("release.completeMilestone", { version: milestoneVersion, evidenceRefs: [`evidence://pilot-01/milestone/${milestoneVersion}`] }, `v2-complete-${milestoneVersion}`, 200, `v2-milestone-complete-${milestoneVersion}`, `v2 마일스톤 ${milestoneVersion} 완료`);
    }

    // findings 기록/해결 (release 게이트)
    await run("release.recordFinding", { id: "finding-pilot-01", version: "2.0.0", perspective: "operations", severity: "LOW", title: "PILOT-01 점검 항목" }, "v2-finding", 200, "v2-finding", "v2 finding 기록");
    await run("release.resolveFinding", { id: "finding-pilot-01", evidenceRef: "evidence://pilot-01/finding-resolved" }, "v2-finding-resolve", 200, "v2-finding-resolve", "v2 finding 해결");

    // 매니페스트: operations 서브도메인(drill/pilot/runbook/cutover/security)이
    // v2 커맨드로 노출되지 않아 게이트가 fail-closed로 차단 — Gate 완화 없이 기록.
    const manifest = await run(
      "release.createManifest",
      {
        id: "manifest-pilot-01",
        releaseVersion: "2.0.0",
        sourceCommitSha: "cdefbeff4ba56782558d974a7a7dcb28f942d265",
        artifactRefs: ["evidence://pilot-01/artifact"],
        checksumRefs: ["evidence://pilot-01/checksum"],
        migrationRefs: ["evidence://migration/0019"],
        rollbackRefs: ["evidence://runbook/rollback"],
        operationsEvidenceRefs: ["evidence://pilot-01/release-gate"],
      },
      "v2-manifest",
      400,
      "v2-release-manifest",
      "v2 릴리스 매니페스트 게이트 (OPERATIONS_GATES_INCOMPLETE fail-closed)",
    );
    const manifestError = manifest.json().error as string;
    assert(manifestError === "OPERATIONS_GATES_INCOMPLETE", `manifest error ${manifestError}`);
    record("v2-operations-gates", "operations 게이트 fail-closed 확인", true, "매니페스트 차단 (drill/pilot/runbook/cutover/security 커맨드 미노출)");

    // readiness: manifest 0개 → ready=false (정직한 fail-closed 상태)
    const readiness = await app.inject({ method: "GET", url: "/api/cwos/v2/readiness", headers: v2Headers });
    assert(readiness.statusCode === 200, `readiness: ${readiness.statusCode}`);
    const readinessBody = readiness.json() as { ready: boolean; openFindings: number; releaseManifests: number; runtimeVersion: number };
    assert(readinessBody.ready === false && readinessBody.releaseManifests === 0, `readiness not fail-closed: ${JSON.stringify(readinessBody)}`);
    record("v2-readiness", "v2 readiness (fail-closed)", true, `ready=${readinessBody.ready} openFindings=${readinessBody.openFindings} manifests=${readinessBody.releaseManifests} runtimeVersion=${readinessBody.runtimeVersion}`);

    // ---------------------------------------------------------------- 결과
    const failed = steps.filter((step) => !step.ok);
    const result = {
      pilot: "PILOT-01",
      branch: "pilot/cwos-pilot-01",
      baseCommit: "cdefbeff4ba56782558d974a7a7dcb28f942d265",
      ranAt: NOW,
      node: process.version,
      pnpm: "9.15.0",
      workspaceId: WS,
      projectId: PROJECT,
      customerId: CUSTOMER,
      passed: failed.length === 0,
      stepCount: steps.length,
      failedCount: failed.length,
      steps,
    };
    console.log(JSON.stringify(result, null, 2));
    if (failed.length > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const { buildPilotApp } = await import("./cwos-pilot-server.js");
  const app = await buildPilotApp();
  try {
    await runScenario(app);
  } finally {
    await app.close();
  }
}

// Import guard: the server's PILOT_SEED mode imports `runScenario` without
// re-running the standalone main().
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
