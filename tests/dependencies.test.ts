import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
it("removes Supabase packages, startup commands and runtime frontend/API imports", async () => {
  for (const p of [
    "package.json",
    "apps/web/package.json",
    "apps/api/package.json",
    "package-lock.json",
    "apps/web/src/client.ts",
    "apps/web/src/main.tsx",
    "apps/api/src/index.ts",
    "apps/api/src/database.ts",
  ]) {
    expect((await readFile(p, "utf8")).toLowerCase(), p).not.toContain(
      "supabase",
    );
  }
});
