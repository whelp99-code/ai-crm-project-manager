import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

interface FixtureControl {
  readonly origin: string;
  readonly controlSecret: string;
  readonly password: string;
  readonly totp: string;
}

function parseFixtureControl(value: unknown): FixtureControl {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("native auth fixture control data must be an object");
  }
  if (!("origin" in value) || !("controlSecret" in value) || !("password" in value) || !("totp" in value)
    || typeof value.origin !== "string" || typeof value.controlSecret !== "string"
    || !/^[A-Za-z0-9_-]{40,64}$/.test(value.controlSecret)
    || typeof value.password !== "string" || value.password.length < 1
    || typeof value.totp !== "string" || !/^\d{6}$/.test(value.totp)) {
    throw new TypeError("native auth fixture control data is invalid");
  }
  const origin = new URL(value.origin);
  if (origin.origin !== value.origin || origin.protocol !== "http:"
    || origin.hostname !== "127.0.0.1" || !origin.port) {
    throw new TypeError("native auth fixture origin must be an IPv4 loopback origin");
  }
  return {
    origin: value.origin,
    controlSecret: value.controlSecret,
    password: value.password,
    totp: value.totp,
  };
}

async function fixtureControl(): Promise<FixtureControl> {
  const directory = process.env.PLAYWRIGHT_FIXTURE_DIRECTORY;
  if (!directory) throw new Error("PLAYWRIGHT_FIXTURE_DIRECTORY is required");
  const value: unknown = JSON.parse(await readFile(`${directory}/auth-control.json`, "utf8"));
  return parseFixtureControl(value);
}

export async function loginOwner(
  page: Page,
  options: { readonly navigate?: boolean } = {},
): Promise<void> {
  const initial = await fixtureControl();
  const reset = await fetch(`${initial.origin}/__playwright/auth/reset`, {
    method: "POST",
    headers: { "x-playwright-reset-token": initial.controlSecret },
  });
  expect(reset.status).toBe(200);
  const { password, totp } = await fixtureControl();
  if (options.navigate !== false) await page.goto("/login");
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "다음: OTP 입력" }).click();
  await page.getByLabel("일회용 인증 코드 (OTP)", { exact: true }).fill(totp);
  await page.getByRole("button", { name: "CRM 들어가기" }).click();
  await expect(page).toHaveURL(/\/v2\/mail-candidate-review$/);
}

export async function ownerCookie(page: Page): Promise<string> {
  return (await page.context().cookies())
    .filter(cookie => cookie.name === "cwos_operator_stepup")
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join("; ");
}
