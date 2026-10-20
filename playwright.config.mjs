import { defineConfig, devices } from '@playwright/test';
// Requires the local stack (npm run stack:start) to be running.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'], browserName: 'chromium' }, testMatch: /member\.spec\.mjs/ },
    { name: 'desktop', use: { viewport: { width: 1366, height: 900 }, browserName: 'chromium' }, testMatch: /admin\.spec\.mjs/ },
  ],
  webServer: { command: 'npx vite --mode development', url: 'http://127.0.0.1:5173', reuseExistingServer: true, timeout: 60000 },
});
