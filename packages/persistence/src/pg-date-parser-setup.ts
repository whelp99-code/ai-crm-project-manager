import { installPgDateStringParser } from "./pg-date-parser.js";

try {
  const pg = await import("pg");
  installPgDateStringParser(pg);
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code !== "ERR_MODULE_NOT_FOUND") throw error;
}
