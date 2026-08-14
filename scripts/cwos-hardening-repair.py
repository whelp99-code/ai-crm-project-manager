from pathlib import Path

source = Path("packages/domain/src/customer-work-os.ts")
text = source.read_text()

old = '  private readonly settlements = new Map<string, Settlement>();\n  private readonly consumedReceiptIds = new Set<string>();'
new = '  private readonly settlements = new Map<string, Settlement>();\n  private readonly financialItemBaseLifecycle = new Map<string, FinancialItem["lifecycle"]>();\n  private readonly consumedReceiptIds = new Set<string>();'
if old not in text and new not in text:
    raise SystemExit("financial lifecycle map marker not found")
text = text.replace(old, new)

marker = '\n  proposeChangeRequest(input: Omit<ChangeRequest, "status" | "version">): ChangeRequest {'
methods = '''

  updateDeliverableStatus(
    workspaceId: string,
    projectId: string,
    expectedVersion: number,
    deliverableId: string,
    status: Deliverable["status"],
    evidenceRef?: string,
  ): DeliveryProject {
    const project = this.versioned(this.deliveryProjects, workspaceId, projectId, expectedVersion, "delivery project");
    if (project.status === "COMPLETE" || project.status === "CANCELLED") {
      throw new CustomerWorkOsError("INVALID_STATE", `delivery project is ${project.status}`);
    }
    const deliverable = project.deliverables.find((item) => item.id === deliverableId);
    if (!deliverable) throw new CustomerWorkOsError("NOT_FOUND", `deliverable not found: ${deliverableId}`);
    deliverable.status = status;
    if (status === "APPROVED") deliverable.evidenceRef = required(evidenceRef ?? "", "deliverable evidence");
    else delete deliverable.evidenceRef;
    if (project.status === "PLANNED") project.status = "ACTIVE";
    project.version += 1;
    return copy(project);
  }

  updateDeliveryWorkItemStatus(
    workspaceId: string,
    projectId: string,
    expectedVersion: number,
    workItemId: string,
    status: DeliveryWorkItem["status"],
    actualHours?: number,
  ): DeliveryProject {
    const project = this.versioned(this.deliveryProjects, workspaceId, projectId, expectedVersion, "delivery project");
    if (project.status === "COMPLETE" || project.status === "CANCELLED") {
      throw new CustomerWorkOsError("INVALID_STATE", `delivery project is ${project.status}`);
    }
    const workItem = project.workItems.find((item) => item.id === workItemId);
    if (!workItem) throw new CustomerWorkOsError("NOT_FOUND", `delivery work item not found: ${workItemId}`);
    if (actualHours !== undefined) {
      if (!Number.isFinite(actualHours) || actualHours < 0) throw new CustomerWorkOsError("INVALID_HOURS", "actualHours must be finite and non-negative");
      workItem.actualHours = actualHours;
    }
    if (status === "DONE" && workItem.actualHours === undefined) {
      throw new CustomerWorkOsError("ACTUAL_HOURS_REQUIRED", "completed work requires actualHours");
    }
    workItem.status = status;
    if (project.status === "PLANNED") project.status = "ACTIVE";
    project.version += 1;
    return copy(project);
  }

  proposeDeliveryCompletion(workspaceId: string, projectId: string, expectedVersion: number): DeliveryProject {
    const project = this.versioned(this.deliveryProjects, workspaceId, projectId, expectedVersion, "delivery project");
    if (project.status === "COMPLETE" || project.status === "CANCELLED") {
      throw new CustomerWorkOsError("INVALID_STATE", `delivery project is ${project.status}`);
    }
    const incompleteDeliverables = project.deliverables.filter(
      (item) => item.required && (item.status !== "APPROVED" || !item.evidenceRef?.trim()),
    );
    if (incompleteDeliverables.length > 0) {
      throw new CustomerWorkOsError("COMPLETION_RULE_FAILED", `required deliverables are not approved with evidence: ${incompleteDeliverables.map((item) => item.id).join(",")}`);
    }
    const incompleteWork = project.workItems.filter((item) => item.status !== "DONE");
    if (incompleteWork.length > 0) {
      throw new CustomerWorkOsError("COMPLETION_RULE_FAILED", `delivery work is incomplete: ${incompleteWork.map((item) => item.id).join(",")}`);
    }
    project.status = "AWAITING_APPROVAL";
    project.version += 1;
    return copy(project);
  }

  completeDelivery(
    workspaceId: string,
    projectId: string,
    expectedVersion: number,
    receipt: ApprovalReceipt,
  ): DeliveryProject {
    const project = this.versioned(this.deliveryProjects, workspaceId, projectId, expectedVersion, "delivery project");
    if (project.status !== "AWAITING_APPROVAL") throw new CustomerWorkOsError("INVALID_STATE", "delivery completion was not proposed");
    const payload = { projectId: project.id, version: project.version, deliverables: project.deliverables, workItems: project.workItems };
    this.consume(receipt, workspaceId, "delivery_project", project.id, project.version, "DELIVERY_COMPLETE", customerWorkOsPayloadHash(payload));
    const engagement = this.engagement(workspaceId, project.engagementId);
    if (engagement.stage !== "DELIVERY" && engagement.stage !== "ACCEPTANCE") {
      throw new CustomerWorkOsError("INVALID_STAGE", `cannot complete delivery from ${engagement.stage}`);
    }
    project.status = "COMPLETE";
    project.version += 1;
    engagement.stage = "BILLING";
    engagement.version += 1;
    return copy(project);
  }
'''
if "  proposeDeliveryCompletion(" not in text:
    if marker not in text:
        raise SystemExit("change request marker not found")
    text = text.replace(marker, methods + marker)

old = '''    this.account(input.workspaceId, input.customerAccountId);
    this.owned(this.products, input.workspaceId, input.productId, "product");
    const identifier = required(input.serialOrLicenseKey, "serialOrLicenseKey");'''
new = '''    this.account(input.workspaceId, input.customerAccountId);
    this.owned(this.products, input.workspaceId, input.productId, "product");
    const receivedQuantity = order.lines
      .filter((line) => line.productId === input.productId)
      .reduce((sum, line) => sum + line.receivedQuantity, 0);
    const registeredQuantity = [...this.assets.values()].filter(
      (item) => item.workspaceId === input.workspaceId && item.purchaseOrderId === order.id && item.productId === input.productId,
    ).length;
    if (registeredQuantity >= receivedQuantity) {
      throw new CustomerWorkOsError("ASSET_QUANTITY_EXCEEDED", "serialized assets cannot exceed received quantity");
    }
    const identifier = required(input.serialOrLicenseKey, "serialOrLicenseKey");'''
if old not in text and new not in text:
    raise SystemExit("asset quantity marker not found")
text = text.replace(old, new)

old = '    this.financialItems.set(input.id, copy(input));\n    return copy(input);'
new = '    this.financialItemBaseLifecycle.set(input.id, input.lifecycle);\n    this.financialItems.set(input.id, copy(input));\n    return copy(input);'
if old not in text and new not in text:
    raise SystemExit("financial item store marker not found")
text = text.replace(old, new, 1)

old = '    if (settled > 0n) item.lifecycle = settled < gross ? "PARTIAL" : "SETTLED";\n    return { settlement: copy(input), financialItem: copy(item) };'
new = '    if (settled > 0n) item.lifecycle = settled < gross ? "PARTIAL" : "SETTLED";\n    else item.lifecycle = this.financialItemBaseLifecycle.get(item.id) ?? (item.direction === "IN" ? "BILLED" : "INCURRED");\n    return { settlement: copy(input), financialItem: copy(item) };'
if old not in text and new not in text:
    raise SystemExit("settlement lifecycle marker not found")
text = text.replace(old, new)

close_marker = '\n  transitionEngagement(workspaceId: string, engagementId: string, expectedVersion: number, nextStage: EngagementStage, reason?: string): Engagement {'
close_method = '''

  closeEngagement(
    workspaceId: string,
    engagementId: string,
    expectedVersion: number,
    receipt: ApprovalReceipt,
  ): Engagement {
    const engagement = this.versioned(this.engagements, workspaceId, engagementId, expectedVersion, "engagement");
    if (engagement.stage !== "COLLECTION") throw new CustomerWorkOsError("INVALID_STAGE", `cannot close engagement from ${engagement.stage}`);
    const openCommitments = this.openCommitments(workspaceId, engagementId);
    if (openCommitments.length > 0) throw new CustomerWorkOsError("OPEN_COMMITMENTS", "engagement has unfinished commitments");
    const activeChanges = this.byEngagement(this.changes, workspaceId, engagementId).filter(
      (item) => !["REJECTED", "APPLIED"].includes(item.status),
    );
    if (activeChanges.length > 0) throw new CustomerWorkOsError("OPEN_CHANGE_REQUESTS", "engagement has unresolved change requests");
    if (engagement.deliveryProjectId) {
      const project = this.owned(this.deliveryProjects, workspaceId, engagement.deliveryProjectId, "delivery project");
      if (project.status !== "COMPLETE") throw new CustomerWorkOsError("DELIVERY_NOT_COMPLETE", "delivery project is not complete");
    }
    const finance = this.financeSummary(workspaceId, engagementId);
    if (finance.receivableKrw !== "0" || finance.payableKrw !== "0") {
      throw new CustomerWorkOsError("FINANCE_NOT_SETTLED", "receivable and payable must be zero before close");
    }
    const payload = {
      engagementId: engagement.id,
      version: engagement.version,
      projectKey: engagement.projectKey,
      finance,
    };
    this.consume(receipt, workspaceId, "engagement", engagement.id, engagement.version, "ENGAGEMENT_CLOSE", customerWorkOsPayloadHash(payload));
    engagement.stage = "CLOSED";
    engagement.version += 1;
    return copy(engagement);
  }
'''
if "  closeEngagement(" not in text:
    if close_marker not in text:
        raise SystemExit("engagement transition marker not found")
    text = text.replace(close_marker, close_method + close_marker)

source.write_text(text)

graph = Path("packages/domain/src/workflow-graph.ts")
text = graph.read_text()
text = text.replace(
    '      failureSignature: result.failureSignature,',
    '      ...(result.failureSignature !== undefined ? { failureSignature: result.failureSignature } : {}),',
)
text = text.replace(
    '      message: result.message,',
    '      ...(result.message !== undefined ? { message: result.message } : {}),',
)
graph.write_text(text)

test = Path("packages/domain/test/workflow-graph.unit.test.ts")
test.write_text(test.read_text().replace('  WorkflowGraphError,\n', ''))

Path("scripts/cwos-hardening-repair.py").unlink()
Path(".github/workflows/cwos-hardening-repair.yml").unlink()
