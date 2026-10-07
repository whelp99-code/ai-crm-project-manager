import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";

/** Same password parameters and TOTP window as the existing Core5 owner auth. */
export function operatorPasswordHash(password: string, salt: string): Buffer {
  return scryptSync(password, Buffer.from(salt, "base64url"), 32, { N: 16384, r: 8, p: 1 });
}

export function equalAuthValue(left: string | Buffer, right: string | Buffer): boolean {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(left);
  const b = Buffer.isBuffer(right) ? right : Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function decodeSecret(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of secret) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function operatorTotpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", decodeSecret(secret)).update(counter).digest();
  const last = hmac.at(-1);
  if (last === undefined) throw new RangeError("TOTP digest is empty");
  return ((hmac.readUInt32BE(last & 15) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

export function acceptedOperatorTotpStep(secret: string, code: string, now: number): number | undefined {
  const step = Math.floor(now / 30_000);
  for (const skew of [-1, 0, 1]) {
    const candidate = step + skew;
    if (candidate >= 0 && equalAuthValue(operatorTotpCode(secret, candidate), code)) return candidate;
  }
  return undefined;
}

export function operatorProofSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`cwos-operator-v1.${payload}`).digest("base64url");
}
