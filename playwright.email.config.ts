import { defineConfig } from "@playwright/test";
import base from "./playwright.private.config";
export default defineConfig({
  ...base,
  testDir: "tests/browser-email",
  webServer: {
    ...base.webServer,
    command: "TEST_EMAIL_AUTH=1 vite-node tests/helpers/browser-server.ts",
    url: "http://127.0.0.1:4191",
    timeout: 60000,
    reuseExistingServer: false,
  },
  outputDir: "test-results/email",
  reporter: [
    ["list"],
    ...(process.env.GITHUB_ACTIONS ? [["github"] as ["github"]] : []),
    ["json", { outputFile: "test-results/email-results.json" }],
  ],
});
