/**
 * In-process live event fanout for `/api/agent/jobs/:id/events` (G-03).
 *
 * This is NOT the durable event log. `orch_job_events` (0003, dual-written
 * via `saveSnapshot`) remains the durable outbox / single source of truth —
 * see docs/ops/eventing.md. `EventHub` is a thin, ephemeral pub/sub layer
 * that lets an already-open SSE connection learn "something changed on
 * (workspaceId, jobId)" so the handler can re-read the snapshot and push a
 * follow-up frame, instead of forcing clients to poll.
 *
 * Scope / residual (documented, not a bug):
 *  - Single process only. No cross-process broker (Redis pub/sub, NOTIFY/
 *    LISTEN, message queue). A second API instance would not see mutations
 *    made on the first.
 *  - No replay/backlog: a subscriber that connects after a publish gets
 *    nothing for that publish. Durable history for a job always lives in
 *    `orch_job_events` (queried via `listEvents`/`getJob`), never in this hub.
 *  - Memory-bounded by design: subscribers are removed the moment their SSE
 *    handler unsubscribes (client disconnect, explicit end, timeout).
 */
export interface AgentHubEvent {
  workspaceId: string;
  jobId: string;
  /** Free-form marker of what kind of mutation triggered the publish. */
  kind: string;
}

export type AgentHubListener = (event: AgentHubEvent) => void;

/** Unsubscribe callback returned by `EventHub.subscribe`. Safe to call more than once. */
export type Unsubscribe = () => void;

export class EventHub {
  private readonly subscribers = new Map<string, Set<AgentHubListener>>();

  private static key(workspaceId: string, jobId: string): string {
    return `${workspaceId}\u0000${jobId}`;
  }

  subscribe(workspaceId: string, jobId: string, listener: AgentHubListener): Unsubscribe {
    const key = EventHub.key(workspaceId, jobId);
    let set = this.subscribers.get(key);
    if (!set) {
      set = new Set();
      this.subscribers.set(key, set);
    }
    set.add(listener);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      const current = this.subscribers.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.subscribers.delete(key);
    };
  }

  publish(event: AgentHubEvent): void {
    const set = this.subscribers.get(EventHub.key(event.workspaceId, event.jobId));
    if (!set || set.size === 0) return;
    // Snapshot the listener list: a listener may unsubscribe itself mid-iteration
    // (e.g. cleanup triggered by a synchronous write failure).
    for (const listener of [...set]) listener(event);
  }

  /** Test/ops hook: current live-subscriber count for a job. Never used for durability guarantees. */
  subscriberCount(workspaceId: string, jobId: string): number {
    return this.subscribers.get(EventHub.key(workspaceId, jobId))?.size ?? 0;
  }

  /** Total number of (workspaceId, jobId) keys with at least one live subscriber. */
  activeJobCount(): number {
    return this.subscribers.size;
  }
}
