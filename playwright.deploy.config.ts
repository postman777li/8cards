import { defineConfig } from '@playwright/test';

const baseURL = process.env.DEPLOY_BASE_URL;
if (!baseURL?.startsWith('https://'))
  throw new Error('DEPLOY_BASE_URL must be the deployed HTTPS origin');

const evidenceRoot =
  process.env.EIGHTCARDS_EVIDENCE ??
  'C:/Users/12571/8cards-task20-evidence/public-playwright';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: `${evidenceRoot}/artifacts`,
  reporter: [
    ['list'],
    ['html', { outputFolder: `${evidenceRoot}/report`, open: 'never' }],
  ],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions:
      process.platform === 'win32'
        ? {
            executablePath:
              'C:/Program Files/Google/Chrome/Application/chrome.exe',
          }
        : undefined,
  },
});
