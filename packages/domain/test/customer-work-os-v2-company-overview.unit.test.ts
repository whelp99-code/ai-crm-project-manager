import { describe, expect, it } from "vitest";
import {
  CustomerWorkOsV2Platform,
  buildCompanyOverview,
  type CustomerWorkOsV2State,
} from "../src/customer-work-os-v2/index.js";

const workspaceId = "e1111111-1111-4111-8111-111111111111";
const asOf = "2026-10-06T00:00:00.000Z";

function emptyState(): CustomerWorkOsV2State {
  return new CustomerWorkOsV2Platform(workspaceId).exportState();
}

describe("W07 local company candidate read model", () => {
  it("keeps missing company observations unknown instead of reporting zero", () => {
    const overview = buildCompanyOverview(emptyState(), workspaceId, asOf);

    expect(overview.authority).toBe("LOCAL_CANDIDATE_ONLY");
    for (const name of ["revenue", "purchases", "receivables"] as const) {
      expect(overview[name]).toMatchObject({
        status: "UNKNOWN",
        candidateCount: null,
        quantityTotals: null,
        sources: [],
      });
    }
    expect(overview.delivery).toMatchObject({
      status: "UNKNOWN",
      candidateCount: 0,
      quantityTotals: null,
    });
  });

  it("uses only the latest W04 revision and never treats event occurrence as observation", () => {
    const state = emptyState();
    state.inbox.events.push({
      id: "mail-c06-001",
      workspaceId,
      source: "GMAIL",
      providerEventId: "mail-c06-001",
      occurredAt: "2026-10-05T23:59:00.000Z",
      subject: "Existing C06 local fixture",
      bodyDigest: "existing-w04-fixture-digest",
      sender: "fixture",
      promptInjectionSuspected: false,
      status: "TRIAGED",
      version: 1,
    });
    state.delivery = {
      schemaVersion: 1,
      orders: [{
        id: "work-c06-001",
        workspaceId,
        workItemId: "work-c06-001",
        sourceEventId: "mail-c06-001",
        quoteRevision: "v1",
        revisions: [
          {
            revisionId: "w04-c06-revision-2",
            version: 2,
            decision: "PARTIAL_ACCEPTED",
            quantities: [{ lineId: "quote-line", ordered: 4, delivered: 4, accepted: 1 }],
            content: "Existing W04 local fixture",
            contentHash: "a".repeat(64),
            citationRefs: ["evidence://mail-c06-001/delivery-status", "evidence://mail-c06-001/delivery-status"],
            reason: null,
            recordedByPrincipalId: "w04-local-owner",
          },
          {
            revisionId: "w04-c06-revision-3",
            version: 3,
            decision: "REJECTED",
            quantities: [{ lineId: "quote-line", ordered: 4, delivered: 4, accepted: 0 }],
            content: "Existing W04 local fixture",
            contentHash: "b".repeat(64),
            citationRefs: [
              "evidence://mail-c06-001/delivery-status",
              "evidence://mail-c06-001/delivery-status",
              "mail-c06-001",
            ],
            reason: "Local fixture rejection",
            recordedByPrincipalId: "w04-local-owner",
          },
        ],
        authoritativeAcceptance: "UNKNOWN",
        paymentEligibility: "UNKNOWN",
        version: 3,
      }],
    };

    const delivery = buildCompanyOverview(state, workspaceId, asOf).delivery;
    expect(delivery).toMatchObject({
      status: "UNKNOWN",
      candidateCount: 1,
      quantityTotals: { ordered: "4", delivered: "4", accepted: "0" },
      sources: [{
        revisionId: "w04-c06-revision-3",
        sourceHash: "b".repeat(64),
        observedAt: null,
        sourceOccurredAt: "2026-10-05T23:59:00.000Z",
        freshness: "UNKNOWN",
        evidenceRefs: ["evidence://mail-c06-001/delivery-status", "mail-c06-001"],
      }],
    });
  });

  it("marks old explicit W05 observations stale and rejects foreign state", () => {
    const state = emptyState();
    state.renewals = {
      schemaVersion: 1,
      drafts: [{
        id: "w05-local-renewal",
        workspaceId,
        revisions: [{
          renewalId: "w05-local-renewal",
          workspaceId,
          revisionId: "w05-local-renewal-v1",
          revisionLabel: "v1",
          observedAt: "2026-08-01T00:00:00.000Z",
          expiresOn: null,
          noticePeriodDays: null,
          unknownTerms: ["renewal fee approval"],
          content: "Existing W05 local candidate fixture",
          citations: [],
          version: 1,
          sourceHash: "c".repeat(64),
          recordedByPrincipalId: "w05-local-owner",
        }],
        receipts: [],
        version: 1,
      }],
    };
    expect(buildCompanyOverview(state, workspaceId, asOf).renewals).toMatchObject({
      status: "STALE",
      candidateCount: 1,
      sources: [{
        revisionId: "w05-local-renewal-v1",
        observedAt: "2026-08-01T00:00:00.000Z",
        freshness: "STALE",
      }],
    });
    expect(() => buildCompanyOverview(state, "foreign-workspace", asOf)).toThrow(
      "workspaceId does not match source state",
    );
  });
});
