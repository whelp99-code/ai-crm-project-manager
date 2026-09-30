/** Read-only list SQL for the owner screens. No writes. */

export interface FinanceTotals {
  net: string;
  vat: string;
  gross: string;
}

export interface FinanceTotalRollup {
  IN: FinanceTotals;
  OUT: FinanceTotals;
}

const ZERO: FinanceTotals = { net: "0", vat: "0", gross: "0" };

export function archivedPredicate(columnPresent: boolean, alias: string): string {
  return columnPresent ? `${alias}.archived_at IS NULL` : "TRUE";
}

export function engagementsSql(columnPresent: boolean): string {
  const archived = archivedPredicate(columnPresent, "e");
  const partyArchived = archivedPredicate(columnPresent, "p");
  return `SELECT e.id, e.name, e.stage, acct.account_name
            FROM cwos_engagements e
            LEFT JOIN LATERAL (
              SELECT a.name AS account_name
                FROM cwos_engagement_parties p
                JOIN cwos_accounts a
                  ON a.workspace_id = p.workspace_id AND a.id = p.account_id
               WHERE p.workspace_id = e.workspace_id
                 AND p.engagement_id = e.id
                 AND ${partyArchived}
               ORDER BY CASE p.role
                          WHEN 'customer' THEN 0
                          WHEN 'prime_contractor' THEN 1
                          ELSE 2
                        END,
                        p.is_primary DESC,
                        a.name
               LIMIT 1
            ) acct ON true
           WHERE e.workspace_id = $1::uuid
             AND ${archived}
           ORDER BY e.name`;
}

export function financeItemsSql(columnPresent: boolean): string {
  const archived = archivedPredicate(columnPresent, "f");
  return `SELECT f.id,
                 f.direction,
                 f.gross_amount_krw::text AS gross_amount_krw,
                 f.expected_date::text AS expected_date,
                 a.name AS counterparty
            FROM cwos_financial_items f
            LEFT JOIN cwos_accounts a
              ON a.workspace_id = f.workspace_id AND a.id = f.account_id
           WHERE f.workspace_id = $1::uuid
             AND ${archived}
           ORDER BY f.expected_date, a.name, f.id`;
}

export function financeTotalsSql(columnPresent: boolean): string {
  const archived = archivedPredicate(columnPresent, "f");
  return `SELECT f.direction,
                 COALESCE(SUM(f.net_amount_krw), 0)::text AS net,
                 COALESCE(SUM(f.vat_amount_krw), 0)::text AS vat,
                 COALESCE(SUM(f.gross_amount_krw), 0)::text AS gross
            FROM cwos_financial_items f
           WHERE f.workspace_id = $1::uuid
             AND ${archived}
           GROUP BY f.direction`;
}

export function rollupFinanceTotals(rows: Array<{ direction: string; net: string; vat: string; gross: string }>): FinanceTotalRollup {
  const totals: FinanceTotalRollup = { IN: { ...ZERO }, OUT: { ...ZERO } };
  for (const row of rows) {
    if (row.direction !== "IN" && row.direction !== "OUT") continue;
    totals[row.direction] = { net: row.net, vat: row.vat, gross: row.gross };
  }
  return totals;
}
