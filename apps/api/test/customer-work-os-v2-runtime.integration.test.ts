import { describe, expect, it } from "vitest";
import { CustomerWorkOsV2Error, type V2Actor } from "@ai-crm/domain/customer-work-os-v2";
import {
  CustomerWorkOsV2RuntimeManager,
  InMemoryCwosV2StateStore,
} from "../src/customer-work-os-v2-runtime.js";

const workspaceId = "workspace-v2";
const owner: V2Actor = {
  principalId: "owner-1",
  workspaceId,
  kind: "human",
  stepUpVerified: true,
};

describe("Customer Work OS v2 runtime", () => {
  it("bootstraps once, replays idempotently and preserves an audit hash chain", async () => {
    const store = new InMemoryCwosV2StateStore();
    const runtime = new CustomerWorkOsV2RuntimeManager(
      store,
      () => "2026-08-15T00:00:00.000Z",
    );

    await expect(runtime.readAuthorized({ ...owner, stepUpVerified: false })).rejects.toMatchObject({
      code: "STEP_UP_REQUIRED",
    });

    const registered = await runtime.command({
      workspaceId,
      actor: owner,
      expectedVersion: 0,
      idempotencyKey: "register-owner",
      command: "identity.registerPrincipal",
      payload: {
        id: owner.principalId,
        kind: "human",
        displayName: "Owner",
        active: true,
      },
    });
    expect(registered.envelope.version).toBe(1);

    const replay = await runtime.command({
      workspaceId,
      actor: owner,
      expectedVersion: 0,
      idempotencyKey: "register-owner",
      command: "identity.registerPrincipal",
      payload: {
        id: owner.principalId,
        kind: "human",
        displayName: "Owner",
        active: true,
      },
    });
    expect(replay.envelope.version).toBe(1);
    expect(replay.result).toEqual(registered.result);

    const membership = await runtime.command({
      workspaceId,
      actor: owner,
      expectedVersion: 1,
      idempotencyKey: "membership-owner",
      command: "identity.addMembership",
      payload: {
        id: "membership-owner",
        principalId: owner.principalId,
      },
    });
    expect(membership.envelope.version).toBe(2);

    await expect(
      runtime.command({
        workspaceId,
        actor: owner,
        expectedVersion: 2,
        idempotencyKey: "register-owner",
        command: "identity.addTeam",
        payload: { id: "team-1", name: "Core" },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    await expect(
      runtime.readAuthorized({
        principalId: "intruder",
        workspaceId,
        kind: "human",
        stepUpVerified: true,
      }),
    ).rejects.toMatchObject({ code: "PRINCIPAL_REQUIRED" });

    const events = store.auditLog(workspaceId);
    expect(events).toHaveLength(2);
    expect(events[0]!.previousEventHash).toBeNull();
    expect(events[1]!.previousEventHash).toBe(events[0]!.eventHash);
    expect(events[1]!.beforeStateHash).toBe(events[0]!.afterStateHash);
  });

  it("allows exactly one winner for concurrent initial compare-and-swap commands", async () => {
    const store = new InMemoryCwosV2StateStore();
    const runtime = new CustomerWorkOsV2RuntimeManager(store);
    const request = (key: string) => runtime.command({
      workspaceId,
      actor: owner,
      expectedVersion: 0,
      idempotencyKey: key,
      command: "identity.registerPrincipal",
      payload: {
        id: owner.principalId,
        kind: "human",
        displayName: "Owner",
        active: true,
      },
    });

    const results = await Promise.allSettled([request("initial-a"), request("initial-b")]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((item): item is PromiseRejectedResult => item.status === "rejected");
    expect(rejection?.reason).toBeInstanceOf(CustomerWorkOsV2Error);
    expect((rejection?.reason as CustomerWorkOsV2Error).code).toBe("CONCURRENT_MODIFICATION");
    expect(store.auditLog(workspaceId)).toHaveLength(1);
  });
});
