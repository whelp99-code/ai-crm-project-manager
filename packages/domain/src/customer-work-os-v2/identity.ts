import {
  CustomerWorkOsV2Error,
  assertApproval,
  assertHuman,
  assertStepUp,
  assertWorkspace,
  copy,
  mapValues,
  required,
  sorted,
  type HumanApproval,
  type PrincipalKind,
  type V2Actor,
} from "./shared.js";

export interface IdentityPrincipal {
  id: string;
  workspaceId: string;
  kind: PrincipalKind;
  displayName: string;
  active: boolean;
  oidcIssuer: string | null;
  oidcSubject: string | null;
  version: number;
}

export interface WorkspaceMembership {
  id: string;
  workspaceId: string;
  principalId: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  version: number;
}

export interface Team {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
}

export interface RoleBinding {
  id: string;
  workspaceId: string;
  principalId: string;
  teamId: string | null;
  role: "WORKSPACE_ADMIN" | "TEAM_LEAD" | "OPERATOR" | "REVIEWER" | "AUDITOR" | "PORTAL_USER";
  active: boolean;
  version: number;
}

export interface Delegation {
  id: string;
  workspaceId: string;
  fromPrincipalId: string;
  toPrincipalId: string;
  role: RoleBinding["role"];
  startsAt: string;
  endsAt: string;
  revokedAt: string | null;
  version: number;
}

export interface BreakGlassSession {
  id: string;
  workspaceId: string;
  principalId: string;
  reason: string;
  startsAt: string;
  expiresAt: string;
  approvedByPrincipalId: string;
  closedAt: string | null;
  version: number;
}

export interface IdentityState {
  schemaVersion: 1;
  principals: IdentityPrincipal[];
  memberships: WorkspaceMembership[];
  teams: Team[];
  roleBindings: RoleBinding[];
  delegations: Delegation[];
  breakGlassSessions: BreakGlassSession[];
  consumedApprovalIds: string[];
}

export class IdentityTeamService {
  private principals = new Map<string, IdentityPrincipal>();
  private memberships = new Map<string, WorkspaceMembership>();
  private teams = new Map<string, Team>();
  private roleBindings = new Map<string, RoleBinding>();
  private delegations = new Map<string, Delegation>();
  private breakGlassSessions = new Map<string, BreakGlassSession>();
  private consumedApprovalIds = new Set<string>();

  registerPrincipal(input: Omit<IdentityPrincipal, "version">, actor: V2Actor): IdentityPrincipal {
    assertStepUp(actor);
    assertWorkspace(actor.workspaceId, input.workspaceId);
    if (this.principals.has(input.id)) throw new CustomerWorkOsV2Error("DUPLICATE_PRINCIPAL", "principal already exists");
    if (input.kind !== "human" && (input.oidcIssuer !== null || input.oidcSubject !== null)) {
      throw new CustomerWorkOsV2Error("AI_IMPERSONATION", "only human principals may bind an OIDC subject");
    }
    const principal: IdentityPrincipal = {
      ...copy(input),
      id: required(input.id, "principal.id"),
      workspaceId: required(input.workspaceId, "workspaceId"),
      displayName: required(input.displayName, "displayName"),
      version: 1,
    };
    this.principals.set(principal.id, principal);
    return copy(principal);
  }

  bindOidc(input: { principalId: string; issuer: string; subject: string }, actor: V2Actor): IdentityPrincipal {
    assertStepUp(actor);
    const principal = this.principal(actor.workspaceId, input.principalId);
    if (principal.kind !== "human" || !principal.active) throw new CustomerWorkOsV2Error("INACTIVE_PRINCIPAL", "active human principal required");
    const issuer = required(input.issuer, "issuer");
    const subject = required(input.subject, "subject");
    const duplicate = [...this.principals.values()].find((candidate) => candidate.oidcIssuer === issuer && candidate.oidcSubject === subject && candidate.id !== principal.id);
    if (duplicate) throw new CustomerWorkOsV2Error("OIDC_SUBJECT_CONFLICT", "OIDC subject is already bound");
    const next = { ...principal, oidcIssuer: issuer, oidcSubject: subject, version: principal.version + 1 };
    this.principals.set(next.id, next);
    return copy(next);
  }

  addMembership(input: Omit<WorkspaceMembership, "version">, actor: V2Actor): WorkspaceMembership {
    assertStepUp(actor);
    assertWorkspace(actor.workspaceId, input.workspaceId);
    const principal = this.principal(input.workspaceId, input.principalId);
    if (!principal.active) throw new CustomerWorkOsV2Error("INACTIVE_PRINCIPAL", "inactive principal cannot join a workspace");
    if (this.memberships.has(input.id)) throw new CustomerWorkOsV2Error("DUPLICATE_MEMBERSHIP", "membership already exists");
    const membership: WorkspaceMembership = { ...copy(input), id: required(input.id, "membership.id"), version: 1 };
    this.memberships.set(membership.id, membership);
    return copy(membership);
  }

  addTeam(input: Omit<Team, "version">, actor: V2Actor): Team {
    assertHuman(actor);
    assertWorkspace(actor.workspaceId, input.workspaceId);
    this.assertActiveMember(actor);
    if (this.teams.has(input.id)) throw new CustomerWorkOsV2Error("DUPLICATE_TEAM", "team already exists");
    const team: Team = { ...copy(input), id: required(input.id, "team.id"), name: required(input.name, "team.name"), version: 1 };
    this.teams.set(team.id, team);
    return copy(team);
  }

  bindRole(input: Omit<RoleBinding, "version" | "active"> & { payloadHash: string; approval: HumanApproval }, actor: V2Actor): RoleBinding {
    assertStepUp(actor);
    assertWorkspace(actor.workspaceId, input.workspaceId);
    this.assertActiveMember(actor);
    const target = this.principal(input.workspaceId, input.principalId);
    if (!target.active || target.kind !== "human") throw new CustomerWorkOsV2Error("AI_IMPERSONATION", "roles may be granted only to active human principals");
    if (input.teamId !== null) this.team(input.workspaceId, input.teamId);
    assertApproval({
      approval: input.approval,
      actor,
      action: "ROLE_BIND",
      resourceId: input.id,
      resourceVersion: 1,
      payloadHash: input.payloadHash,
      consumedApprovalIds: this.consumedApprovalIds,
    });
    const binding: RoleBinding = {
      id: required(input.id, "roleBinding.id"),
      workspaceId: input.workspaceId,
      principalId: input.principalId,
      teamId: input.teamId,
      role: input.role,
      active: true,
      version: 1,
    };
    this.roleBindings.set(binding.id, binding);
    this.consumedApprovalIds.add(input.approval.approvalId);
    return copy(binding);
  }

  createDelegation(input: Omit<Delegation, "version" | "revokedAt">, actor: V2Actor): Delegation {
    assertHuman(actor);
    assertWorkspace(actor.workspaceId, input.workspaceId);
    if (actor.principalId !== input.fromPrincipalId) throw new CustomerWorkOsV2Error("DELEGATION_OWNER_REQUIRED", "only the delegating principal may create a delegation");
    this.assertActiveMember(actor);
    const target = this.principal(input.workspaceId, input.toPrincipalId);
    if (!target.active || target.kind !== "human") throw new CustomerWorkOsV2Error("INVALID_DELEGATE", "delegate must be an active human principal");
    if (Date.parse(input.startsAt) >= Date.parse(input.endsAt)) throw new CustomerWorkOsV2Error("INVALID_DELEGATION_WINDOW", "delegation end must follow start");
    const delegation: Delegation = { ...copy(input), revokedAt: null, version: 1 };
    this.delegations.set(required(delegation.id, "delegation.id"), delegation);
    return copy(delegation);
  }

  openBreakGlass(input: { id: string; workspaceId: string; reason: string; startsAt: string; expiresAt: string; payloadHash: string; approval: HumanApproval }, actor: V2Actor): BreakGlassSession {
    assertStepUp(actor);
    assertWorkspace(actor.workspaceId, input.workspaceId);
    this.assertActiveMember(actor);
    if (Date.parse(input.startsAt) >= Date.parse(input.expiresAt)) throw new CustomerWorkOsV2Error("INVALID_BREAK_GLASS_WINDOW", "break-glass expiry must follow start");
    assertApproval({ approval: input.approval, actor, action: "BREAK_GLASS_OPEN", resourceId: input.id, resourceVersion: 1, payloadHash: input.payloadHash, consumedApprovalIds: this.consumedApprovalIds });
    const session: BreakGlassSession = {
      id: required(input.id, "breakGlass.id"),
      workspaceId: input.workspaceId,
      principalId: actor.principalId,
      reason: required(input.reason, "reason"),
      startsAt: input.startsAt,
      expiresAt: input.expiresAt,
      approvedByPrincipalId: input.approval.approvedByPrincipalId,
      closedAt: null,
      version: 1,
    };
    this.breakGlassSessions.set(session.id, session);
    this.consumedApprovalIds.add(input.approval.approvalId);
    return copy(session);
  }

  effectiveRoles(workspaceId: string, principalId: string, at: string): RoleBinding["role"][] {
    const principal = this.principal(workspaceId, principalId);
    if (!principal.active) return [];
    const membership = [...this.memberships.values()].find((item) => item.workspaceId === workspaceId && item.principalId === principalId && item.status === "ACTIVE");
    if (!membership) return [];
    const direct = [...this.roleBindings.values()].filter((item) => item.workspaceId === workspaceId && item.principalId === principalId && item.active).map((item) => item.role);
    const delegated = [...this.delegations.values()].filter((item) => item.workspaceId === workspaceId && item.toPrincipalId === principalId && item.revokedAt === null && Date.parse(item.startsAt) <= Date.parse(at) && Date.parse(at) < Date.parse(item.endsAt)).map((item) => item.role);
    return [...new Set([...direct, ...delegated])].sort();
  }

  exportState(): IdentityState {
    return {
      schemaVersion: 1,
      principals: sorted(this.principals.values()),
      memberships: sorted(this.memberships.values()),
      teams: sorted(this.teams.values()),
      roleBindings: sorted(this.roleBindings.values()),
      delegations: sorted(this.delegations.values()),
      breakGlassSessions: sorted(this.breakGlassSessions.values()),
      consumedApprovalIds: [...this.consumedApprovalIds].sort(),
    };
  }

  hydrateState(input: IdentityState): void {
    if (input.schemaVersion !== 1) throw new CustomerWorkOsV2Error("UNSUPPORTED_STATE", "unsupported identity state");
    const nextPrincipals = mapValues(input.principals, "principal");
    for (const principal of nextPrincipals.values()) {
      if (!principal.active && [...input.memberships].some((membership) => membership.principalId === principal.id && membership.status === "ACTIVE")) {
        throw new CustomerWorkOsV2Error("INVALID_STATE", "inactive principal cannot retain an active membership");
      }
    }
    this.principals = nextPrincipals;
    this.memberships = mapValues(input.memberships, "membership");
    this.teams = mapValues(input.teams, "team");
    this.roleBindings = mapValues(input.roleBindings, "roleBinding");
    this.delegations = mapValues(input.delegations, "delegation");
    this.breakGlassSessions = mapValues(input.breakGlassSessions, "breakGlassSession");
    this.consumedApprovalIds = new Set(input.consumedApprovalIds.map((id) => required(id, "approvalId")));
  }

  private principal(workspaceId: string, id: string): IdentityPrincipal {
    const principal = this.principals.get(id);
    if (!principal) throw new CustomerWorkOsV2Error("PRINCIPAL_NOT_FOUND", `principal not found: ${id}`);
    assertWorkspace(workspaceId, principal.workspaceId);
    return principal;
  }

  private team(workspaceId: string, id: string): Team {
    const team = this.teams.get(id);
    if (!team) throw new CustomerWorkOsV2Error("TEAM_NOT_FOUND", `team not found: ${id}`);
    assertWorkspace(workspaceId, team.workspaceId);
    return team;
  }

  private assertActiveMember(actor: V2Actor): void {
    const principal = this.principal(actor.workspaceId, actor.principalId);
    if (!principal.active || principal.kind !== "human") throw new CustomerWorkOsV2Error("INACTIVE_PRINCIPAL", "active human principal required");
    const active = [...this.memberships.values()].some((membership) => membership.workspaceId === actor.workspaceId && membership.principalId === actor.principalId && membership.status === "ACTIVE");
    if (!active) throw new CustomerWorkOsV2Error("MEMBERSHIP_REQUIRED", "active workspace membership required");
  }
}
