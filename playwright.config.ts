import { defineConfig } from '@playwright/test';

const evidenceRoot =
  process.env.EIGHTCARDS_EVIDENCE ??
  'C:/Users/12571/8cards-task19-evidence/automation/playwright';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: `${evidenceRoot}/artifacts`,
  reporter: [
    ['list'],
    ['html', { outputFolder: `${evidenceRoot}/report`, open: 'never' }],
    ['json', { outputFile: `${evidenceRoot}/playwright-results.json` }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4173',
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
  webServer: [
    {
      command: 'pnpm --filter @8cards/server dev',
      url: 'http://127.0.0.1:3101/health',
      env: {
        PORT: '3101',
        EIGHTCARDS_DB:
          process.env.EIGHTCARDS_DB ??
          'C:/Users/12571/8cards-task19-evidence/persistence/e2e.sqlite',
      },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command:
        'pnpm --filter @8cards/web dev --host 127.0.0.1 --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      env: { VITE_WS_URL: 'ws://127.0.0.1:3101/ws' },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
