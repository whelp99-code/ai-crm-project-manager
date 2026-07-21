"use client";

import { useState } from "react";

type Props = {
  apiBase: string;
  workspaceId: string;
  controlId: string;
  defaultApproverId: string;
};

export function DecideClient({ apiBase, workspaceId, controlId, defaultApproverId }: Props) {
  const [principalId, setPrincipalId] = useState(defaultApproverId);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function decide(decision: "APPROVE" | "REJECT") {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`${apiBase}/api/governance/controls/${controlId}/decide`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-workspace-id": workspaceId,
        },
        body: JSON.stringify({ principalId, decision }),
      });
      const body = (await response.json()) as { error?: string; status?: string };
      if (!response.ok) {
        throw new Error(body.error ?? `decide ${response.status}`);
      }
      setMessage(`${decision} → ${body.status ?? "ok"}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "decide failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="status-row" style={{ marginTop: 8 }}>
      <input
        aria-label={`approver for ${controlId}`}
        value={principalId}
        onChange={(e) => setPrincipalId(e.target.value)}
        style={{ padding: 6, minWidth: 140 }}
      />
      <button type="button" disabled={busy} onClick={() => void decide("APPROVE")}>
        승인
      </button>
      <button type="button" disabled={busy} onClick={() => void decide("REJECT")}>
        반려
      </button>
      {message ? <span className="meta">{message}</span> : null}
    </div>
  );
}
