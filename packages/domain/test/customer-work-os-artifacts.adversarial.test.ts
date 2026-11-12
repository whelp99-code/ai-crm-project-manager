import { describe, expect, it } from "vitest";
import {
  CustomerWorkOsError,
  CustomerWorkOsService,
  customerWorkOsPayloadHash,
  type ApprovalReceipt,
} from "../src/customer-work-os.js";

const WORKSPACE = "workspace-artifact";

function receipt(input: Omit<ApprovalReceipt, "workspaceId" | "status" | "approvedByPrincipalId">): ApprovalReceipt {
  return {
    ...input,
    workspaceId: WORKSPACE,
    status: "CONSUMED",
    approvedByPrincipalId: "human-approver",
  };
}

function seeded(): CustomerWorkOsService {
  const service = new CustomerWorkOsService();
  service.createAccount({ id: "customer", workspaceId: WORKSPACE, name: "고객 A", kinds: ["customer"], status: "active" });
  service.createEngagement({
    id: "engagement",
    workspaceId: WORKSPACE,
    projectKey: "PRJ-ARTIFACT-001",
    name: "고객 A HCI 구축",
    type: "delivery",
    stage: "DELIVERY",
    health: "normal",
    ownerPrincipalId: "owner",
  });
  service.recordActivity({
    id: "activity",
    workspaceId: WORKSPACE,
    engagementId: "engagement",
    type: "document",
    occurredAt: "2026-08-14T00:00:00Z",
    summary: "제안서 초안 업로드",
    evidenceRef: "mail://proposal-source",
    humanReviewed: true,
  });
  return service;
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CustomerWorkOsError);
    expect((error as CustomerWorkOsError).code).toBe(code);
  }
}

describe("Customer Work OS artifact lifecycle", () => {
  it("versions an artifact from draft to review, approved, sent and accepted with bound approvals", () => {
    const service = seeded();
    const draft = service.addArtifact({
      id: "proposal-v1",
      workspaceId: WORKSPACE,
      engagementId: "engagement",
      accountId: "customer",
      type: "proposal",
      title: "HCI 구축 제안서",
      versionLabel: "v1",
      status: "DRAFT",
      storageUri: "minio://cwos/proposal-v1.pdf",
      contentHash: "sha256:proposal-v1",
      sourceActivityId: "activity",
      effectiveDate: "2026-08-14",
      metadata: { language: "ko" },
    });
    expect(draft.version).toBe(1);

    const review = service.updateArtifactStatus(WORKSPACE, draft.id, 1, "REVIEW", "author", "2026-08-14T01:00:00Z");
    expect(review.status).toBe("REVIEW");
    expect(review.version).toBe(2);

    const approvalPayload = {
      status: "APPROVED",
      contentHash: review.contentHash ?? null,
      storageUri: review.storageUri,
    };
    const approved = service.updateArtifactStatus(
      WORKSPACE,
      review.id,
      2,
      "APPROVED",
      "human-approver",
      "2026-08-14T02:00:00Z",
      receipt({
        id: "artifact-approve",
        resourceType: "artifact",
        resourceId: review.id,
        resourceVersion: 2,
        action: "ARTIFACT_APPROVE",
        payloadHash: customerWorkOsPayloadHash(approvalPayload),
      }),
    );
    expect(approved.status).toBe("APPROVED");
    expect(approved.approvedByPrincipalId).toBe("human-approver");

    const sendPayload = {
      status: "SENT",
      storageUri: approved.storageUri,
      versionLabel: approved.versionLabel,
    };
    const sent = service.updateArtifactStatus(
      WORKSPACE,
      approved.id,
      3,
      "SENT",
      "human-approver",
      "2026-08-14T03:00:00Z",
      receipt({
        id: "artifact-send",
        resourceType: "artifact",
        resourceId: approved.id,
        resourceVersion: 3,
        action: "ARTIFACT_SEND",
        payloadHash: customerWorkOsPayloadHash(sendPayload),
      }),
    );
    expect(sent.sentAt).toBe("2026-08-14T03:00:00Z");

    const accepted = service.updateArtifactStatus(WORKSPACE, sent.id, 4, "ACCEPTED", "customer", "2026-08-14T04:00:00Z");
    expect(accepted.status).toBe("ACCEPTED");
    expect(accepted.acceptedAt).toBe("2026-08-14T04:00:00Z");
  });

  it("fails closed when approval is missing, stale or bound to another payload", () => {
    const service = seeded();
    service.addArtifact({
      id: "proposal-v1",
      workspaceId: WORKSPACE,
      engagementId: "engagement",
      type: "proposal",
      title: "제안서",
      versionLabel: "v1",
      status: "REVIEW",
      storageUri: "minio://proposal",
      contentHash: "sha256:p",
      metadata: {},
    });
    expectCode(
      () => service.updateArtifactStatus(WORKSPACE, "proposal-v1", 1, "APPROVED", "owner", "2026-08-14T01:00:00Z"),
      "APPROVAL_REQUIRED",
    );
    expectCode(
      () => service.updateArtifactStatus(
        WORKSPACE,
        "proposal-v1",
        1,
        "APPROVED",
        "owner",
        "2026-08-14T01:00:00Z",
        receipt({
          id: "wrong",
          resourceType: "artifact",
          resourceId: "proposal-v1",
          resourceVersion: 2,
          action: "ARTIFACT_APPROVE",
          payloadHash: "wrong",
        }),
      ),
      "STALE_APPROVAL",
    );
    expect(service.exportState().consumedReceiptIds).toEqual([]);
  });

  it("rejects invalid transitions, duplicate versions and acceptance before send", () => {
    const service = seeded();
    service.addArtifact({
      id: "report-v1",
      workspaceId: WORKSPACE,
      engagementId: "engagement",
      type: "completion_report",
      title: "완료보고서",
      versionLabel: "v1",
      status: "DRAFT",
      storageUri: "minio://report-v1",
      metadata: {},
    });
    expectCode(
      () => service.addArtifact({
        id: "report-v1-copy",
        workspaceId: WORKSPACE,
        engagementId: "engagement",
        type: "completion_report",
        title: "완료보고서",
        versionLabel: "v1",
        status: "DRAFT",
        storageUri: "minio://report-copy",
        metadata: {},
      }),
      "DUPLICATE_ARTIFACT_VERSION",
    );
    expectCode(
      () => service.updateArtifactStatus(WORKSPACE, "report-v1", 1, "SENT", "owner", "2026-08-14T01:00:00Z"),
      "INVALID_TRANSITION",
    );
    const review = service.updateArtifactStatus(WORKSPACE, "report-v1", 1, "REVIEW", "owner", "2026-08-14T01:00:00Z");
    const payload = { status: "APPROVED", contentHash: review.contentHash ?? null, storageUri: review.storageUri };
    const approved = service.updateArtifactStatus(
      WORKSPACE,
      review.id,
      2,
      "APPROVED",
      "approver",
      "2026-08-14T02:00:00Z",
      receipt({ id: "approve", resourceType: "artifact", resourceId: review.id, resourceVersion: 2, action: "ARTIFACT_APPROVE", payloadHash: customerWorkOsPayloadHash(payload) }),
    );
    expectCode(
      () => service.updateArtifactStatus(WORKSPACE, approved.id, 3, "ACCEPTED", "customer", "2026-08-14T03:00:00Z"),
      "INVALID_TRANSITION",
    );
  });

  it("supports explicit supersession and preserves artifacts across restart hydration", () => {
    const service = seeded();
    const original = service.addArtifact({
      id: "design-v1",
      workspaceId: WORKSPACE,
      engagementId: "engagement",
      type: "design",
      title: "상세설계서",
      versionLabel: "v1",
      status: "DRAFT",
      storageUri: "minio://design-v1",
      contentHash: "sha256:v1",
      metadata: {},
    });
    service.addArtifact({
      id: "design-v2",
      workspaceId: WORKSPACE,
      engagementId: "engagement",
      type: "design",
      title: "상세설계서",
      versionLabel: "v2",
      status: "DRAFT",
      storageUri: "minio://design-v2",
      contentHash: "sha256:v2",
      supersedesArtifactId: original.id,
      metadata: {},
    });
    const superseded = service.updateArtifactStatus(WORKSPACE, original.id, 1, "SUPERSEDED", "owner", "2026-08-14T01:00:00Z");
    expect(superseded.status).toBe("SUPERSEDED");

    const restarted = new CustomerWorkOsService();
    restarted.hydrateState(service.exportState());
    const artifacts = restarted.getEngagementSnapshot(WORKSPACE, "engagement").artifacts;
    expect(artifacts.map((item) => [item.id, item.status]).sort()).toEqual([
      ["design-v1", "SUPERSEDED"],
      ["design-v2", "DRAFT"],
    ]);
  });

  it("rejects cross-workspace artifact references", () => {
    const service = seeded();
    expectCode(
      () => service.addArtifact({
        id: "cross",
        workspaceId: "another-workspace",
        engagementId: "engagement",
        type: "other",
        title: "cross",
        versionLabel: "v1",
        status: "DRAFT",
        storageUri: "minio://cross",
        metadata: {},
      }),
      "CROSS_WORKSPACE",
    );
  });
});
