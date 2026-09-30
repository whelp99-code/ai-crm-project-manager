/** Labels that exist in the restored accounts snapshot. Unknown values stay as stored. */
const KIND_LABELS: Record<string, string> = {
  customer: "고객",
  partner: "파트너",
};

const STATUS_LABELS: Record<string, string> = {
  active: "활성",
};

export function parseKinds(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[")) return [raw];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return [raw];
    return parsed;
  } catch {
    return [raw];
  }
}

export function kindLabel(value: string): string {
  return KIND_LABELS[value] ?? value;
}

export function statusLabel(value: string): string {
  return STATUS_LABELS[value] ?? value;
}
