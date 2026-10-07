type PgConnectionEnv = Pick<
  NodeJS.ProcessEnv,
  "PGHOST" | "PGPORT" | "PGUSER" | "PGPASSWORD" | "PGDATABASE"
>;

export function pgSmokeConnectionEnv(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): PgConnectionEnv {
  const url = new URL(databaseUrl);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the PostgreSQL protocol");
  }

  return {
    PGHOST: env.PGHOST || url.hostname,
    PGPORT: env.PGPORT || url.port || "5432",
    PGUSER: env.PGUSER || decodeURIComponent(url.username),
    PGPASSWORD: env.PGPASSWORD || decodeURIComponent(url.password),
    PGDATABASE: env.PGDATABASE || decodeURIComponent(url.pathname.slice(1)),
  };
}
