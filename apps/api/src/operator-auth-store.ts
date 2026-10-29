import { closeSync, constants, fstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const rateSchema = z.object({
  lockoutUntil: z.number().finite().nonnegative(),
  failures: z.number().int().nonnegative(),
  globalHits: z.array(z.number().finite().nonnegative()),
  perIp: z.record(z.string(), z.array(z.number().finite().nonnegative())),
});

/** CRM-owned bcrypt record; legacy KDF files require explicit offline enrollment. */
export const operatorAuthRecordSchema = z.object({
  generation: z.number().int().positive(),
  enrolled: z.literal(true),
  totpPending: z.literal(false),
  passwordHash: z.string().regex(/^\$2b\$12\$[./A-Za-z0-9]{53}$/),
  totpSecret: z.string().regex(/^[A-Z2-7]{32}$/),
  lastTotpStep: z.number().int().nonnegative().optional(),
  rate: rateSchema.optional(),
}).strict();

export type OperatorAuthRecord = z.infer<typeof operatorAuthRecordSchema>;
export interface OperatorAuthStore {
  read(): OperatorAuthRecord;
  write(record: OperatorAuthRecord): void;
}

/** One human-composition process owns this file, like the existing FileOwnerStore. */
export class FileOperatorAuthStore implements OperatorAuthStore {
  constructor(private readonly path: string) {
    this.read();
  }

  read(): OperatorAuthRecord {
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
        throw new Error("[OPERATOR_AUTH_FILE_PRIVATE] existing private regular auth file required");
      }
      const input: unknown = JSON.parse(readFileSync(fd, "utf8"));
      return operatorAuthRecordSchema.parse(input);
    } finally {
      closeSync(fd);
    }
  }

  write(record: OperatorAuthRecord): void {
    const next = operatorAuthRecordSchema.parse(record);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.path);
  }
}
