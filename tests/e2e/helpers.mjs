import { expect } from '@playwright/test';
export const MIGHTY = 'http://127.0.0.1:54400';
/** Sign in through the mock of Mighty, picking a member by ID. */
export async function signInAs(page, memberId) {
  await page.goto('/#/signin');
  await page.getByRole('button', { name: /Sign in with your HETMA community account/ }).click();
  await page.locator(`a[data-member="${memberId}"]`).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
/** A small but valid-looking PDF (checked by its first bytes in the app). */
export const pdf = name => ({ name, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n% ${name}\n${'0'.repeat(200)}\n%%EOF\n`) });
export async function uploadArea(page, code, file = pdf(`${code}.pdf`)) {
  await page.locator(`li[data-area="${code}"]`).getByRole('button', { name: /Upload/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#up-file').setInputFiles(file);
  await expect(dialog.getByRole('button', { name: 'Submit' })).toBeDisabled();
  await dialog.locator('#up-attest').check();
  await dialog.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
export async function noHorizontalOverflow(page) {
  const [sw, w] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw).toBeLessThanOrEqual(w + 1);
}
