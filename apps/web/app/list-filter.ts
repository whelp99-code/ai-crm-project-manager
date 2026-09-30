/** Case-insensitive substring match on the visible name. Empty query keeps order. */
export function filterByQuery(names: readonly string[], query: string): number[] {
  const needle = query.trim().toLocaleLowerCase("ko-KR");
  if (!needle) return names.map((_, index) => index);
  return names.flatMap((name, index) => (
    name.toLocaleLowerCase("ko-KR").includes(needle) ? [index] : []
  ));
}
