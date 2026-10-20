import { test, expect } from '@playwright/test';
import { signInAs, uploadArea, areaRow, noHorizontalOverflow, pdf, MIGHTY } from './helpers.mjs';

test('a member signs in with Mighty, uploads the missing areas and earns the credential', async ({ page }) => {
  await signInAs(page, 1001); // Jordan Rivera: 7 of 10 done in the demo data
  await expect(page.getByRole('heading', { name: '3 areas left to your HEx Credential' })).toBeVisible();
  await expect(page.getByText('Higher Ed Hub')).toBeVisible();
  await noHorizontalOverflow(page);

  // A file that isn't really a PDF is refused before upload.
  await areaRow(page, 'Digital signage').getByRole('button', { name: /Upload/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#up-file').setInputFiles({ name: 'fake.pdf', mimeType: 'application/pdf', buffer: Buffer.from('<html>' + 'x'.repeat(300)) });
  await dialog.locator('#up-attest').check();
  await dialog.getByRole('button', { name: 'Submit' }).click();
  await expect(dialog.getByText('doesn’t look like a real PDF')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await uploadArea(page, 'Digital signage');
  await uploadArea(page, 'AV design & standards');
  await expect(page.getByRole('heading', { name: '1 area left to your HEx Credential' })).toBeVisible();
  await uploadArea(page, 'Accessibility & ADA compliance');
  await expect(page.getByRole('heading', { name: 'You’ve earned the HEx Credential' })).toBeVisible();
  await expect(page.locator('#cred-url')).toContainText('/#/c/');

  // The Mighty badge was added (mock records it).
  await expect.poll(async () => (await (await fetch(`${MIGHTY}/__mock/state`)).json()).badges['1001']).toEqual([777]);

  // The public page works without signing in.
  const url = await page.locator('#cred-url').textContent();
  const pub = await page.context().browser().newPage();
  await pub.goto(url);
  await expect(pub.getByRole('heading', { name: 'Jordan Rivera' })).toBeVisible();
  await expect(pub.getByText('Active', { exact: true })).toBeVisible();
  await expect(pub.locator('.area-list li')).toHaveCount(10);
  await noHorizontalOverflow(pub);
});

test('the sign-in page explains cancelled sign-ins', async ({ page }) => {
  await page.goto('/#/signin');
  await page.getByRole('button', { name: /Sign in with your HETMA community account/ }).click();
  await page.getByRole('link', { name: 'Cancel' }).click();
  await expect(page.getByRole('alert')).toContainText('cancelled');
  await noHorizontalOverflow(page);
});

test('a new person joins HETMA and lands back in the app', async ({ page }) => {
  await page.goto('/#/signin');
  await page.getByRole('button', { name: 'New to HETMA? Join free' }).click();
  await page.locator('#continue').click();
  await page.locator('a[data-member="1003"]').click();
  await expect(page.getByText('Welcome to HETMA!')).toBeVisible();
  await expect(page.getByRole('heading', { name: '10 areas left to your HEx Credential' })).toBeVisible();
});

test('an unknown credential link says so', async ({ page }) => {
  await page.goto('/#/c/abcdefabcdefabcdefabcdef');
  await expect(page.getByRole('heading', { name: 'Credential not found' })).toBeVisible();
});
