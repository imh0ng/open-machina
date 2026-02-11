import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'ui.playwright.ts',
  webServer: {
    command: 'bun run src/index.ts',
    port: 4444,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://localhost:4444',
  },
});
