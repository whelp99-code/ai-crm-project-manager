import { expect, test } from "@playwright/test";
import { isLocalReviewAllowed } from "../app/lib/local-review-guard";

test.describe("local company review proxy guard", () => {
  test("rejects a foreign request authority at the proxy", async ({ request }) => {
    const response = await request.get("/api/local-review/company-overview", {
      headers: { host: "review.example.test" },
    });
    expect(response.status()).toBe(404);
    expect(await response.json()).toEqual({ error: "LOCAL_REVIEW_UNAVAILABLE" });
  });

  test("requires opt-in, non-production, and a loopback host", () => {
    expect(isLocalReviewAllowed({
      optIn: "1",
      nodeEnv: "development",
      hostname: "127.0.0.1",
    })).toBe(true);
    expect(isLocalReviewAllowed({
      optIn: undefined,
      nodeEnv: "development",
      hostname: "127.0.0.1",
    })).toBe(false);
    expect(isLocalReviewAllowed({
      optIn: "1",
      nodeEnv: "production",
      hostname: "127.0.0.1",
    })).toBe(false);
    expect(isLocalReviewAllowed({
      optIn: "1",
      nodeEnv: "development",
      hostname: "review.example.test",
    })).toBe(false);
  });
});
