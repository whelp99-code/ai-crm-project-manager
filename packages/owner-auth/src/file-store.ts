import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { emptyRecord, type OwnerRecord, type OwnerStore } from "./index.js";

export class FileOwnerStore implements OwnerStore {
  constructor(private readonly path: string) {}

  read(): OwnerRecord {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<OwnerRecord>;
      return {
        generation: typeof parsed.generation === "number" ? parsed.generation : 1,
        enrolled: parsed.enrolled === true,
        totpPending: parsed.totpPending === true,
        ...(typeof parsed.passwordSalt === "string" ? { passwordSalt: parsed.passwordSalt } : {}),
        ...(typeof parsed.passwordHash === "string" ? { passwordHash: parsed.passwordHash } : {}),
        ...(typeof parsed.totpSecret === "string" ? { totpSecret: parsed.totpSecret } : {}),
        ...(typeof parsed.pendingCodeHash === "string" ? { pendingCodeHash: parsed.pendingCodeHash } : {}),
        ...(typeof parsed.pendingCodeExp === "number" ? { pendingCodeExp: parsed.pendingCodeExp } : {}),
        ...(typeof parsed.lastTotpStep === "number" ? { lastTotpStep: parsed.lastTotpStep } : {}),
        ...(parsed.rate && typeof parsed.rate === "object" ? { rate: parsed.rate } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRecord();
      throw error;
    }
  }

  write(next: OwnerRecord): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }
}
