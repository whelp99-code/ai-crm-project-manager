import { describe, expect, it } from "vitest";
import { diffNotionSync, type NotionSyncEntity, type NotionSyncLiveEntity } from "../src/notion-sync-diff.js";

function account(id: string, pageId: string, name: string): NotionSyncEntity {
  return {
    kind: "account",
    id,
    notionPageId: pageId,
    pageId,
    fields: { name, normalized_name: name, kinds: ["customer"], status: "active", source_ref: `notion://${pageId}` },
  };
}

function liveOf(entity: NotionSyncEntity, extra: Partial<NotionSyncLiveEntity> = {}): NotionSyncLiveEntity {
  return { ...entity, version: 1, syncedVersion: 1, archivedAt: null, ...extra, fields: { ...entity.fields, ...extra.fields } };
}

describe("diffNotionSync", () => {
  it("classifies a new page id as insert", () => {
    const diff = diffNotionSync({
      desired: [account("account-aaaaaaaa", "page-new", "신규")],
      live: [],
      snapshotPageIds: new Set(["page-new"]),
    });
    expect(diff.inserts.map((row) => row.id)).toEqual(["account-aaaaaaaa"]);
    expect(diff.updates).toHaveLength(0);
    expect(diff.deletes).toHaveLength(0);
  });

  it("classifies a changed field as update", () => {
    const before = account("account-aaaaaaaa", "page-1", "이전");
    const after = account("account-aaaaaaaa", "page-1", "이후");
    const diff = diffNotionSync({
      desired: [after],
      live: [liveOf(before)],
      snapshotPageIds: new Set(["page-1"]),
    });
    expect(diff.updates).toHaveLength(1);
    expect(diff.updates[0]?.fields.name).toBe("이후");
    expect(diff.inserts).toHaveLength(0);
  });

  it("soft-archives a page missing from the snapshot and never deletes", () => {
    const row = account("account-aaaaaaaa", "page-gone", "사라진");
    const diff = diffNotionSync({
      desired: [],
      live: [liveOf(row)],
      snapshotPageIds: new Set(),
    });
    expect(diff.archives).toEqual([
      expect.objectContaining({ id: "account-aaaaaaaa", fields: expect.objectContaining({ status: "inactive", archived_at: "now" }) }),
    ]);
    expect(diff.deletes).toHaveLength(0);
  });

  it("holds an amount change and does not touch settlements", () => {
    const before: NotionSyncLiveEntity = {
      kind: "financial_item",
      id: "financial-aaaaaaaa",
      notionPageId: "fin-1",
      pageId: "fin-1",
      version: 1,
      syncedVersion: 1,
      hasSettlement: true,
      fields: { gross_amount_krw: "1000", net_amount_krw: "1000", vat_amount_krw: "0", direction: "IN", account_id: "account-aaaaaaaa" },
    };
    const after: NotionSyncEntity = { ...before, fields: { ...before.fields, gross_amount_krw: "2000" } };
    const diff = diffNotionSync({
      desired: [after],
      live: [before],
      snapshotPageIds: new Set(["fin-1"]),
      desiredSettlements: [{ id: "settlement-bbbbbbbb", financialItemId: before.id, notionPageId: "fin-1", direction: "IN", amountKrw: "2000", settledAt: "2026-09-01" }],
      liveSettlementFinancialItemIds: new Set([before.id]),
    });
    expect(diff.holds.map((row) => row.reason)).toContain("AMOUNT_OR_DIRECTION");
    expect(diff.updates).toHaveLength(0);
    expect(diff.settlementInserts).toHaveLength(0);
    expect(diff.settlementUpdates).toHaveLength(0);
    expect(diff.deletes).toHaveLength(0);
  });

  it("does not archive a financial item that has a settlement", () => {
    const live: NotionSyncLiveEntity = {
      kind: "financial_item",
      id: "financial-aaaaaaaa",
      notionPageId: "fin-1",
      pageId: "fin-1",
      hasSettlement: true,
      fields: { gross_amount_krw: "1000" },
    };
    const diff = diffNotionSync({ desired: [], live: [live], snapshotPageIds: new Set() });
    expect(diff.archives).toHaveLength(0);
    expect(diff.holds.map((row) => row.reason)).toContain("SETTLED_ARCHIVE");
    expect(diff.settlementUpdates).toHaveLength(0);
  });

  it("is a no-op when the same desired state is diffed again", () => {
    const row = account("account-aaaaaaaa", "page-1", "이름");
    const first = diffNotionSync({ desired: [row], live: [], snapshotPageIds: new Set(["page-1"]) });
    expect(first.inserts).toHaveLength(1);
    const second = diffNotionSync({
      desired: [row],
      live: [liveOf(row)],
      snapshotPageIds: new Set(["page-1"]),
    });
    expect(second.inserts).toHaveLength(0);
    expect(second.updates).toHaveLength(0);
    expect(second.archives).toHaveLength(0);
    expect(second.holds).toHaveLength(0);
  });

  it("freezes a quarantined page id (no insert, no update)", () => {
    const row = account("account-aaaaaaaa", "page-q", "격리");
    const changed = account("account-aaaaaaaa", "page-q", "변경");
    const missing = diffNotionSync({
      desired: [row],
      live: [],
      snapshotPageIds: new Set(["page-q"]),
      quarantinedPageIds: new Set(["page-q"]),
    });
    const present = diffNotionSync({
      desired: [changed],
      live: [liveOf(row)],
      snapshotPageIds: new Set(["page-q"]),
      quarantinedPageIds: new Set(["page-q"]),
    });
    expect(missing.inserts).toHaveLength(0);
    expect(present.updates).toHaveLength(0);
    expect(present.archives).toHaveLength(0);
  });
});
