import { CustomerWorkOsV2Error, assertHuman, assertWorkspace, copy, mapValues, positive, required, sorted, type V2Actor } from "./shared.js";

export interface Resource { id: string; workspaceId: string; principalId: string; displayName: string; hourlyCostKrw: number; active: boolean; version: number; }
export interface Skill { id: string; workspaceId: string; resourceId: string; name: string; level: 1 | 2 | 3 | 4 | 5; version: number; }
export interface CapacityDay { id: string; workspaceId: string; resourceId: string; date: string; availableHours: number; leave: boolean; version: number; }
export interface ResourceAssignment { id: string; workspaceId: string; resourceId: string; projectId: string; date: string; plannedHours: number; version: number; }
export interface TimesheetEntry { id: string; workspaceId: string; resourceId: string; projectId: string; startedAt: string; endedAt: string; hours: number; status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED"; submittedByPrincipalId: string; approvedByPrincipalId: string | null; version: number; }
export interface PsaState { schemaVersion: 1; resources: Resource[]; skills: Skill[]; capacity: CapacityDay[]; assignments: ResourceAssignment[]; timesheets: TimesheetEntry[]; }

export class PsaCapacityService {
  private resources = new Map<string, Resource>();
  private skills = new Map<string, Skill>();
  private capacity = new Map<string, CapacityDay>();
  private assignments = new Map<string, ResourceAssignment>();
  private timesheets = new Map<string, TimesheetEntry>();

  addResource(input: Omit<Resource, "version">, actor: V2Actor): Resource {
    assertHuman(actor); assertWorkspace(actor.workspaceId, input.workspaceId);
    if (this.resources.has(input.id)) throw new CustomerWorkOsV2Error("DUPLICATE_RESOURCE", "resource already exists");
    const item: Resource = { ...copy(input), id: required(input.id, "resource.id"), displayName: required(input.displayName, "displayName"), hourlyCostKrw: positive(input.hourlyCostKrw, "hourlyCostKrw", true), version: 1 };
    this.resources.set(item.id, item); return copy(item);
  }

  addSkill(input: Omit<Skill, "version">, actor: V2Actor): Skill {
    assertHuman(actor); assertWorkspace(actor.workspaceId, input.workspaceId); this.resource(input.workspaceId, input.resourceId);
    const item: Skill = { ...copy(input), id: required(input.id, "skill.id"), name: required(input.name, "skill.name"), version: 1 };
    this.skills.set(item.id, item); return copy(item);
  }

  setCapacity(input: Omit<CapacityDay, "version">, actor: V2Actor): CapacityDay {
    assertHuman(actor); assertWorkspace(actor.workspaceId, input.workspaceId); this.resource(input.workspaceId, input.resourceId);
    const hours = positive(input.availableHours, "availableHours", true);
    if (hours > 24) throw new CustomerWorkOsV2Error("INVALID_CAPACITY", "daily capacity cannot exceed 24 hours");
    const existing = this.capacity.get(input.id);
    const item: CapacityDay = { ...copy(input), availableHours: input.leave ? 0 : hours, version: (existing?.version ?? 0) + 1 };
    this.capacity.set(required(item.id, "capacity.id"), item); return copy(item);
  }

  assign(input: Omit<ResourceAssignment, "version">, actor: V2Actor): ResourceAssignment {
    assertHuman(actor); assertWorkspace(actor.workspaceId, input.workspaceId); this.resource(input.workspaceId, input.resourceId);
    const day = [...this.capacity.values()].find((item) => item.workspaceId === input.workspaceId && item.resourceId === input.resourceId && item.date === input.date);
    if (!day || day.leave) throw new CustomerWorkOsV2Error("CAPACITY_UNAVAILABLE", "resource has no available capacity for the date");
    const plannedHours = positive(input.plannedHours, "plannedHours");
    const allocated = [...this.assignments.values()].filter((item) => item.workspaceId === input.workspaceId && item.resourceId === input.resourceId && item.date === input.date).reduce((sum, item) => sum + item.plannedHours, 0);
    if (allocated + plannedHours > day.availableHours) throw new CustomerWorkOsV2Error("OVER_ALLOCATED", "assignment exceeds available capacity");
    const item: ResourceAssignment = { ...copy(input), plannedHours, version: 1 };
    this.assignments.set(required(item.id, "assignment.id"), item); return copy(item);
  }

  submitTimesheet(input: Omit<TimesheetEntry, "version" | "status" | "approvedByPrincipalId">, actor: V2Actor): TimesheetEntry {
    assertHuman(actor); assertWorkspace(actor.workspaceId, input.workspaceId); this.resource(input.workspaceId, input.resourceId);
    if (actor.principalId !== input.submittedByPrincipalId) throw new CustomerWorkOsV2Error("TIMESHEET_OWNER_REQUIRED", "submitter must be the authenticated principal");
    const start = Date.parse(input.startedAt); const end = Date.parse(input.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new CustomerWorkOsV2Error("INVALID_TIME_RANGE", "timesheet time range is invalid");
    const hours = positive(input.hours, "hours");
    const overlaps = [...this.timesheets.values()].some((item) => item.workspaceId === input.workspaceId && item.resourceId === input.resourceId && item.status !== "REJECTED" && start < Date.parse(item.endedAt) && Date.parse(item.startedAt) < end);
    if (overlaps) throw new CustomerWorkOsV2Error("OVERLAPPING_TIME", "timesheet overlaps another entry");
    const item: TimesheetEntry = { ...copy(input), hours, status: "SUBMITTED", approvedByPrincipalId: null, version: 1 };
    this.timesheets.set(required(item.id, "timesheet.id"), item); return copy(item);
  }

  approveTimesheet(id: string, expectedVersion: number, actor: V2Actor): TimesheetEntry {
    assertHuman(actor); const current = this.timesheets.get(id); if (!current) throw new CustomerWorkOsV2Error("TIMESHEET_NOT_FOUND", "timesheet not found");
    assertWorkspace(actor.workspaceId, current.workspaceId);
    if (current.version !== expectedVersion) throw new CustomerWorkOsV2Error("CONCURRENT_MODIFICATION", "timesheet version changed");
    if (current.submittedByPrincipalId === actor.principalId) throw new CustomerWorkOsV2Error("SELF_APPROVAL", "submitter cannot approve their own timesheet");
    if (current.status !== "SUBMITTED") throw new CustomerWorkOsV2Error("INVALID_STATUS", "only submitted timesheets can be approved");
    const next: TimesheetEntry = { ...current, status: "APPROVED", approvedByPrincipalId: actor.principalId, version: current.version + 1 };
    this.timesheets.set(id, next); return copy(next);
  }

  utilization(workspaceId: string, resourceId: string): { availableHours: number; assignedHours: number; approvedHours: number; utilization: number; laborCostKrw: number } {
    const resource = this.resource(workspaceId, resourceId);
    const availableHours = [...this.capacity.values()].filter((item) => item.workspaceId === workspaceId && item.resourceId === resourceId).reduce((sum, item) => sum + item.availableHours, 0);
    const assignedHours = [...this.assignments.values()].filter((item) => item.workspaceId === workspaceId && item.resourceId === resourceId).reduce((sum, item) => sum + item.plannedHours, 0);
    const approvedHours = [...this.timesheets.values()].filter((item) => item.workspaceId === workspaceId && item.resourceId === resourceId && item.status === "APPROVED").reduce((sum, item) => sum + item.hours, 0);
    return { availableHours, assignedHours, approvedHours, utilization: availableHours === 0 ? 0 : assignedHours / availableHours, laborCostKrw: Math.round(approvedHours * resource.hourlyCostKrw) };
  }

  projectEac(workspaceId: string, projectId: string): number {
    return [...this.assignments.values()].filter((item) => item.workspaceId === workspaceId && item.projectId === projectId).reduce((sum, item) => sum + item.plannedHours * this.resource(workspaceId, item.resourceId).hourlyCostKrw, 0);
  }

  exportState(): PsaState { return { schemaVersion: 1, resources: sorted(this.resources.values()), skills: sorted(this.skills.values()), capacity: sorted(this.capacity.values()), assignments: sorted(this.assignments.values()), timesheets: sorted(this.timesheets.values()) }; }
  hydrateState(input: PsaState): void { if (input.schemaVersion !== 1) throw new CustomerWorkOsV2Error("UNSUPPORTED_STATE", "unsupported PSA state"); this.resources = mapValues(input.resources, "resource"); this.skills = mapValues(input.skills, "skill"); this.capacity = mapValues(input.capacity, "capacity"); this.assignments = mapValues(input.assignments, "assignment"); this.timesheets = mapValues(input.timesheets, "timesheet"); }
  private resource(workspaceId: string, id: string): Resource { const item = this.resources.get(id); if (!item) throw new CustomerWorkOsV2Error("RESOURCE_NOT_FOUND", `resource not found: ${id}`); assertWorkspace(workspaceId, item.workspaceId); if (!item.active) throw new CustomerWorkOsV2Error("INACTIVE_RESOURCE", "resource is inactive"); return item; }
}
