import { describe, expect, it } from "vitest";
import { CustomerWorkOsV2Error, UnifiedInboxService, type V2Actor } from "../src/customer-work-os-v2/index.js";

const worker: V2Actor = { principalId: "writer", workspaceId: "ws", kind: "service", stepUpVerified: false };
const owner: V2Actor = { principalId: "owner", workspaceId: "ws", kind: "human", stepUpVerified: true };
const candidate = { id: "candidate", workspaceId: "ws", provider: "GMAIL" as const, mailbox: "mail@example.test",
  sourceLocator: "gmail://thread/1", providerEventId: "message-1", subject: "Proposal", bodyDigest: "a".repeat(64) };

describe("CWOS v2 Mail candidate review", () => {
  it("appends immutable review history and restores pending state after undo", () => {
    const inbox = new UnifiedInboxService();
    inbox.createMailCandidate({ ...candidate, senderCompany: "Acme", summary: "Quote", receivedAt: "2026-10-08T00:00:00.000Z", evidenceUrl: "https://example.test/evidence" }, worker, "2026-10-09T00:00:00.000Z");
    const first = inbox.reviewMailCandidate({ id: "review-1", workspaceId: "ws", candidateId: candidate.id,
      outcome: "DISCARDED", reason: "SPAM" }, owner, "2026-10-09T00:01:00.000Z");
    const undone = inbox.undoMailCandidateReview({ id: "review-2", workspaceId: "ws",
      candidateId: candidate.id, reviewId: first.id }, owner, "2026-10-09T00:02:00.000Z");
    expect(undone).toMatchObject({ outcome: "UNDONE", undoOf: first.id, version: 2 });
    expect(inbox.reviewMailCandidate({ id: "review-3", workspaceId: "ws", candidateId: candidate.id,
      outcome: "NEW_ACCOUNT_CANDIDATE", companyName: "Acme Ltd" }, owner, "2026-10-09T00:03:00.000Z").version).toBe(3);
    const restored = new UnifiedInboxService();
    restored.hydrateState(inbox.exportState());
    expect(restored.mailCandidateReviewHistory("ws", candidate.id).map(item => item.outcome))
      .toEqual(["DISCARDED", "UNDONE", "NEW_ACCOUNT_CANDIDATE"]);
    expect(inbox.exportState().mailCandidates?.[0]).toMatchObject({ status: "CANDIDATE", confirmed: false });
  });

  it("rejects unauthorized, duplicate, stale, and unsafe review attempts", () => {
    const inbox = new UnifiedInboxService();
    inbox.createMailCandidate(candidate, worker, "2026-10-09T00:00:00.000Z");
    expect(() => inbox.createMailCandidate({ ...candidate, id: "bad", providerEventId: "bad", evidenceUrl: "https://u:p@example.test" }, worker, "2026-10-09T00:00:00.000Z")).toThrowError(CustomerWorkOsV2Error);
    expect(() => inbox.reviewMailCandidate({ id: "r1", workspaceId: "ws", candidateId: candidate.id,
      outcome: "DISCARDED" }, { ...owner, stepUpVerified: false }, "2026-10-09T00:00:00.000Z")).toThrowError(CustomerWorkOsV2Error);
    inbox.reviewMailCandidate({ id: "r1", workspaceId: "ws", candidateId: candidate.id, outcome: "DISCARDED" }, owner, "2026-10-09T00:00:00.000Z");
    expect(() => inbox.reviewMailCandidate({ id: "r2", workspaceId: "ws", candidateId: candidate.id,
      outcome: "DISCARDED" }, owner, "2026-10-09T00:00:00.000Z")).toThrowError(expect.objectContaining({ code: "MAIL_CANDIDATE_ALREADY_REVIEWED" }));
    expect(() => inbox.undoMailCandidateReview({ id: "r3", workspaceId: "ws", candidateId: candidate.id,
      reviewId: "wrong" }, owner, "2026-10-09T00:00:00.000Z")).toThrowError(expect.objectContaining({ code: "MAIL_CANDIDATE_REVIEW_NOT_ACTIVE" }));
  });
});
