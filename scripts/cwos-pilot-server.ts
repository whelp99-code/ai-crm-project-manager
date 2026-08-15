/**
 * PILOT-01: boots the REAL @ai-crm/api Fastify app so the CRM API (v1) and
 * the Customer Work OS v2 API run on the same composition root, on one
 * loopback port.
 *
 * - In-memory SoR (no DATABASE_URL): the pilot exercises the HTTP contract of
 *   both API surfaces, not PG persistence (that is live-PG scope).
 * - `financePack`: pilot-fixture accounting pack (labelled as such — real
 *   values come from the signed pack, see docs/ops/finance-pack-pilot.md),
 *   acknowledged via `allowUnsignedFinancePack` on a non-production boot.
 * - `modelClient`: deterministic stub (no network) so /api/model/invoke stays
 *   available and reproducible offline. Same shape as the e2e live-server.
 *
 * Run:
 *   pnpm --filter @ai-crm/api exec tsx ../../scripts/cwos-pilot-server.ts
 * or from repo root:
 *   pnpm exec tsx scripts/cwos-pilot-server.ts
 */
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { createApp, type CreateAppOptions } from "../apps/api/src/app.js";
import type { FinancePackConfig } from "../packages/finance/src/index.js";

export const PILOT_PORT = 4300;
export const PILOT_HOST = "127.0.0.1";

/** Pilot-fixture only — real values come from the signed accounting pack. */
export const PILOT_FINANCE_PACK: FinancePackConfig = {
  packVersion: 1,
  chartOfAccounts: [
    { code: "1000", name: "현금", type: "asset", projectionRole: "cash" },
    { code: "1200", name: "매출채권", type: "asset", projectionRole: "receivable" },
    { code: "2100", name: "매입채무", type: "liability", projectionRole: "payable" },
    { code: "4000", name: "용역매출", type: "revenue" },
    { code: "5000", name: "외주비", type: "expense" },
  ],
  decimalScale: 0,
  dayCloseCutoff: "18:00",
  cutoffBoundary: "inclusive",
  reconciliationToleranceKrw: "0",
  requiredConsecutiveDays: 90,
};

function deterministicModelClient() {
  return {
    async invoke() {
      return {
        structuredOutput: { steps: [] },
        modelVersion: "pilot-01-deterministic-1",
        retentionHonored: true,
      };
    },
  };
}

export async function buildPilotApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const app = createApp({
    ...options,
    financePack: options.financePack ?? PILOT_FINANCE_PACK,
    allowUnsignedFinancePack: true,
    modelClient: options.modelClient ?? deterministicModelClient(),
    modelServicePrincipalId: options.modelServicePrincipalId ?? "principal-model-gateway-pilot-01",
  });

  // Pilot-harness-only CORS: the Next /v2 page fetches this API cross-origin
  // from the Next dev server's own origin. Production apps/api has no CORS
  // layer — this hook lives only in this pilot script.
  app.addHook("onRequest", async (request, reply) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
    reply.header(
      "access-control-allow-headers",
      "content-type,x-workspace-id,x-principal-id,x-principal-kind,x-step-up,idempotency-key,authorization",
    );
    if (request.method === "OPTIONS") {
      await reply.status(204).send();
    }
  });

  await app.ready();
  return app;
}

async function main(): Promise<void> {
  console.log("[pilot-01] building app");
  const app = await buildPilotApp();
  console.log("[pilot-01] app ready");
  if (process.env.PILOT_SEED === "1") {
    console.log("[pilot-01] seeding scenario");
    const { runScenario } = await import("./cwos-pilot-scenario.js");
    await runScenario(app);
    console.log("[pilot-01] scenario complete");
  }
  await app.listen({ port: PILOT_PORT, host: PILOT_HOST });
  const routes = app.printRoutes().split("\n").length;
  console.log(`[pilot-01] CRM API + CWOS v2 listening on http://${PILOT_HOST}:${PILOT_PORT} (${routes} routes)`);
  console.log(`[pilot-01] health: http://${PILOT_HOST}:${PILOT_PORT}/health`);
  console.log(`[pilot-01] cwos v2: http://${PILOT_HOST}:${PILOT_PORT}/api/cwos/v2/readiness`);
}

// Import guard: `tsx scripts/cwos-pilot-server.ts` boots the server; the
// scenario harness imports `buildPilotApp` instead and injects requests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
