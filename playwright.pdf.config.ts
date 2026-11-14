import { defineConfig } from "@playwright/test";
import base from "./playwright.private.config";
/** A fresh isolated D1/R2 keeps PDF quota usage independent of the legacy suite. */
export default defineConfig({
  ...base,
  testDir: "tests/browser-pdf",
  outputDir: "test-results/pdf",
  reporter: [
    ["list"],
    ...(process.env.GITHUB_ACTIONS ? [["github"] as ["github"]] : []),
    ["json", { outputFile: "test-results/pdf-results.json" }],
  ],
});
