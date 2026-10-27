import {
  CustomerWorkOsV2Error,
  CustomerWorkOsV2Platform,
  customerWorkOsV2StateHash,
  type V2Actor,
} from "@ai-crm/domain/customer-work-os-v2";
import {
  emptyEnvelope,
  validateEnvelope,
  v2Hash,
  type CwosV2StateStore,
  type V2RuntimeEnvelope,
} from "./customer-work-os-v2-runtime-core.js";
import {
  assertV2ActorCanCommand,
  assertV2ActorCanRead,
  executeV2Command,
} from "./customer-work-os-v2-runtime-commands.js";

export class CustomerWorkOsV2RuntimeManager {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly store: CwosV2StateStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async read(workspaceId: string): Promise<V2RuntimeEnvelope> {
    const current = await this.store.load(workspaceId);
    if (current) {
      validateEnvelope(current);
      if (current.workspaceId !== workspaceId) {
        throw new CustomerWorkOsV2Error("CROSS_WORKSPACE_STATE", "state store returned another workspace");
      }
      return current;
    }
    return { ...emptyEnvelope(workspaceId, "system", this.now()), version: 0 };
  }

  async readAuthorized(actor: V2Actor): Promise<V2RuntimeEnvelope> {
    const envelope = await this.read(actor.workspaceId);
    assertV2ActorCanRead(envelope.state, actor);
    return envelope;
  }

  async command(input: {
    workspaceId: string;
    actor: V2Actor;
    expectedVersion: number;
    idempotencyKey: string;
    command: string;
    payload: unknown;
  }): Promise<{ statusCode: number; result: unknown; envelope: V2RuntimeEnvelope }> {
    if (input.actor.workspaceId !== input.workspaceId) {
      throw new CustomerWorkOsV2Error("CROSS_WORKSPACE", "actor and command workspace differ");
    }
    if (!input.idempotencyKey.trim()) {
      throw new CustomerWorkOsV2Error("INVALID_INPUT", "idempotency key is required");
    }

    const prior = this.queues.get(input.workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.then(() => gate);
    this.queues.set(input.workspaceId, queued);
    await prior;

    try {
      const current = await this.read(input.workspaceId);
      // Authenticate against the current state before revealing its version or replay window.
      assertV2ActorCanRead(current.state, input.actor);
      const requestHash = v2Hash({ command: input.command, payload: input.payload, actor: input.actor });
      const replay = current.idempotency.find((item) => item.key === input.idempotencyKey);
      if (replay) {
        if (replay.requestHash !== requestHash) {
          throw new CustomerWorkOsV2Error(
            "IDEMPOTENCY_CONFLICT",
            "idempotency key was used for another request",
          );
        }
        return { statusCode: replay.statusCode, result: structuredClone(replay.result), envelope: current };
      }
      assertV2ActorCanCommand(current.state, input.actor, input.command, input.payload);
      if (current.version !== input.expectedVersion) {
        throw new CustomerWorkOsV2Error(
          "CONCURRENT_MODIFICATION",
          `expected ${input.expectedVersion}, found ${current.version}`,
        );
      }
      const platform = new CustomerWorkOsV2Platform(input.workspaceId);
      platform.hydrateState(current.state);
      const result = executeV2Command(platform, input.command, input.payload, input.actor, this.now());
      const state = platform.exportState();
      const stateHash = customerWorkOsV2StateHash(state);
      const createdAt = this.now();
      if (!Number.isFinite(Date.parse(createdAt))) {
        throw new CustomerWorkOsV2Error("INVALID_CLOCK", "runtime clock returned an invalid timestamp");
      }
      const idempotency = [
        ...current.idempotency,
        {
          key: input.idempotencyKey,
          requestHash,
          statusCode: 200,
          result: structuredClone(result),
          createdAt,
        },
      ].slice(-500);
      const next: Omit<V2RuntimeEnvelope, "version"> = {
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        state,
        idempotency,
        stateHash,
        updatedByPrincipalId: input.actor.principalId,
        updatedAt: createdAt,
      };
      const audit = {
        workspaceId: input.workspaceId,
        operationId: `op-${v2Hash({ input, createdAt }).slice(0, 24)}`,
        principalId: input.actor.principalId,
        command: input.command,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        beforeStateHash: current.stateHash,
        afterStateHash: stateHash,
        resultHash: v2Hash(result),
        createdAt,
      };
      const envelope = await this.store.compareAndSwap(input.workspaceId, current.version, next, audit);
      return { statusCode: 200, result, envelope };
    } finally {
      release();
      if (this.queues.get(input.workspaceId) === queued) this.queues.delete(input.workspaceId);
    }
  }

  async close(): Promise<void> {
    await this.store.close?.();
  }
}
