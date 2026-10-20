import { test, expect } from '@playwright/test';
import { signInAs, MIGHTY } from './helpers.mjs';

test('an admin spot-checks, verifies and revokes; the credential and badge follow', async ({ page, browser }) => {
  // Priya (1002) has the credential in the demo data; make sure Mighty shows her badge first.
  const priya = await browser.newPage();
  await signInAs(priya, 1002);
  await expect(priya.getByRole('heading', { name: 'You’ve earned the HEx Credential' })).toBeVisible();
  await expect.poll(async () => (await (await fetch(`${MIGHTY}/__mock/state`)).json()).badges['1002']).toEqual([777]);
  const credUrl = await priya.locator('#cred-url').textContent();

  await signInAs(page, 1004); // Alex Kim, super admin
  await page.getByRole('link', { name: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible();

  // Verify one of Priya's unchecked uploads.
  await page.getByPlaceholder('Search member, area or provider').fill('priya');
  await expect(page.locator('table.data tbody tr').first()).toContainText('Priya Shah');
  await page.locator('table.data tbody tr').first().getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Mark verified' }).click();
  await expect(page.getByText('Marked verified.')).toBeVisible();

  // Revoke another: reason required, then the credential ends and the badge comes off.
  await page.locator('table.data tbody tr').first().getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByText('Add a reason so the member knows why.')).toBeVisible();
  await page.locator('#rv-reason').fill('The provider has no record of this certificate.');
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByText(/no longer active and the Mighty badge was removed/)).toBeVisible();
  await expect.poll(async () => (await (await fetch(`${MIGHTY}/__mock/state`)).json()).badges['1002']).toEqual([]);

  // Members tab and audit log reflect it.
  await page.getByRole('link', { name: 'Members' }).click();
  await expect(page.getByRole('columnheader', { name: 'Mighty badge' })).toBeVisible();
  await expect(page.locator('tr', { hasText: 'Priya Shah' })).toContainText('No longer active');
  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('columnheader', { name: 'Details' })).toBeVisible();
  await expect(page.locator('tbody tr').first()).toContainText('Priya Shah');
  await expect(page.getByText('Revoked an upload').first()).toBeVisible();

  // Public page now says not active; Priya sees the reason.
  await priya.goto(credUrl);
  await expect(priya.getByText('This credential is no longer active.')).toBeVisible();
  await priya.goto('/#/me');
  await expect(priya.getByText('The provider has no record of this certificate.')).toBeVisible();
});

test('non-staff members are sent away from the admin workspace', async ({ page }) => {
  await signInAs(page, 1003);
  await page.goto('/#/admin');
  await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);
  await expect(page).toHaveURL(/#\/me/);
});
