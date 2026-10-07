import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    channel: "chromium",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    launchOptions: process.env.CODE_TAPE_CHROME_PATH
      ? { executablePath: process.env.CODE_TAPE_CHROME_PATH }
      : undefined,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      cwd: repositoryRoot,
      command: "npm run build:api && node scripts/e2e-api-server.mjs",
      url: "http://127.0.0.1:4173/_e2e/health",
      env: { NODE_ENV: "test", CODE_TAPE_E2E_TOKEN: "codetape-e2e-control" },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      cwd: repositoryRoot,
      command: "npm run dev",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { CODE_TAPE_DEV_API: "http://127.0.0.1:4173" },
    },
  ],
});
