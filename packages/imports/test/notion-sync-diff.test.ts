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

function financialItem(): NotionSyncEntity {
  return {
    kind: "financial_item", id: "financial-aaaaaaaa", notionPageId: "fin-1", pageId: "fin-1",
    fields: { net_amount_krw: "100", vat_amount_krw: "10", gross_amount_krw: "110", direction: "IN", account_id: "account-aaaaaaaa" },
  };
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

  describe("money holds regardless of settlement presence", () => {
    const changes = [
      ["net_amount_krw", "200"], ["vat_amount_krw", "20"], ["gross_amount_krw", "220"],
      ["direction", "OUT"], ["account_id", "account-bbbbbbbb"],
    ] as const;
    it.each(changes.flatMap(([field, value]) => [false, true, undefined].map(hasSettlement => ({ field, value, hasSettlement }))))(
      "holds $field with hasSettlement=$hasSettlement",
      ({ field, value, hasSettlement }) => {
        const before = financialItem();
        const live = liveOf(before, hasSettlement === undefined ? {} : { hasSettlement });
        const after = { ...before, fields: { ...before.fields, [field]: value } };
        const diff = diffNotionSync({ desired: [after], live: [live], snapshotPageIds: new Set([before.pageId]) });
        expect(diff.updates).toHaveLength(0);
        expect(diff.holds).toEqual([{ notionPageId: before.pageId, kind: "financial_item", reason: "AMOUNT_OR_DIRECTION" }]);
        expect(live.fields).toEqual(before.fields);
        expect(after.fields[field]).toBe(value);
      },
    );

    it.each(["0", "-1", "9007199254740993"])("holds exact integer amount %s without numeric rounding", value => {
      const before = financialItem();
      const after = { ...before, fields: { ...before.fields, gross_amount_krw: value } };
      const diff = diffNotionSync({ desired: [after], live: [liveOf(before, { hasSettlement: false })], snapshotPageIds: new Set([before.pageId]) });
      expect(diff.updates).toHaveLength(0);
      expect(diff.holds.map(row => row.reason)).toEqual(["AMOUNT_OR_DIRECTION"]);
      expect(after.fields.gross_amount_krw).toBe(value);
    });

    it("holds the combined net VAT and gross change of an unsettled item", () => {
      const before = financialItem();
      const after = { ...before, fields: { ...before.fields, net_amount_krw: "200", vat_amount_krw: "20", gross_amount_krw: "220" } };
      const diff = diffNotionSync({ desired: [after], live: [liveOf(before, { hasSettlement: false })], snapshotPageIds: new Set([before.pageId]) });
      expect(diff.updates).toHaveLength(0);
      expect(diff.holds).toEqual([{ notionPageId: before.pageId, kind: "financial_item", reason: "AMOUNT_OR_DIRECTION" }]);
    });

    it("keeps permitted non-money and unrelated updates while excluding held money fields", () => {
      const before = financialItem();
      before.fields.expected_date = "2026-12-01";
      const after = { ...before, fields: { ...before.fields, net_amount_krw: "200", expected_date: "2026-12-02" } };
      const oldAccount = account("account-bbbbbbbb", "acc-2", "before");
      const newAccount = account("account-bbbbbbbb", "acc-2", "after");
      const diff = diffNotionSync({
        desired: [after, newAccount], live: [liveOf(before, { hasSettlement: false }), liveOf(oldAccount)],
        snapshotPageIds: new Set([before.pageId, oldAccount.pageId]),
      });
      expect(diff.updates.map(row => ({ id: row.id, fields: row.fields }))).toEqual([
        { id: before.id, fields: { expected_date: "2026-12-02" } },
        { id: oldAccount.id, fields: { name: "after", normalized_name: "after" } },
      ]);
      expect(diff.holds.map(row => row.reason)).toEqual(["AMOUNT_OR_DIRECTION"]);
    });

    it("keeps equivalent numeric representations and an unchanged unsettled item at zero writes", () => {
      const before = financialItem();
      const after = { ...before, fields: { ...before.fields, net_amount_krw: 100n, vat_amount_krw: 10 } };
      const diff = diffNotionSync({ desired: [after], live: [liveOf(before, { hasSettlement: false })], snapshotPageIds: new Set([before.pageId]) });
      expect(diff.updates).toHaveLength(0);
      expect(diff.holds).toHaveLength(0);
      expect(diff.inserts).toHaveLength(0);
      expect(diff.archives).toHaveLength(0);
    });

    it("does not insert a settlement carrying held money while preserving unrelated settlement inserts", () => {
      const before = financialItem();
      const after = { ...before, fields: { ...before.fields, gross_amount_krw: "220" } };
      const other = { ...before, id: "financial-bbbbbbbb", notionPageId: "fin-2", pageId: "fin-2" };
      const safeSettlement = { id: "settlement-bbbbbbbb", financialItemId: other.id, notionPageId: other.pageId, direction: "IN" as const, amountKrw: "110", settledAt: "2026-12-01" };
      const diff = diffNotionSync({
        desired: [after, other], live: [liveOf(before, { hasSettlement: false }), liveOf(other, { hasSettlement: false })],
        snapshotPageIds: new Set([before.pageId, other.pageId]),
        desiredSettlements: [
          { ...safeSettlement, id: "settlement-aaaaaaaa", financialItemId: before.id, notionPageId: before.pageId, amountKrw: "220" },
          safeSettlement,
        ],
      });
      expect(diff.updates).toHaveLength(0);
      expect(diff.holds.map(row => row.reason)).toEqual(["AMOUNT_OR_DIRECTION"]);
      expect(diff.settlementInserts).toEqual([safeSettlement]);
      expect(diff.settlementUpdates).toHaveLength(0);
      expect(diff.deletes).toHaveLength(0);
    });
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

  it("treats a date string and UTC midnight timestamp as the same occurred_at", () => {
    const desired: NotionSyncEntity = {
      kind: "activity",
      id: "activity-aaaaaaaa",
      notionPageId: "act-1",
      pageId: "act-1",
      fields: { activity_type: "note", occurred_at: "2025-12-01", summary: "memo", engagement_id: "engagement-aaaaaaaa", account_id: null },
    };
    const live: NotionSyncLiveEntity = {
      ...desired,
      version: 1,
      syncedVersion: 1,
      fields: { ...desired.fields, occurred_at: "2025-12-01T00:00:00.000Z" },
    };
    const diff = diffNotionSync({ desired: [desired], live: [live], snapshotPageIds: new Set(["act-1"]) });
    expect(diff.updates).toHaveLength(0);
    expect(diff.inserts).toHaveLength(0);
  });

  it("does not update artifact metadata when only JSON key order differs", () => {
    const desired: NotionSyncEntity = {
      kind: "artifact",
      id: "artifact-aaaaaaaa",
      notionPageId: "artifact:page:quote:abcd1234",
      pageId: "page-1",
      fields: { title: "quote imported from Notion", status: "REVIEW", storage_uri: "notion://file", metadata: { legacySourceId: "page-1", importedFrom: "Notion" } },
    };
    const live: NotionSyncLiveEntity = {
      ...desired,
      version: 1,
      syncedVersion: 1,
      fields: { ...desired.fields, metadata: { importedFrom: "Notion", legacySourceId: "page-1" } },
    };
    const diff = diffNotionSync({ desired: [desired], live: [live], snapshotPageIds: new Set(["page-1"]) });
    expect(diff.updates).toHaveLength(0);
  });

  it("still updates artifact metadata when a value changes", () => {
    const desired: NotionSyncEntity = {
      kind: "artifact",
      id: "artifact-aaaaaaaa",
      notionPageId: "artifact:page:quote:abcd1234",
      pageId: "page-1",
      fields: { title: "quote imported from Notion", status: "REVIEW", storage_uri: "notion://file", metadata: { legacySourceId: "page-1", importedFrom: "Notion" } },
    };
    const live: NotionSyncLiveEntity = {
      ...desired,
      version: 1,
      syncedVersion: 1,
      fields: { ...desired.fields, metadata: { importedFrom: "Other", legacySourceId: "page-1" } },
    };
    const diff = diffNotionSync({ desired: [desired], live: [live], snapshotPageIds: new Set(["page-1"]) });
    expect(diff.updates).toHaveLength(1);
    expect(diff.updates[0]?.fields.metadata).toEqual({ legacySourceId: "page-1", importedFrom: "Notion" });
  });
});
