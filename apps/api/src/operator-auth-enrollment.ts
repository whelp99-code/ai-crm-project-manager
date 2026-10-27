import { z } from "zod";
import { acceptedOperatorTotpStep, operatorPasswordHash } from "./operator-auth-crypto.js";
import type { OperatorAuthRecord } from "./operator-auth-store.js";

const enrollmentSchema = z.object({
  password: z.string().min(12).refine(value => Buffer.byteLength(value, "utf8") <= 72),
  totpSecret: z.string().regex(/^[A-Z2-7]{32}$/),
  totp: z.string().regex(/^\d{6}$/),
}).strict();

export class OperatorEnrollmentError extends Error {
  constructor() {
    super("OPERATOR_ENROLLMENT_REJECTED");
    this.name = "OperatorEnrollmentError";
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
