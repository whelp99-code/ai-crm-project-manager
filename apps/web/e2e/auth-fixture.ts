import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { FixtureControlError, readOwnedFixtureControl, type FixtureControl } from "./fixture-control";

async function ownedControl(): Promise<FixtureControl> {
  const directory = process.env.PLAYWRIGHT_FIXTURE_DIRECTORY;
  if (!directory) {
    throw new FixtureControlError(
      "DIRECTORY_REQUIRED",
      "PLAYWRIGHT_FIXTURE_DIRECTORY is required. When PLAYWRIGHT_BASE_URL is set it must name the owned server control directory. Refusing operator login.",
    );
  }
  return readOwnedFixtureControl(directory, process.env.PLAYWRIGHT_BASE_URL);
}

export async function resetOwnedFixture(): Promise<void> {
  const initial = await ownedControl();
  const reset = await fetch(`${initial.origin}/__playwright/auth/reset`, {
    method: "POST",
    headers: { "x-playwright-reset-token": initial.controlSecret },
  });
  expect(reset.status).toBe(200);
}

export async function loginOwner(
  page: Page,
  options: { readonly navigate?: boolean } = {},
): Promise<void> {
  await resetOwnedFixture();
  const { password, totp } = await ownedControl();
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
