import { defineConfig } from '@playwright/test';

const existingNoProxy = process.env.NO_PROXY ?? process.env.no_proxy;
process.env.NO_PROXY = ['127.0.0.1', 'localhost', existingNoProxy]
  .filter((value): value is string => value !== undefined && value !== '')
  .join(',');

export default defineConfig({
  testDir: './tests',
  testMatch: 'layout.e2e.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: 'http://127.0.0.1:3410/poker/',
    viewport: { width: 1366, height: 768 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx concurrently -k -s first "HOST=127.0.0.1 PORT=3411 BASE_PATH=/poker npx tsx src/server/index.ts" "VITE_BASE_PATH=/poker VITE_SERVER_TARGET=http://127.0.0.1:3411 npx vite --host 127.0.0.1 --port 3410 --strictPort"',
    url: 'http://127.0.0.1:3410/poker/',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
