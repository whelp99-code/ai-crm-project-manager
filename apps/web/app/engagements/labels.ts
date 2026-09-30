/**
 * Reverse of packages/imports PROJECT_STAGES for codes stored on engagements.
 * DELIVERY is imported from both 매입발주 and 수행/검수. In the latest Notion
 * snapshot those owner stage names are 수행/검수 (3) and 매입발주 (2), and the
 * live list stores all five as DELIVERY. The display follows the majority
 * owner name that matches the English code: 수행/검수.
 * Codes with no owner stage name stay as stored.
 */
const STAGE_LABELS: Record<string, string> = {
  PROPOSAL: "제안/견적",
  CONTRACTED: "고객발주",
  DELIVERY: "수행/검수",
  BILLING: "청구/수금",
  CLOSED: "완료",
  ON_HOLD: "보류",
  LOST: "실패",
};

export function stageLabel(value: string): string {
  return STAGE_LABELS[value] ?? value;
}
