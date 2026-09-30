/**
 * PostgreSQL `date` is OID 1082. node-pg's default parser builds a JS Date at
 * local midnight (`new Date(y, m - 1, d)`), not UTC midnight. Any later
 * getUTC* read then shifts the calendar day in timezones ahead of UTC
 * (Asia/Seoul). Call this before constructing a Pool or Client so DATE values
 * stay the raw server text `YYYY-MM-DD`.
 */
export const PG_DATE_OID = 1082;

type PgTypeParsers = {
  setTypeParser: (oid: number, parser: (value: string) => unknown) => void;
};

type PgModule = {
  types?: PgTypeParsers;
  default?: { types?: PgTypeParsers };
};

export function installPgDateStringParser(pg: object): void {
  const module = pg as PgModule;
  const types = module.types ?? module.default?.types;
  if (!types) {
    throw new Error("pg.types is missing; cannot install the DATE (OID 1082) string parser");
  }
  types.setTypeParser(PG_DATE_OID, (value) => value);
}
