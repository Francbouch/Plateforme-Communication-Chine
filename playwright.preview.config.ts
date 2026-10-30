import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    baseURL: "http://127.0.0.1:4173",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    },
  },
  webServer: {
    command:
      "npm exec -w @forgebridge/web -- vite preview --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
  outputDir: "test-results/preview",
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/preview-results.json" }],
  ],
});
