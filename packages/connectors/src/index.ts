import type { ActionType } from "@ai-crm/contracts";

/**
 * @ai-crm/connectors — MVP-disabled boundary for future outbound provider connectors
 * (CRM writes, payment execution, notification delivery to third-party APIs, etc.).
 *
 * Per ADR-008 (connector confinement — recorded in ADR-001 §2 "Two allowlisted
 * egress boundaries" and the approved plan's ADR section), the MVP has **no
 * remote write path**: every
 * action the platform authorizes is executed against internal domain services only.
 * This package exists so that a future remote-effect registry entry has somewhere to
 * be rejected deterministically, rather than being silently wired to a live provider.
 *
 * `ConnectorDispatcher.dispatch` always throws `ConnectorDomainError("CONNECTOR_DISABLED", ...)`.
 * This rejection IS the specified MVP behavior, not a stub awaiting completion.
 *
 * Enabling any remote connector requires, at minimum:
 *   1. A new ADR superseding/amending ADR-008 that accepts the new blast radius
 *      (credential custody, egress, third-party data handling) and revises the
 *      capability matrix accordingly.
 *   2. An outcome-query capability so the governance/audit trail can reconcile what
 *      a remote provider actually did against what was authorized.
 *   3. A deadline-scan follow-up so remote operations that never reach a terminal
 *      state are surfaced instead of silently hanging.
 *
 * Until all three land, this package MUST keep `remoteWrite`/`providerCredential`
 * false and `egress` "none" — see `CONNECTOR_CAPABILITY` and
 * `assertNoConnectorCapability`, which give the negative-test suite a real runtime
 * surface to assert against instead of relying on the absence of code.
 */

export class ConnectorDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConnectorDomainError";
  }
}

/** A future remote-effect registry entry. No dispatcher may execute one in the MVP. */
export interface RemoteRegistryEntry {
  operationId: string;
  actionType: ActionType;
  effect: "remote";
}

/** Declared capability surface of this package. All flags MUST stay negative until a new ADR lands. */
export const CONNECTOR_CAPABILITY = Object.freeze({
  remoteWrite: false,
  providerCredential: false,
  egress: "none",
} as const);

/**
 * Throws if any connector capability flag has been enabled, giving callers (and
 * tests) a runtime assertion point rather than relying purely on static review.
 */
export function assertNoConnectorCapability(): void {
  if (CONNECTOR_CAPABILITY.remoteWrite || CONNECTOR_CAPABILITY.providerCredential) {
    throw new ConnectorDomainError(
      "CONNECTOR_CAPABILITY_ENABLED",
      "connector capability flags must remain disabled until a new ADR supersedes ADR-008",
    );
  }
  if (CONNECTOR_CAPABILITY.egress !== "none") {
    throw new ConnectorDomainError(
      "CONNECTOR_CAPABILITY_ENABLED",
      "connector egress must remain 'none' until a new ADR supersedes ADR-008",
    );
  }
}

/**
 * MVP connector dispatcher. `dispatch` never executes a remote effect: it always
 * throws `ConnectorDomainError("CONNECTOR_DISABLED", ...)`. See module doc comment.
 */
export class ConnectorDispatcher {
  dispatch(entry: RemoteRegistryEntry): never {
    throw new ConnectorDomainError(
      "CONNECTOR_DISABLED",
      `remote connector dispatch is disabled in the MVP (operationId=${entry.operationId}, actionType=${entry.actionType}); ` +
        "enabling remote effects requires a new ADR superseding ADR-008 plus outcome-query and deadline-scan follow-ups",
    );
  }
}
