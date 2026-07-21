import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /ready (T-018)", () => {
  it("returns ready in memory mode without DATABASE_URL/pg", async () => {
    app = createApp();
    await app.ready();
    expect((app as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe(
      "memory",
    );
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready" });
  });

  it("returns ready when pgPool is injected and select 1 succeeds", async () => {
    const query = vi.fn(async (sql: string) => {
      if (/select 1/i.test(sql)) return { rows: [{ ok: 1 }] };
      // Hydrate-on-boot (G-01) issues additional reads at onReady; the
      // fake pool has no rows, so these resolve to empty result sets.
      return { rows: [] };
    });
    app = createApp({ pgPool: { query } as never });
    await app.ready();
    expect((app as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe("pg");
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready" });
    expect(query).toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => /select 1/i.test(String(sql)))).toBe(true);
  });

  it("returns 503 not_ready when persistenceMode is pg and pool query fails", async () => {
    const query = vi.fn(async (sql: string) => {
      if (/select 1/i.test(sql)) throw new Error("connection refused");
      // Hydrate-on-boot reads succeed (empty) so boot itself is not blocked;
      // only the live /ready connectivity probe is broken here.
      return { rows: [] };
    });
    app = createApp({ pgPool: { query } as never });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "not_ready" });
  });

  it("returns 503 not_ready when persistenceMode is pg but pool is unavailable", async () => {
    app = createApp();
    await app.ready();
    const runtime = (app as FastifyInstance & {
      aiCrm?: { persistenceMode: string; pool?: unknown };
    }).aiCrm;
    expect(runtime).toBeDefined();
    // Simulate pg mode without a live pool (e.g. half-open misconfig after boot).
    runtime!.persistenceMode = "pg";
    delete runtime!.pool;
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "not_ready" });
  });

  it("/ready never requires API key", async () => {
    app = createApp({ authApiKey: "test-key-ready" });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready" });
  });
});
