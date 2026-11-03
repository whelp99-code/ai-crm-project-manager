import { writeFileSync } from "node:fs";
import { z } from "zod";
import { acceptedOperatorTotpStep, operatorPasswordHash } from "./operator-auth-crypto.js";
import type { OperatorAuthRecord } from "./operator-auth-store.js";

const enrollmentSchema = z.object({
  password: z.string().min(12).refine(value => Buffer.byteLength(value, "utf8") <= 72),
  totpSecret: z.string().regex(/^[A-Z2-7]{32}$/),
  totp: z.string().regex(/^\d{6}$/),
}).strict();

export class OperatorEnrollmentError extends Error {
  readonly code: "OPERATOR_ENROLLMENT_REJECTED" | "ALREADY_ENROLLED";
  constructor(code: "OPERATOR_ENROLLMENT_REJECTED" | "ALREADY_ENROLLED" = "OPERATOR_ENROLLMENT_REJECTED") {
    super("OPERATOR_ENROLLMENT_REJECTED");
    this.name = "OperatorEnrollmentError";
    this.code = code;
  }
}

/** Offline owner-only enrollment; neither the password nor OTP is returned. */
export function enrollOperator(input: unknown, now: number): OperatorAuthRecord {
  const parsed = enrollmentSchema.safeParse(input);
  if (!parsed.success) throw new OperatorEnrollmentError();
  const step = acceptedOperatorTotpStep(parsed.data.totpSecret, parsed.data.totp, now);
  if (step === undefined) throw new OperatorEnrollmentError();
  return {
    generation: 1, enrolled: true, totpPending: false,
    passwordHash: operatorPasswordHash(parsed.data.password),
    totpSecret: parsed.data.totpSecret, lastTotpStep: step,
  };
}

/** First enrollment only. An existing path is left untouched and is not opened. */
export function writeNewOperatorEnrollment(statePath: string, input: unknown, now: number): void {
  const record = enrollOperator(input, now);
  try {
    writeFileSync(statePath, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "";
    if (code === "EEXIST") throw new OperatorEnrollmentError("ALREADY_ENROLLED");
    throw new OperatorEnrollmentError();
  }
}
