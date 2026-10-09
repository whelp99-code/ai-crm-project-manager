import type { FastifyInstance } from "fastify";
import { OperatorStepUpError, type OperatorStepUpService } from "./operator-step-up.js";

/** Session introspection reuses the existing scoped proof without granting new authority. */
export function registerOperatorSession(app: FastifyInstance, auth: OperatorStepUpService): void {
  app.get("/api/cwos/v2/operator-session", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (request.headers["x-workspace-id"] !== auth.workspaceId
      || request.headers["x-principal-id"] !== auth.principalId
      || request.headers["x-principal-kind"] !== "human"
      || request.headers["x-bot-id"] || request.headers["x-step-up"]) {
      return reply.status(403).send({ error: "ACTOR_BINDING_MISMATCH" });
    }
    try {
      auth.authorize({
        cookieHeader: request.headers.cookie, csrfHeader: undefined, method: "GET",
      });
      return reply.send({ authenticated: true });
    } catch (error) {
      if (error instanceof OperatorStepUpError) {
        return reply.status(error.statusCode).send({ error: error.code });
      }
      throw error;
    }
  });
}
