import type { ActionType } from "@ai-crm/contracts";

/**
 * S0 natural-command whitelist. Unknown / unmapped strings return null —
 * callers must fail the work item with UNMAPPED_COMMAND and must not mutate domain.
 */
export const COMMAND_MAP = {
  "pm.task_assign": "PM_TASK_ASSIGN",
  "pm.plan_revise": "PM_PLAN_REVISE",
  "pm.target_set": "PM_TARGET_SET",
  "pm.plan_create": "PM_PLAN_CREATE",
  "internal.update": "INTERNAL_REVERSIBLE_UPDATE",
} as const satisfies Record<string, ActionType>;

export type MappedCommand = keyof typeof COMMAND_MAP;

/** trim → lower-case → collapse internal whitespace. */
export function normalizeCommand(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Map a free-form suggested command to its ActionType.
 * Returns null when the normalized key is not in the S0 whitelist.
 */
export function mapCommand(raw: string): ActionType | null {
  const key = normalizeCommand(raw);
  if (!key) return null;
  return (COMMAND_MAP as Record<string, ActionType>)[key] ?? null;
}

/** Normalized command key if mapped, else null (for authorize registry lookup). */
export function mapCommandKey(raw: string): MappedCommand | null {
  const key = normalizeCommand(raw);
  if (!key) return null;
  return key in COMMAND_MAP ? (key as MappedCommand) : null;
}
