/** Reverse of FINANCE_DIRECTIONS. Unknown values stay as stored. */
const DIRECTION_LABELS: Record<string, string> = {
  IN: "매출",
  OUT: "매입",
};

export function directionLabel(value: string): string {
  return DIRECTION_LABELS[value] ?? value;
}

export function formatKrw(value: string): string {
  if (!/^-?\d+$/.test(value)) return value;
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}`;
}
