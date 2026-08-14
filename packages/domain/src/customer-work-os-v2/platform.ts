import { createHash } from "node:crypto";
import { AiCouncilService, type AiCouncilState } from "./ai.js";
import { MultiWorkspaceAdminService, type AdminState } from "./admin.js";
import { ReadFirstConnectorService, type ConnectorState } from "./connectors.js";
import { DynamicGraphRuntime, type GraphState } from "./graphs.js";
import { IdentityTeamService, type IdentityState } from "./identity.js";
import { UnifiedInboxService, type InboxState } from "./inbox.js";
import { ProductionReadinessService, type OperationsState } from "./operations.js";
import { PortalMobileService, type PortalState } from "./portal.js";
import { PsaCapacityService, type PsaState } from "./psa.js";
import {
  CWOS_V2_VERSIONS,
  CustomerWorkOsV2Error,
  assertHuman,
  assertStepUp,
  assertWorkspace,
  copy,
  required,
  type CwosV2Version,
  type Finding,
  type V2Actor,
} from "./shared.js";

export interface ReleaseMilestone {
  id: string;
  version: CwosV2Version;
  status: "PLANNED" | "IN_PROGRESS" | "COMPLETE";
  startedAt: string | null;
  completedAt: string | null;
  startedByPrincipalId: string | null;
  completedByPrincipalId: string | null;
  evidenceRefs: string[];
  recordVersion: number;
}

export interface ReleaseManifest {
  id: string;
  workspaceId: string;
  releaseVersion: "2.0.0";
  sourceCommitSha: string | null;
  sourceTreeSha: string | null;
  artifactRefs: string[];
  checksumRefs: string[];
  migrationRefs: string[];
  rollbackRefs: string[];
  operationsEvidenceRefs: string[];
  baselineStateHash: string;
  createdByPrincipalId: string;
  createdAt: string;
  recordVersion: number;
}

export interface CustomerWorkOsV2State {
  schemaVersion: 2;
  workspaceId: string;
  identity: IdentityState;
  psa: PsaState;
  inbox: InboxState;
  connectors: ConnectorState;
  graphs: GraphState;
  ai: AiCouncilState;
  portal: PortalState;
  admin: AdminState;
  operations: OperationsState;
  milestones: ReleaseMilestone[];
  findings: Finding[];
  releaseManifests: ReleaseManifest[];
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stable(record[key])]));
  }
  return value;
}

export function customerWorkOsV2StateHash(state: CustomerWorkOsV2State): string {
  return createHash("sha256").update(JSON.stringify(stable(state))).digest("hex");
}

function validIso(value: string, field: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new CustomerWorkOsV2Error("INVALID_INPUT", `${field} must be an ISO date-time`);
  }
  return value;
}

function uniqueStrings(values: readonly string[], field: string, allowEmpty = false): string[] {
  const normalized = [...new Set(values.map((value) => required(value, field)))].sort();
  if (!allowEmpty && normalized.length === 0) {
    throw new CustomerWorkOsV2Error("EVIDENCE_REQUIRED", `${field} requires at least one reference`);
  }
  return normalized;
}

function firstString(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function refs(input: Record<string, unknown>, arrayKeys: readonly string[], scalarKeys: readonly string[]): string[] {
  const values: string[] = [];
  for (const key of arrayKeys) {
    const value = input[key];
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string" && item.trim()) values.push(item.trim());
    }
  }
  for (const key of scalarKeys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) values.push(value.trim());
  }
  return [...new Set(values)].sort();
}

function validateOptionalGitSha(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(value)) {
    throw new CustomerWorkOsV2Error("INVALID_RELEASE_MANIFEST", `${field} must be a 40- or 64-character hexadecimal digest`);
  }
  return value.toLowerCase();
}

function assertNestedWorkspace(value: unknown, workspaceId: string, path = "state"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNestedWorkspace(item, workspaceId, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.workspaceId === "string" && record.workspaceId !== workspaceId) {
    throw new CustomerWorkOsV2Error("CROSS_WORKSPACE_STATE", `${path}.workspaceId does not match aggregate workspace`);
  }
  for (const [key, item] of Object.entries(record)) {
    assertNestedWorkspace(item, workspaceId, `${path}.${key}`);
  }
}

function initialMilestones(): ReleaseMilestone[] {
  return CWOS_V2_VERSIONS.map((version) => ({
    id: `milestone-${version}`,
    version,
    status: "PLANNED" as const,
    startedAt: null,
    completedAt: null,
    startedByPrincipalId: null,
    completedByPrincipalId: null,
    evidenceRefs: [],
    recordVersion: 1,
  }));
}

export class CustomerWorkOsV2Platform {
  readonly identity = new IdentityTeamService();
  readonly psa = new PsaCapacityService();
  readonly inbox = new UnifiedInboxService();
  readonly connectors = new ReadFirstConnectorService();
  readonly graphs = new DynamicGraphRuntime();
  readonly ai = new AiCouncilService();
  readonly portal = new PortalMobileService();
  readonly admin = new MultiWorkspaceAdminService();
  readonly operations = new ProductionReadinessService();

  private milestones = initialMilestones();
  private findings = new Map<string, Finding>();
  private releaseManifests = new Map<string, ReleaseManifest>();

  constructor(
    readonly workspaceId: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    required(workspaceId, "workspaceId");
  }

  startMilestone(version: CwosV2Version, actor: V2Actor): ReleaseMilestone {
    assertHuman(actor);
    assertWorkspace(this.workspaceId, actor.workspaceId);
    const index = this.versionIndex(version);
    if (this.milestones.slice(0, index).some((item) => item.status !== "COMPLETE")) {
      throw new CustomerWorkOsV2Error("MILESTONE_ORDER", "all earlier milestones must be complete");
    }
    const current = this.milestones[index];
    if (!current) throw new CustomerWorkOsV2Error("MILESTONE_NOT_FOUND", `unknown milestone ${version}`);
    if (current.status !== "PLANNED") {
      throw new CustomerWorkOsV2Error("INVALID_STATUS", "only a planned milestone can start");
    }
    const startedAt = validIso(this.now(), "startedAt");
    const next: ReleaseMilestone = {
      ...current,
      status: "IN_PROGRESS",
      startedAt,
      startedByPrincipalId: actor.principalId,
      recordVersion: current.recordVersion + 1,
    };
    this.milestones[index] = next;
    return copy(next);
  }

  completeMilestone(version: CwosV2Version, evidenceRefs: string[], actor: V2Actor): ReleaseMilestone {
    assertHuman(actor);
    assertWorkspace(this.workspaceId, actor.workspaceId);
    const index = this.versionIndex(version);
    const current = this.milestones[index];
    if (!current) throw new CustomerWorkOsV2Error("MILESTONE_NOT_FOUND", `unknown milestone ${version}`);
    if (current.status !== "IN_PROGRESS") {
      throw new CustomerWorkOsV2Error("INVALID_STATUS", "only an in-progress milestone can complete");
    }
    if ([...this.findings.values()].some((item) => item.version === version && item.status === "OPEN")) {
      throw new CustomerWorkOsV2Error("OPEN_FINDINGS", "milestone has unresolved findings");
    }
    const completedAt = validIso(this.now(), "completedAt");
    const next: ReleaseMilestone = {
      ...current,
      status: "COMPLETE",
      completedAt,
      completedByPrincipalId: actor.principalId,
      evidenceRefs: uniqueStrings(evidenceRefs, "milestone.evidenceRefs"),
      recordVersion: current.recordVersion + 1,
    };
    this.milestones[index] = next;
    return copy(next);
  }

  recordFinding(
    input: Omit<Finding, "status" | "evidenceRef">,
    actor: V2Actor,
  ): Finding {
    assertHuman(actor);
    assertWorkspace(this.workspaceId, actor.workspaceId);
    if (this.findings.has(input.id)) {
      throw new CustomerWorkOsV2Error("DUPLICATE_FINDING", "finding already exists");
    }
    this.versionIndex(input.version);
    const finding: Finding = {
      ...copy(input),
      id: required(input.id, "finding.id"),
      title: required(input.title, "finding.title"),
      status: "OPEN",
      evidenceRef: null,
    };
    this.findings.set(finding.id, finding);
    return copy(finding);
  }

  resolveFinding(id: string, evidenceRef: string, actor: V2Actor): Finding {
    assertHuman(actor);
    assertWorkspace(this.workspaceId, actor.workspaceId);
    const current = this.findings.get(id);
    if (!current) throw new CustomerWorkOsV2Error("FINDING_NOT_FOUND", "finding not found");
    if (current.status !== "OPEN") {
      throw new CustomerWorkOsV2Error("INVALID_STATUS", "finding is already resolved");
    }
    const next: Finding = {
      ...current,
      status: "RESOLVED",
      evidenceRef: required(evidenceRef, "evidenceRef"),
    };
    this.findings.set(id, next);
    return copy(next);
  }

  createReleaseManifest(input: Record<string, unknown>, actor: V2Actor): ReleaseManifest {
    assertStepUp(actor);
    assertWorkspace(this.workspaceId, actor.workspaceId);
    const workspaceId = firstString(input, ["workspaceId"]) ?? actor.workspaceId;
    assertWorkspace(this.workspaceId, workspaceId);
    const releaseVersion = firstString(input, ["releaseVersion", "version"]);
    if (releaseVersion !== "2.0.0") {
      throw new CustomerWorkOsV2Error("INVALID_RELEASE_MANIFEST", "releaseVersion must be 2.0.0");
    }
    if (this.milestones.some((item) => item.status !== "COMPLETE")) {
      throw new CustomerWorkOsV2Error("MILESTONES_INCOMPLETE", "all release milestones must be complete");
    }
    if ([...this.findings.values()].some((item) => item.status === "OPEN")) {
      throw new CustomerWorkOsV2Error("OPEN_FINDINGS", "release manifest cannot be created with open findings");
    }
    const readiness = this.operations.readiness(this.workspaceId);
    if (!readiness.ready) {
      throw new CustomerWorkOsV2Error(
        "OPERATIONS_GATES_INCOMPLETE",
        `operations gates are incomplete: ${readiness.failures.join(",")}`,
      );
    }

    const id = firstString(input, ["id", "manifestId"]);
    if (!id) throw new CustomerWorkOsV2Error("INVALID_RELEASE_MANIFEST", "manifest id is required");
    if (this.releaseManifests.has(id)) {
      throw new CustomerWorkOsV2Error("DUPLICATE_RELEASE_MANIFEST", "release manifest already exists");
    }

    const artifactRefs = refs(
      input,
      ["artifactRefs", "artifacts"],
      ["artifactRef", "manifestRef", "sbomRef", "releaseNotesRef"],
    );
    const checksumRefs = refs(input, ["checksumRefs", "checksums"], ["checksumRef"]);
    const migrationRefs = refs(input, ["migrationRefs", "migrations"], ["migrationRef"]);
    const rollbackRefs = refs(input, ["rollbackRefs", "rollbacks"], ["rollbackRef", "rollbackPlanRef"]);
    const operationsEvidenceRefs = refs(
      input,
      ["operationsEvidenceRefs", "evidenceRefs"],
      ["operationsEvidenceRef", "validationRef", "releaseGateRef"],
    );

    const manifest: ReleaseManifest = {
      id: required(id, "manifest.id"),
      workspaceId: this.workspaceId,
      releaseVersion: "2.0.0",
      sourceCommitSha: validateOptionalGitSha(firstString(input, ["sourceCommitSha", "commitSha", "headSha"]), "sourceCommitSha"),
      sourceTreeSha: validateOptionalGitSha(firstString(input, ["sourceTreeSha", "treeSha", "treeHash"]), "sourceTreeSha"),
      artifactRefs: uniqueStrings(artifactRefs, "artifactRefs"),
      checksumRefs: uniqueStrings(checksumRefs, "checksumRefs"),
      migrationRefs: uniqueStrings(migrationRefs, "migrationRefs"),
      rollbackRefs: uniqueStrings(rollbackRefs, "rollbackRefs"),
      operationsEvidenceRefs: uniqueStrings(operationsEvidenceRefs, "operationsEvidenceRefs"),
      baselineStateHash: customerWorkOsV2StateHash(this.exportState()),
      createdByPrincipalId: actor.principalId,
      createdAt: validIso(this.now(), "createdAt"),
      recordVersion: 1,
    };
    this.releaseManifests.set(manifest.id, manifest);
    return copy(manifest);
  }

  exportState(): CustomerWorkOsV2State {
    return {
      schemaVersion: 2,
      workspaceId: this.workspaceId,
      identity: this.identity.exportState(),
      psa: this.psa.exportState(),
      inbox: this.inbox.exportState(),
      connectors: this.connectors.exportState(),
      graphs: this.graphs.exportState(),
      ai: this.ai.exportState(),
      portal: this.portal.exportState(),
      admin: this.admin.exportState(),
      operations: this.operations.exportState(),
      milestones: this.milestones.map((item) => copy(item)),
      findings: [...this.findings.values()].map((item) => copy(item)).sort((left, right) => left.id.localeCompare(right.id)),
      releaseManifests: [...this.releaseManifests.values()].map((item) => copy(item)).sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  hydrateState(input: CustomerWorkOsV2State): void {
    if (input.schemaVersion !== 2) {
      throw new CustomerWorkOsV2Error("UNSUPPORTED_STATE", "unsupported Customer Work OS v2 state");
    }
    assertWorkspace(this.workspaceId, input.workspaceId);
    assertNestedWorkspace(input, this.workspaceId);

    const milestoneVersions = new Set<CwosV2Version>();
    for (const milestone of input.milestones) {
      this.versionIndex(milestone.version);
      if (milestoneVersions.has(milestone.version)) {
        throw new CustomerWorkOsV2Error("INVALID_STATE", `duplicate milestone ${milestone.version}`);
      }
      milestoneVersions.add(milestone.version);
      if (milestone.status === "PLANNED" && (milestone.startedAt !== null || milestone.completedAt !== null)) {
        throw new CustomerWorkOsV2Error("INVALID_STATE", "planned milestone cannot contain execution timestamps");
      }
      if (milestone.status === "IN_PROGRESS" && milestone.startedAt === null) {
        throw new CustomerWorkOsV2Error("INVALID_STATE", "in-progress milestone requires startedAt");
      }
      if (milestone.status === "COMPLETE" && (milestone.startedAt === null || milestone.completedAt === null || milestone.evidenceRefs.length === 0)) {
        throw new CustomerWorkOsV2Error("INVALID_STATE", "complete milestone requires timestamps and evidence");
      }
    }
    if (milestoneVersions.size !== CWOS_V2_VERSIONS.length) {
      throw new CustomerWorkOsV2Error("INVALID_STATE", "state must contain every v2 milestone exactly once");
    }

    const findings = new Map<string, Finding>();
    for (const finding of input.findings) {
      if (findings.has(finding.id)) throw new CustomerWorkOsV2Error("INVALID_STATE", `duplicate finding ${finding.id}`);
      this.versionIndex(finding.version);
      findings.set(required(finding.id, "finding.id"), copy(finding));
    }
    const manifests = new Map<string, ReleaseManifest>();
    for (const manifest of input.releaseManifests) {
      if (manifest.workspaceId !== this.workspaceId || manifest.releaseVersion !== "2.0.0") {
        throw new CustomerWorkOsV2Error("INVALID_STATE", "release manifest identity is invalid");
      }
      if (manifests.has(manifest.id)) {
        throw new CustomerWorkOsV2Error("INVALID_STATE", `duplicate release manifest ${manifest.id}`);
      }
      manifests.set(required(manifest.id, "manifest.id"), copy(manifest));
    }

    this.identity.hydrateState(copy(input.identity));
    this.psa.hydrateState(copy(input.psa));
    this.inbox.hydrateState(copy(input.inbox));
    this.connectors.hydrateState(copy(input.connectors));
    this.graphs.hydrateState(copy(input.graphs));
    this.ai.hydrateState(copy(input.ai));
    this.portal.hydrateState(copy(input.portal));
    this.admin.hydrateState(copy(input.admin));
    this.operations.hydrateState(copy(input.operations));
    this.milestones = CWOS_V2_VERSIONS.map((version) => {
      const milestone = input.milestones.find((item) => item.version === version);
      if (!milestone) throw new CustomerWorkOsV2Error("INVALID_STATE", `missing milestone ${version}`);
      return copy(milestone);
    });
    this.findings = findings;
    this.releaseManifests = manifests;
  }

  private versionIndex(version: CwosV2Version): number {
    const index = CWOS_V2_VERSIONS.indexOf(version);
    if (index < 0) throw new CustomerWorkOsV2Error("MILESTONE_NOT_FOUND", `unknown milestone ${String(version)}`);
    return index;
  }
}
