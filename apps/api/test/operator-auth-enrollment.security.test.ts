import { describe, expect, it } from "vitest";
import { enrollOperator, OperatorEnrollmentError } from "../src/operator-auth-enrollment.js";
import { operatorPasswordHash, verifyOperatorPassword } from "../src/operator-auth-crypto.js";
import { operatorAuthRecordSchema } from "../src/operator-auth-store.js";

const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const password = "synthetic-enrollment-password";
const input = { password, totpSecret: secret, totp: "287082" };

describe("offline owner enrollment", () => {
  it("stores salted bcrypt and consumes an independently known RFC6238 code", () => {
    // Given: RFC6238 SHA1 vector at 59 seconds, truncated to six digits.
    const now = 59_000;
    // When: offline enrollment verifies the authenticator.
    const record = enrollOperator(input, now);
    // Then: persistent state contains only a valid KDF, never the password.
    expect(operatorAuthRecordSchema.safeParse(record).success).toBe(true);
    expect(verifyOperatorPassword(password, record.passwordHash)).toBe(true);
    expect(record.passwordHash).not.toContain(password);
    expect(record.lastTotpStep).toBe(1);
  });

  it("generates independent salts for the same password", () => {
    const first = operatorPasswordHash(password);
    const second = operatorPasswordHash(password);
    expect(first).not.toBe(second);
    expect(verifyOperatorPassword(password, second)).toBe(true);
  });

  it.each([
    { name: "short password", value: { ...input, password: "short" } },
    { name: "wrong OTP", value: { ...input, totp: "000000" } },
    { name: "invalid secret", value: { ...input, totpSecret: "invalid" } },
    { name: "unknown field", value: { ...input, identity: "spoof" } },
    { name: "multibyte truncation", value: { ...input, password: "한".repeat(25) } },
  ])("rejects $name without returning input", ({ value }) => {
    expect(() => enrollOperator(value, 59_000)).toThrowError(OperatorEnrollmentError);
  });

  it("rejects bcrypt truncation collisions rather than authenticating a suffix", () => {
    const exact = "a".repeat(72);
    const hash = operatorPasswordHash(exact);
    expect(verifyOperatorPassword(`${exact}x`, hash)).toBe(false);
    expect(() => operatorPasswordHash(`${exact}x`)).toThrowError("PASSWORD_TOO_LONG");
  });

  it("fails closed on legacy non-bcrypt state", () => {
    const legacy = {
      generation: 1, enrolled: true, totpPending: false,
      passwordSalt: Buffer.alloc(16, 1).toString("base64url"),
      passwordHash: Buffer.alloc(32, 2).toString("base64url"), totpSecret: secret,
    };
    expect(operatorAuthRecordSchema.safeParse(legacy).success).toBe(false);
  });
});
