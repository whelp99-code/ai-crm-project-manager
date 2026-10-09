import { expect, test } from "@playwright/test";

test.describe("owner document draft proxy", () => {
  test("refuses document data without an owner cookie", async ({ request }) => {
    const response = await request.get("/api/cwos/v2/document-drafts");
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "OWNER_SESSION_REQUIRED" });
  });

  test("refuses cross-origin draft writes before forwarding credentials", async ({ request }) => {
    const response = await request.post("/api/cwos/v2/document-drafts", {
      headers: { origin: "https://other.example.test" }, data: { action: "QUOTE", expectedVersion: 0 },
    });
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ error: "OWNER_REVIEW_ORIGIN_REQUIRED" });
  });

  test("shows owner proof guidance rather than editable drafts without proof", async ({ page }) => {
    await page.goto("/v2/quote-renewal");
    await expect(page.getByRole("heading", { name: "견적·발주와 재계약", exact: true })).toBeVisible();
    await expect(page.locator("p[role=alert]")).toContainText("owner 인증");
    await expect(page.getByRole("button", { name: "견적·발주 초안 만들기", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("운영 인증의 cookie·csrf JSON")).toBeVisible();
  });

  test("can undo an added quote or source item without submitting the draft", async ({ page }) => {
    // Only local editing is asserted; auth and persistence use the real API
    // scenarios. Preserve the authenticated list/session DTOs at this boundary.
    await page.route("**/api/cwos/v2/document-drafts", async route => {
      if (route.request().method() === "POST") {
        await route.fulfill({ status: 500, json: { error: "UNEXPECTED_SUBMIT" } });
        return;
      }
      await route.fulfill({ json: {
        runtimeVersion: 0, engagements: [{ id: "fixture", name: "Fixture project", version: 1 }],
        quoteDrafts: [], renewalDrafts: [],
        contracts: [{ kind: "NORMALIZED", id: "fixture-contract", version: 1, reference: "fixture",
          terms: { startDate: "2026-01-01", endDate: "2026-12-31", valueKrw: "1",
            items: [{ id: "item", description: "item", quantity: 1, unitPriceKrw: "1" }],
            conditions: ["fixture"] } }],
      } });
    });
    await page.route("**/api/cwos/v2/review-session", route =>
      route.fulfill({ json: { csrf: "fixture-csrf-with-at-least-24-characters" } }));
    const submits: string[] = [];
    page.on("request", request => {
      if (request.method() === "POST" && request.url().endsWith("/document-drafts")) submits.push(request.url());
    });
    await page.goto("/v2/quote-renewal");
    await page.locator('input[type="file"]').setInputFiles({
      name: "fixture-session.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ cookie: "fixture", csrf: "fixture" })),
    });
    const quote = page.locator('form:has(select[name="engagement"])');
    await quote.locator('select[name="engagement"]').selectOption("fixture");
    for (const [name, value] of Object.entries({
      revision: "fixture-v1", validUntil: "2026-10-31", template: "fixture", customerPo: "customer",
      supplierPo: "supplier", scope: "fixture", "source-0": "source", "product-0": "product",
      "description-0": "item", "quantity-0": "1", "cost-0": "0", "price-0": "1", vat: "0",
    })) await quote.locator(`[name="${name}"]`).fill(value);
    await expect(quote.getByRole("button", { name: "견적·발주 초안 만들기", exact: true })).toBeEnabled();
    await quote.getByRole("button", { name: "품목 추가", exact: true }).click();
    await expect(quote.locator("fieldset")).toHaveCount(2);
    for (const [name, value] of Object.entries({
      "source-1": "source-2", "product-1": "product-2", "description-1": "item-2",
      "quantity-1": "1", "cost-1": "0", "price-1": "1",
    })) await quote.locator(`[name="${name}"]`).fill(value);
    await quote.getByRole("button", { name: "마지막 품목 삭제", exact: true }).click();
    await expect(quote.locator("fieldset")).toHaveCount(1);
    await expect(quote.locator('[name="description-0"]')).toHaveValue("item");
    await expect(quote.getByRole("button", { name: "견적·발주 초안 만들기", exact: true })).toBeEnabled();
    await expect(page.locator("p[role=alert]")).toHaveCount(0);
    const source = page.locator('form:has(input[name="sourceId"])');
    await source.getByRole("button", { name: "기존 품목 추가", exact: true }).click();
    await expect(source.locator("fieldset")).toHaveCount(2);
    await source.getByRole("button", { name: "마지막 기존 품목 삭제", exact: true }).click();
    await expect(source.locator("fieldset")).toHaveCount(1);
    await page.locator('section[aria-labelledby="renewal-title"] select').selectOption("NORMALIZED:fixture-contract:1");
    const renewal = page.locator('form:has(input[name="revisionLabel"])');
    await renewal.getByRole("button", { name: "재계약 품목 추가", exact: true }).click();
    await expect(renewal.locator("fieldset")).toHaveCount(2);
    await renewal.getByRole("button", { name: "마지막 재계약 품목 삭제", exact: true }).click();
    await expect(renewal.locator("fieldset")).toHaveCount(1);
    expect(submits).toEqual([]);
  });

  test("holds compare actions until the selected immutable result has loaded", async ({ page }) => {
    const terms = { startDate: "2026-01-01", endDate: "2026-12-31", valueKrw: "1",
      items: [{ id: "item", description: "item", quantity: 1, unitPriceKrw: "1" }], conditions: ["fixture"] };
    const source = { kind: "OWNER_INPUT", id: "original", version: null, reference: "fixture", terms };
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const requested = new Promise<void>(resolve => { started = resolve; });
    await page.route("**/api/cwos/v2/document-drafts**", async route => {
      if (new URL(route.request().url()).searchParams.has("renewalId")) {
        started();
        await pending;
        await route.fulfill({ json: { renewalId: "fixture-renewal", revisionId: "revision",
          source, terms, approvalStatus: "NOT_APPROVED",
          comparison: { amountDeltaKrw: "0", fields: ["period", "amount", "items", "conditions"]
            .map(key => ({ key, status: "UNCHANGED" })) } } });
        return;
      }
      await route.fulfill({ json: { runtimeVersion: 1, engagements: [], quoteDrafts: [], contracts: [],
        renewalDrafts: [{ id: "fixture-renewal",
          revisions: [{ revisionId: "revision", revisionLabel: "fixture", contractDraft: { source, terms } }],
          receipts: [{ revisionId: "revision", approvalStatus: "NOT_APPROVED", status: "INTERNAL_CANDIDATE" }] }] } });
    });
    await page.goto("/v2/quote-renewal");
    const compare = page.getByRole("button", { name: "나란히 비교", exact: true });
    try {
      await compare.click();
      await requested;
      await expect(compare).toBeDisabled();
      await expect(page.locator("[data-comparison]")).toHaveCount(0);
    } finally { release(); }
    await expect(page.locator('[data-comparison-renewal="fixture-renewal"]')).toBeVisible();
    await expect(page.locator('[data-field][data-status="UNCHANGED"]')).toHaveCount(4);
    await expect(compare).toBeEnabled();
  });
});
