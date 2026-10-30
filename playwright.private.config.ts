import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser-private",
  workers: 1,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    baseURL: "http://127.0.0.1:4191",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    },
  },
  webServer: {
    command: "vite-node tests/helpers/browser-server.ts",
    url: "http://127.0.0.1:4191",
    reuseExistingServer: false,
    timeout: 30000,
  },
  outputDir: "test-results/private",
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/private-results.json" }],
  ],
});
