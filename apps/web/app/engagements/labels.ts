/**
 * Reverse of packages/imports PROJECT_STAGES where one English code has one Korean label.
 * DELIVERY is both 매입발주 and 수행/검수, so it stays as stored.
 */
const UNIQUE_STAGE_LABELS: Record<string, string> = {
  PROPOSAL: "제안/견적",
  CONTRACTED: "고객발주",
  BILLING: "청구/수금",
  CLOSED: "완료",
  ON_HOLD: "보류",
  LOST: "실패",
};

export function stageLabel(value: string): string {
  return UNIQUE_STAGE_LABELS[value] ?? value;
}
