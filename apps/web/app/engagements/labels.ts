/**
 * Prefer the Notion 프로젝트 단계 stored on the engagement.
 * Unique import codes fall back to the owner stage name.
 * DELIVERY is both 매입발주 and 수행/검수, so a missing original is "수행 중", not a guess.
 * Unknown codes stay as stored.
 */
const STAGE_LABELS: Record<string, string> = {
  PROPOSAL: "제안/견적",
  CONTRACTED: "고객발주",
  BILLING: "청구/수금",
  CLOSED: "완료",
  ON_HOLD: "보류",
  LOST: "실패",
};

export function stageLabel(value: string, sourceStage?: string | null): string {
  const original = sourceStage?.trim();
  if (original) return original;
  if (value === "DELIVERY") return "수행 중";
  return STAGE_LABELS[value] ?? value;
}
