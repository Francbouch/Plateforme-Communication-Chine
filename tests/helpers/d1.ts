import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
export async function migrate(
  db: D1Database,
  options: { after?: string; through?: string } = {},
) {
  const directory = new URL("../../apps/api/migrations/", import.meta.url);
  for (const file of (await readdir(directory))
    .filter(
      (f) =>
        f.endsWith(".sql") &&
        (!options.after || f > options.after) &&
        (!options.through || f <= options.through),
    )
    .sort()) {
    let statement = "";
    for (const line of (await readFile(new URL(file, directory), "utf8")).split(
      "\n",
    )) {
      if (line.trim().startsWith("--") || !line.trim()) continue;
      statement += line + "\n";
      if (line.trim().endsWith(";")) {
        await db.prepare(statement).run();
        statement = "";
      }
    }
    if (statement.trim()) throw new Error("Unterminated test migration");
  }
}
export async function createDatabase(persist?: string) {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("test harness")}}',
      compatibilityDate: "2026-10-29",
      d1Databases: { DB: "forgebridge-integration" },
      r2Buckets: { DOCUMENTS: "forgebridge-integration-files" },
      ...(persist ? { resourcePersistencePath: persist } : {}),
    }),
  );
  const db = (await runtime.getD1Database("DB")) as unknown as D1Database;
  return { runtime, db };
}
