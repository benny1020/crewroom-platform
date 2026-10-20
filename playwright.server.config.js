import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/server-e2e",
  outputDir: "./test-results/server",
  fullyParallel: false,
  timeout: 60000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report/server", open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:4186",
    viewport: { width: 1440, height: 1080 },
    colorScheme: "light",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/server-e2e.mjs",
    url: "http://127.0.0.1:4186/api/ready",
    reuseExistingServer: false,
    timeout: 120000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10000 },
  },
});
