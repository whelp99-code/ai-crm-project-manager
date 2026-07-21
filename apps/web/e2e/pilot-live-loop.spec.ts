import { test, expect } from "@playwright/test";
import { canonicalHashOf, POLICY_VERSION } from "@ai-crm/policy-engine";
import {
  PILOT_LIVE_API_BASE_URL,
  PILOT_LIVE_APPROVER_ID,
  PILOT_LIVE_ASSIGNMENT_PAYLOAD,
  PILOT_LIVE_COMMAND_TEXT,
  PILOT_LIVE_OPERATOR_ID,
  PILOT_LIVE_WORKSPACE_ID,
} from "./live-loop-env";

/**
 * REAL browser-driven S0 loop against a REAL live API (D1/D9): proves the
 * /pilot wizard is not just fail-closed decoration — an operator can submit
 * a natural-language command, an approver (different principal, SoD) can
 * decide it, and the job reaches a terminal state with the wizard's own
 * "pilot loop complete" confirmation rendering.
 *
 * Mutations driven through the wizard UI are exactly the two sanctioned
 * agent-flow endpoints: POST /api/agent/commands (step 2 submit) and
 * POST /api/governance/controls/:id/decide (step 3 approve) — no domain
 * PATCH anywhere in this spec.
 *
 * Turning an APPROVED checkpoint into a completed work item still requires
 * the governance consume + agent work-item complete calls (there is no
 * shortcut in the API — see apps/api/test/s0-natural-command.integration
 * .test.ts S0-I-06, the canonical happy path this spec mirrors exactly,
 * including the payloadHash derivation). Those two calls are made directly
 * against the same live API via Playwright's `request` fixture (not a
 * domain PATCH, not a second UI surface) so the wizard's own 새로고침
 * (refresh) button is what surfaces the terminal state in the DOM.
 */
test.describe("pilot wizard live loop (S0, real API)", () => {
  test("submit -> approve (SoD) -> consume/complete -> pilot loop complete", async ({ page, request }) => {
    await page.goto("/pilot", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    // Live config: /pilot must be configured (no fail-closed banner).
    await expect(page.getByText("파일럿 환경 설정이 필요합니다")).toHaveCount(0);

    // Step 1 -> Step 2.
    await page.getByRole("button", { name: "다음" }).click();
    await expect(page.getByRole("heading", { name: "작업 제출" })).toBeVisible();

    await page.getByLabel("운영자 principal").fill(PILOT_LIVE_OPERATOR_ID);
    await page.getByLabel("명령 텍스트").fill(PILOT_LIVE_COMMAND_TEXT);

    const submit = page.getByRole("button", { name: "명령 전송" });
    await expect(submit).toBeEnabled();
    await submit.click();

    // Wizard auto-advances to step 3 (approval) on a successful submit.
    await expect(page.getByRole("heading", { name: "승인" })).toBeVisible();
    await expect(page.locator('[aria-current="step"]')).toHaveText("3단계 · 승인");

    const controlIdInput = page.getByLabel("Control ID");
    await expect(controlIdInput).not.toHaveValue("");
    const controlId = await controlIdInput.inputValue();

    // SoD: approver principal must differ from the operator who submitted.
    await page.getByLabel("승인자 principal").fill(PILOT_LIVE_APPROVER_ID);
    expect(PILOT_LIVE_APPROVER_ID).not.toBe(PILOT_LIVE_OPERATOR_ID);

    await page.getByRole("button", { name: "승인" }).click();
    await expect(page.getByText(`APPROVE → APPROVED`)).toBeVisible();

    // Step 3 -> Step 4 to read the jobId the wizard is tracking.
    await page.getByRole("button", { name: "다음" }).click();
    await expect(page.getByRole("heading", { name: "완료" })).toBeVisible();
    const jobIdText = await page.locator("p.status-row .meta").last().textContent();
    const jobId = (jobIdText ?? "").trim();
    expect(jobId, "wizard must expose the tracked jobId in step 4").not.toBe("");

    // Turn the APPROVED checkpoint into a fresh consumed intent, then apply
    // it — the sanctioned governance/agent pipeline, mirroring S0-I-06.
    const consume = await request.post(`${PILOT_LIVE_API_BASE_URL}/api/governance/controls/${controlId}/consume`, {
      headers: { "x-workspace-id": PILOT_LIVE_WORKSPACE_ID },
      data: {
        resourceId: PILOT_LIVE_ASSIGNMENT_PAYLOAD.planId,
        resourceVersion: 1,
        payloadHash: canonicalHashOf("PM_TASK_ASSIGN", PILOT_LIVE_ASSIGNMENT_PAYLOAD),
        policyVersion: POLICY_VERSION,
      },
    });
    expect(consume.status(), await consume.text()).toBe(201);
    const { id: intentId } = (await consume.json()) as { id: string };
    expect(intentId).toBeTruthy();

    const jobBefore = await request.get(`${PILOT_LIVE_API_BASE_URL}/api/agent/jobs/${jobId}`, {
      headers: { "x-workspace-id": PILOT_LIVE_WORKSPACE_ID, "x-principal-id": PILOT_LIVE_OPERATOR_ID },
    });
    expect(jobBefore.status()).toBe(200);
    const { workItems } = (await jobBefore.json()) as { workItems: Array<{ id: string; controlId?: string }> };
    const workItem = workItems.find((item) => item.controlId === controlId);
    expect(workItem, "expected the work item bound to the approved control").toBeTruthy();

    const complete = await request.post(
      `${PILOT_LIVE_API_BASE_URL}/api/agent/jobs/${jobId}/work-items/${workItem!.id}/complete`,
      {
        headers: { "x-workspace-id": PILOT_LIVE_WORKSPACE_ID, "x-principal-id": PILOT_LIVE_OPERATOR_ID },
        data: { intentId },
      },
    );
    expect(complete.status(), await complete.text()).toBe(200);
    expect(await complete.json()).toMatchObject({ status: "done", needsApproval: false });

    // The wizard's OWN refresh button is what must surface the terminal
    // state — not a raw API assertion.
    await page.getByRole("button", { name: "새로고침" }).click();
    await expect(page.getByText("파일럿 루프 완료 · pilot loop complete")).toBeVisible();
    await expect(page.locator("p.status-row .status").first()).toHaveText("done");

    await page.screenshot({ path: "test-results/pilot-live-loop-complete.png", fullPage: true });
  });
});
