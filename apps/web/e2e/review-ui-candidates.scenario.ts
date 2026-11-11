import { expect, test } from "@playwright/test";
import { loginOwner, resetOwnedFixture } from "./auth-fixture";

test.beforeAll(() => {
  if (process.env.PLAYWRIGHT_REVIEW_UI !== "1") {
    throw new Error("Run this native candidate scenario with PLAYWRIGHT_REVIEW_UI=1");
  }
});

test.beforeEach(async () => {
  await resetOwnedFixture();
});

test("review entry lists five native candidates and persists LINK then UNDO", async ({ page, baseURL }) => {
  if (!baseURL) throw new Error("review UI origin is required");
  await page.goto("/");
  await expect(page).toHaveURL(new URL("/login", baseURL).toString());
  await loginOwner(page, { navigate: false });
  await page.goto("/");
  await expect(page).toHaveURL(/\/v2\/mail-candidate-review$/);
  await expect(page.locator("article[aria-labelledby^=candidate-]")).toHaveCount(5);
  const candidate = page.locator('article[aria-labelledby="candidate-review-candidate-1"]');
  await expect(candidate.getByText("검토 대기", { exact: true })).toBeVisible();
  await candidate.getByLabel("확정할 거래처", { exact: true }).selectOption("synthetic-review-account");
  const linked = page.waitForResponse(response =>
    response.url().endsWith("/api/cwos/v2/mail-candidate-review")
    && response.request().method() === "POST");
  await candidate.getByRole("button", { name: "확정", exact: true }).click();
  const linkedResponse = await linked;
  expect(linkedResponse.status()).toBe(200);
  await page.reload();
  await expect(candidate.getByText("거래처 연결 확정", { exact: true }).first()).toBeVisible();
  const persistedLink = await page.request.get("/api/cwos/v2/mail-candidate-review");
  expect(persistedLink.status()).toBe(200);
  expect(await persistedLink.json()).toMatchObject({
    candidates: expect.arrayContaining([expect.objectContaining({
      id: "review-candidate-1",
      review: expect.objectContaining({ outcome: "LINKED", accountId: "synthetic-review-account" }),
    })]),
  });
  const undone = page.waitForResponse(response =>
    response.url().endsWith("/api/cwos/v2/mail-candidate-review")
    && response.request().method() === "POST");
  await candidate.getByRole("button", { name: "되돌리기", exact: true }).click();
  const undoneResponse = await undone;
  expect(undoneResponse.status()).toBe(200);
  await page.reload();
  await expect(candidate.getByText("되돌림 · 검토 대기", { exact: true }).first()).toBeVisible();
  await expect(candidate.getByLabel("확정할 거래처", { exact: true })).toBeVisible();
  const listed = await page.request.get("/api/cwos/v2/mail-candidate-review");
  expect(listed.status()).toBe(200);
  const body: unknown = await listed.json();
  expect(body).toMatchObject({ candidates: expect.arrayContaining([
    expect.objectContaining({ id: "review-candidate-1", review: expect.objectContaining({ outcome: "UNDONE" }),
      history: [expect.objectContaining({ outcome: "LINKED" }), expect.objectContaining({ outcome: "UNDONE" })] }),
  ]) });
});

test("review mutations reject absent CSRF and foreign origin without changing state", async ({ page, baseURL }) => {
  if (!baseURL) throw new Error("review UI origin is required");
  await loginOwner(page);
  await expect(page.locator("article[aria-labelledby^=candidate-]")).toHaveCount(5);
  const before = await page.request.get("/api/cwos/v2/mail-candidate-review");
  const previous: { runtimeVersion: number; candidates: readonly unknown[] } = await before.json();
  const payload = { expectedVersion: previous.runtimeVersion, candidateId: "review-candidate-2",
    action: "LINK", accountId: "synthetic-review-account" };
  const noCsrf = await page.request.post("/api/cwos/v2/mail-candidate-review", {
    headers: { origin: baseURL, "idempotency-key": "review-no-csrf" }, data: payload,
  });
  expect(noCsrf.status()).toBe(403);
  const session = await page.request.get("/api/self-entry");
  const proof: { csrf: string } = await session.json();
  const foreign = await page.request.post("/api/cwos/v2/mail-candidate-review", {
    headers: { origin: "https://foreign.example.test", "x-csrf-token": proof.csrf,
      "idempotency-key": "review-foreign-origin" }, data: payload,
  });
  expect(foreign.status()).toBe(403);
  expect(await foreign.json()).toEqual({ error: "OWNER_REVIEW_ORIGIN_REQUIRED" });
  const after = await page.request.get("/api/cwos/v2/mail-candidate-review");
  expect(await after.json()).toEqual(previous);
});

test.describe("candidate store isolation", () => {
  test("reset restores five pending candidates after a committed LINK", async ({ page, baseURL }) => {
    if (!baseURL) throw new Error("review UI origin is required");
    await loginOwner(page);
    await expect(page.locator("article[aria-labelledby^=candidate-]")).toHaveCount(5);
    const candidate = page.locator('article[aria-labelledby="candidate-review-candidate-1"]');
    await expect(candidate.getByText("검토 대기", { exact: true })).toBeVisible();
    await candidate.getByLabel("확정할 거래처", { exact: true }).selectOption("synthetic-review-account");
    const linked = page.waitForResponse(response =>
      response.url().endsWith("/api/cwos/v2/mail-candidate-review")
      && response.request().method() === "POST");
    await candidate.getByRole("button", { name: "확정", exact: true }).click();
    expect((await linked).status()).toBe(200);
    await loginOwner(page);
    const listed = await page.request.get("/api/cwos/v2/mail-candidate-review");
    expect(listed.status()).toBe(200);
    const body: { candidates: readonly { id: string; review: unknown; history: readonly unknown[] }[] } = await listed.json();
    expect(body.candidates).toHaveLength(5);
    expect(body.candidates.every(item => item.review === null && item.history.length === 0)).toBe(true);
  });
});
