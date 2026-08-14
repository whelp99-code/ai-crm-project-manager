import { describe, expect, it } from "vitest";
import {
  CWOS_V2_VERSIONS,
  CustomerWorkOsV2Error,
  CustomerWorkOsV2Platform,
  type RecoveryDrill,
  type SecurityEvidence,
  type V2Actor,
} from "../src/customer-work-os-v2/index.js";

const workspaceId = "workspace-v2";
const owner: V2Actor = {
  principalId: "owner-1",
  workspaceId,
  kind: "human",
  stepUpVerified: true,
};

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CustomerWorkOsV2Error);
    expect((error as CustomerWorkOsV2Error).code).toBe(code);
  }
}

function seedOperations(platform: CustomerWorkOsV2Platform): void {
  platform.operations.defineSlo(
    {
      id: "slo-api",
      workspaceId,
      service: "cwos-v2-api",
      availabilityTarget: 0.999,
      latencyP95Ms: 1000,
      errorBudgetMinutes: 43,
    },
    owner,
  );
  const drillKinds: RecoveryDrill["kind"][] = [
    "BACKUP_RESTORE",
    "FAILOVER",
    "DR",
    "ROLLBACK",
    "SOAK",
    "LOAD",
  ];
  for (const [index, kind] of drillKinds.entries()) {
    platform.operations.recordDrill(
      {
        id: `drill-${kind.toLowerCase()}`,
        workspaceId,
        kind,
        startedAt: `2026-08-01T0${index}:00:00.000Z`,
        completedAt: `2026-08-01T0${index}:30:00.000Z`,
        passed: true,
        rtoMinutes: 30,
        rpoMinutes: 15,
        evidenceRef: `evidence://drill/${kind}`,
      },
      owner,
    );
  }
  platform.operations.registerPilot(
    {
      id: "pilot-1",
      workspaceId,
      tenantName: "controlled-pilot",
      status: "PASSED",
      acceptanceEvidenceRefs: ["evidence://pilot/acceptance"],
    },
    owner,
  );
  platform.operations.addRunbook(
    {
      id: "runbook-rollback",
      workspaceId,
      kind: "ROLLBACK",
      title: "CWOS v2 rollback",
      contentHash: "a".repeat(64),
      evidenceRef: "evidence://runbook/rollback",
    },
    owner,
  );
  platform.operations.recordCutover(
    {
      id: "cutover-1",
      workspaceId,
      source: "NOTION",
      freezeAt: "2026-08-02T00:00:00.000Z",
      snapshotHash: "b".repeat(64),
      reconciliationOpen: 0,
      postgresAuthoritative: true,
      rollbackRunbookId: "runbook-rollback",
      approvedByPrincipalId: "independent-approver",
    },
    owner,
  );
  const securityKinds: SecurityEvidence["kind"][] = [
    "SBOM",
    "DEPENDENCY_AUDIT",
    "PEN_TEST",
    "ACCESS_REVIEW",
  ];
  for (const kind of securityKinds) {
    platform.operations.addSecurityEvidence(
      {
        id: `security-${kind.toLowerCase()}`,
        workspaceId,
        kind,
        passed: true,
        evidenceRef: `evidence://security/${kind}`,
      },
      owner,
    );
  }
}

describe("Customer Work OS v2 aggregate", () => {
  it("rejects cross-workspace hydration and duplicate milestone state", () => {
    const platform = new CustomerWorkOsV2Platform(workspaceId, () => "2026-08-15T00:00:00.000Z");
    platform.identity.registerPrincipal(
      {
        id: owner.principalId,
        workspaceId,
        kind: "human",
        displayName: "Owner",
        active: true,
        oidcIssuer: null,
        oidcSubject: null,
      },
      owner,
    );
    platform.identity.addMembership(
      { id: "membership-owner", workspaceId, principalId: owner.principalId, status: "ACTIVE" },
      owner,
    );

    const crossWorkspace = platform.exportState();
    crossWorkspace.identity.principals[0]!.workspaceId = "other-workspace";
    expectCode(() => new CustomerWorkOsV2Platform(workspaceId).hydrateState(crossWorkspace), "CROSS_WORKSPACE_STATE");

    const duplicateMilestone = platform.exportState();
    duplicateMilestone.milestones.push(structuredClone(duplicateMilestone.milestones[0]!));
    expectCode(() => new CustomerWorkOsV2Platform(workspaceId).hydrateState(duplicateMilestone), "INVALID_STATE");
  });

  it("enforces graph, connector, PSA, AI and portal safety invariants", () => {
    const platform = new CustomerWorkOsV2Platform(workspaceId);
    expectCode(
      () => platform.graphs.register(
        {
          id: "graph-cycle",
          workspaceId,
          name: "undeclared cycle",
          nodes: [
            { id: "a", type: "ACTION", sideEffect: false },
            { id: "b", type: "END", sideEffect: false },
          ],
          edges: [{ from: "a", to: "a", condition: null }],
          loopPolicy: null,
          definitionHash: "c".repeat(64),
        },
        owner,
      ),
      "UNDECLARED_CYCLE",
    );
    expectCode(
      () => platform.connectors.register(
        {
          id: "connector-1",
          workspaceId,
          provider: "GMAIL",
          mode: "READ_ONLY",
          permissions: ["mail.read"],
          secretRef: "raw-secret",
        },
        owner,
      ),
      "RAW_SECRET_FORBIDDEN",
    );

    platform.psa.addResource(
      { id: "resource-1", workspaceId, principalId: owner.principalId, displayName: "Owner", hourlyCostKrw: 100000, active: true },
      owner,
    );
    platform.psa.setCapacity(
      { id: "capacity-1", workspaceId, resourceId: "resource-1", date: "2026-08-15", availableHours: 8, leave: false },
      owner,
    );
    platform.psa.assign(
      { id: "assignment-1", workspaceId, resourceId: "resource-1", projectId: "project-1", date: "2026-08-15", plannedHours: 8 },
      owner,
    );
    expectCode(
      () => platform.psa.assign(
        { id: "assignment-2", workspaceId, resourceId: "resource-1", projectId: "project-2", date: "2026-08-15", plannedHours: 1 },
        owner,
      ),
      "OVER_ALLOCATED",
    );

    platform.ai.openCouncil(
      { id: "council-1", workspaceId, topic: "release", participantPrincipalIds: ["model-a", "model-b"], budgetUsd: 1 },
      owner,
    );
    platform.ai.addClaim({
      id: "claim-1",
      workspaceId,
      councilId: "council-1",
      authorPrincipalId: "model-a",
      text: "claim",
      evidenceRefs: ["evidence://claim"],
      confidence: 0.8,
      costUsd: 0.1,
    });
    expectCode(
      () => platform.ai.critique({
        id: "critique-1",
        workspaceId,
        councilId: "council-1",
        claimId: "claim-1",
        authorPrincipalId: "model-a",
        text: "self critique",
        evidenceRefs: ["evidence://critique"],
      }),
      "SELF_REVIEW",
    );

    expectCode(
      () => platform.portal.grant(
        {
          id: "grant-1",
          workspaceId,
          principalId: "customer-1",
          accountId: "account-1",
          engagementIds: ["engagement-1"],
          allowedFields: ["finance.bankAccount"],
          expiresAt: "2026-09-01T00:00:00.000Z",
        },
        owner,
      ),
      "PORTAL_OVEREXPOSURE",
    );
  });

  it("requires every operations gate before creating the v2.0.0 release manifest", () => {
    let tick = 0;
    const platform = new CustomerWorkOsV2Platform(
      workspaceId,
      () => new Date(Date.UTC(2026, 7, 15, 0, tick++)).toISOString(),
    );
    for (const version of CWOS_V2_VERSIONS) {
      platform.startMilestone(version, owner);
      platform.completeMilestone(version, [`evidence://milestone/${version}`], owner);
    }

    expectCode(
      () => platform.createReleaseManifest(
        {
          id: "manifest-v2",
          workspaceId,
          releaseVersion: "2.0.0",
          artifactRefs: ["evidence://artifact/package"],
          checksumRefs: ["evidence://artifact/checksum"],
          migrationRefs: ["evidence://migration/0019"],
          rollbackRefs: ["evidence://runbook/rollback"],
          operationsEvidenceRefs: ["evidence://release/gate"],
        },
        owner,
      ),
      "OPERATIONS_GATES_INCOMPLETE",
    );

    seedOperations(platform);
    const manifest = platform.createReleaseManifest(
      {
        id: "manifest-v2",
        workspaceId,
        releaseVersion: "2.0.0",
        sourceCommitSha: "d".repeat(40),
        sourceTreeSha: "e".repeat(40),
        artifactRefs: ["evidence://artifact/package", "evidence://artifact/sbom"],
        checksumRefs: ["evidence://artifact/checksum"],
        migrationRefs: ["evidence://migration/0019"],
        rollbackRefs: ["evidence://runbook/rollback"],
        operationsEvidenceRefs: ["evidence://release/gate"],
      },
      owner,
    );
    expect(manifest.releaseVersion).toBe("2.0.0");
    expect(platform.exportState().releaseManifests).toHaveLength(1);
    expect(platform.operations.readiness(workspaceId)).toEqual({ ready: true, failures: [] });
  });
});
