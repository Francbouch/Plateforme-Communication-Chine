import type { TranslationResult } from "../packages/shared/src/translations";
import {
  verifyTechnical,
  protect,
} from "../apps/api/src/translation/protection";
import { DeepLFreeProvider } from "../apps/api/src/translation/provider";
import { simulatedDeepLFetch } from "./helpers/translation-provider";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { migrate } from "./helpers/d1";
const admin = "00000000-0000-4000-8000-000000000001",
  origin = "https://workspace.example.test",
  issuer = "https://approval-test.cloudflareaccess.com";
let persistence: string;
let script: string,
  token: string,
  runtime: Miniflare,
  db: D1Database,
  storage: R2Bucket,
  org: string,
  project: string;
beforeAll(async () => {
  const key = await generateKeyPair("RS256"),
    jwk = await exportJWK(key.publicKey);
  token = await new SignJWT({ email: "library@example.test", type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(issuer)
    .setAudience("library")
    .setSubject("library-owner")
    .setIssuedAt()
    .setExpirationTime("30m")
    .sign(key.privateKey);
  const result = await build({
    stdin: {
      contents: `import {createApp} from './apps/api/src/index';import {AccessIdentityProvider} from './apps/api/src/identity';import {createLocalJWKSet} from 'jose';import {DeepLFreeProvider} from './apps/api/src/translation/provider';import {simulatedDeepLFetch} from './tests/helpers/translation-provider';export default createApp(new AccessIdentityProvider(createLocalJWKSet({keys:[${JSON.stringify({ ...jwk, kid: "test", alg: "RS256" })}]})),fetch,env=>new DeepLFreeProvider(env.DEEPL_API_KEY,simulatedDeepLFetch));`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  script = result.outputFiles[0].text;
});
async function req(
  path: string,
  body?: unknown,
  method?: string,
  headers: Record<string, string> = {},
) {
  return runtime.dispatchFetch(`${origin}/api/v1/${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      Origin: origin,
      "Cf-Access-Jwt-Assertion": token,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function json<T>(response: Awaited<ReturnType<typeof req>>): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBeLessThan(300);
  return JSON.parse(text) as T;
}
function makeRuntime(overrides: Record<string, string> = {}) {
  return new Miniflare(
    convertV4MiniflareOptions({
      resourcePersistencePath: persistence,
      modules: true,
      script,
      compatibilityDate: "2026-10-29",
      d1Databases: { DB: "approval-test" },
      r2Buckets: { DOCUMENTS: "approval-files" },
      bindings: {
        APP_ORIGIN: origin,
        ACCESS_ISSUER: issuer,
        ACCESS_AUD: "library",
        ADMIN_EMAIL: "library@example.test",
        ADMIN_USER_ID: admin,
        TRANSLATION_ENABLED: "true",
        DEEPL_API_KEY: "test-only-not-a-real-secret:fx",
        TRANSLATION_PER_MINUTE: "30",
        TRANSLATION_DAILY_CHARACTERS: "500000",
        ...overrides,
      },
    }),
  );
}
beforeEach(async () => {
  persistence = await mkdtemp(join(tmpdir(), "forgebridge-translation-test-"));
  runtime = makeRuntime();
  db = (await runtime.getD1Database("DB")) as unknown as D1Database;
  storage = (await runtime.getR2Bucket("DOCUMENTS")) as unknown as R2Bucket;
  await migrate(db);
  org = (
    await json<{ id: string }>(
      await req("organizations", { name: "Approval test" }),
    )
  ).id;
  project = (
    await json<{ id: string }>(
      await req("projects", {
        organization_id: org,
        code: "LIB",
        name: "Library project",
      }),
    )
  ).id;
});
afterEach(async () => {
  await runtime.dispose();
  await rm(persistence, { recursive: true, force: true });
});
const example =
  "Veuillez augmenter l'épaisseur de cette pièce à 3 mm et conserver une tolérance de ±0,1 mm. M8 × 1,25 · AISI 304 · ISO 2768 · LC-001 · Révision C";
async function message(body = example, shared = false) {
  const conversation = (
    await json<{ id: string }>(
      await req(`projects/${project}/conversations`, {
        title: "Translation tests",
      }),
    )
  ).id;
  const id = crypto.randomUUID();
  await json(
    await req(`conversations/${conversation}/messages`, { id, body, shared }),
  );
  return { id, conversation };
}
const translate = (
  id: string,
  target_language = "en",
  extra: Record<string, unknown> = {},
) =>
  req("translations", {
    kind: "message",
    id,
    field: "body",
    source_language: "fr",
    target_language,
    ...extra,
  });
const scalar = async (sql: string, ...args: unknown[]) =>
  db
    .prepare(sql)
    .bind(...args)
    .first<number>("n");
describe("private central translations — simulated provider, real Worker/D1", () => {
  it("translates French to English and simplified Chinese, Chinese to French and preserves every engineering token", async () => {
    const m = await message();
    const en = await json<TranslationResult>(await translate(m.id)),
      zh = await json<TranslationResult>(await translate(m.id, "zh-CN"));
    expect(en.machine).toContain("Please increase");
    expect(zh.machine).toContain("请将此零件厚度");
    for (const r of [en, zh]) {
      expect(r.warnings).toEqual([]);
      expect(verifyTechnical(example, r.machine)).toEqual([]);
      expect(r.machine).toContain("M8 × 1,25");
      expect(r.machine).toContain("±0,1 mm");
      expect(r.original).toBe(example);
    }
    const c = await message("请将厚度增加至 3 mm");
    const fr = await json<TranslationResult>(
      await translate(c.id, "fr", { source_language: "auto" }),
    );
    expect(fr.machine).toContain("Veuillez augmenter");
    expect(fr.detected_language).toBe("ZH");
    expect(
      await db
        .prepare("SELECT body FROM conversation_messages WHERE id=?")
        .bind(m.id)
        .first("body"),
    ).toBe(example);
  });
  it("reuses cache, keeps corrections and machine text, invalidates source changes and retranlates only on request", async () => {
    const m = await message("Bonjour 3 mm");
    const a = await json<TranslationResult>(await translate(m.id));
    const corrected = await json<TranslationResult>(
      await req(
        `translations/${a.id}`,
        { body: "Good morning 3 mm", version: 0 },
        "PATCH",
      ),
    );
    expect(corrected.machine).toBe("Hello 3 mm");
    expect(corrected.corrected).toBe("Good morning 3 mm");
    expect(corrected.corrector).toBeTruthy();
    const cached = await json<TranslationResult>(await translate(m.id));
    expect(cached.cached).toBe(true);
    expect(cached.id).toBe(a.id);
    expect(cached.corrected).toBe(corrected.corrected);
    expect(await scalar("SELECT count(*) n FROM translation_attempts")).toBe(1);
    expect(
      (
        await req(
          `translations/${a.id}`,
          { body: "Stale 3 mm", version: 0 },
          "PATCH",
        )
      ).status,
    ).toBe(409);
    const forced = await json<TranslationResult>(
      await translate(m.id, "en", { force: true }),
    );
    expect(forced.id).not.toBe(a.id);
    expect(forced.corrected).toBeNull();
    await json(
      await req(
        `messages/${m.id}`,
        { body: "Bonjour 4 mm", version: 1, shared: false },
        "PATCH",
      ),
    );
    expect(
      (
        await req(
          `translations/${a.id}`,
          { body: "Old 3 mm", version: 1 },
          "PATCH",
        )
      ).status,
    ).toBe(409);
    const updated = await json<TranslationResult>(await translate(m.id));
    expect(updated.machine).toContain("4 mm");
    expect(updated.corrected).toBeNull();
    expect(await scalar("SELECT count(*) n FROM translations")).toBe(3);
    await runtime.dispose();
    runtime = makeRuntime();
    db = (await runtime.getD1Database("DB")) as unknown as D1Database;
    expect((await json<TranslationResult>(await translate(m.id))).id).toBe(
      updated.id,
    );
  });
  it("uses only relevant organization glossary entries, supports edit/search/domain/delete and invalidates affected cache", async () => {
    const m = await message("Charnière 3 mm"),
      v = {
        fr: "Charnière",
        en: "Verified hinge",
        "zh-CN": "已核实铰链",
        domain: "Mécanique",
        notes: "Human verified test term",
      };
    const g = await json<{ id: string }>(
      await req(`organizations/${org}/glossary`, v),
    );
    const a = await json<TranslationResult>(await translate(m.id));
    expect(a.machine).toBe("Verified hinge 3 mm");
    expect(
      (
        await json<{ items: unknown[] }>(
          await req(
            `organizations/${org}/glossary?q=char&domain=M%C3%A9canique`,
          ),
        )
      ).items,
    ).toHaveLength(1);
    await json(
      await req(
        `organizations/${org}/glossary/${g.id}`,
        { ...v, en: "Updated hinge", version: 1 },
        "PATCH",
      ),
    );
    expect((await json<TranslationResult>(await translate(m.id))).machine).toBe(
      "Updated hinge 3 mm",
    );
    expect(
      (
        await req(
          `organizations/${org}/glossary/${g.id}`,
          { ...v, version: 1 },
          "PATCH",
        )
      ).status,
    ).toBe(409);
    await json(
      await req(
        `organizations/${org}/glossary/${g.id}`,
        { version: 2 },
        "DELETE",
      ),
    );
    expect((await json<TranslationResult>(await translate(m.id))).machine).toBe(
      "Hinge 3 mm",
    );
    expect(await scalar("SELECT count(*) n FROM translations")).toBe(3);
  });
  it("retains suspicious machine results and warns on manual numerical changes without claiming verification", async () => {
    const m = await message("brokentoken 3 mm LC-001"),
      r = await json<TranslationResult>(await translate(m.id));
    expect(r.warnings).toContain("protected_segment_changed");
    expect(r.warnings).toContain("technical_values_changed");
    expect(r.machine).toContain("999 mm");
    const safe = await message("Bonjour 3 mm"),
      t = await json<TranslationResult>(await translate(safe.id));
    const c = await json<TranslationResult>(
      await req(
        `translations/${t.id}`,
        { body: "Hello 4 mm", version: 0 },
        "PATCH",
      ),
    );
    expect(c.warnings).toContain("technical_values_changed");
    await expect(
      db
        .prepare("UPDATE translations SET machine='overwrite' WHERE id=?")
        .bind(t.id)
        .run(),
    ).rejects.toThrow(/immutable/);
    await expect(
      db
        .prepare("DELETE FROM translation_corrections WHERE translation_id=?")
        .bind(t.id)
        .run(),
    ).rejects.toThrow(/append-only/);
  });
  it("handles provider errors/quota/invalid response without caching errors or changing original and releases lock for retry", async () => {
    for (const [text, status] of [
      ["providererror", 502],
      ["providerinvalid", 502],
      ["providerquota", 429],
    ] as const) {
      const m = await message(text);
      expect((await translate(m.id)).status).toBe(status);
      expect((await translate(m.id)).status).toBe(status);
      expect(
        await db
          .prepare("SELECT body FROM conversation_messages WHERE id=?")
          .bind(m.id)
          .first("body"),
      ).toBe(text);
    }
    expect(await scalar("SELECT count(*) n FROM translations")).toBe(0);
    expect(await scalar("SELECT count(*) n FROM translation_locks")).toBe(0);
  });
  it("enforces canonical fields, authentication, origin, current membership and private message authors before cache use", async () => {
    const m = await message();
    await json(await translate(m.id));
    expect((await translate(m.id, "en", { field: "status" })).status).toBe(400);
    expect(
      (
        await req(
          "translations",
          { kind: "message", id: m.id, field: "body", target_language: "en" },
          "POST",
          { Origin: "https://evil.test" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await req(
          "translations",
          { kind: "message", id: m.id, field: "body", target_language: "en" },
          "POST",
          { "Cf-Access-Jwt-Assertion": "" },
        )
      ).status,
    ).toBe(401);
    const other = crypto.randomUUID();
    await db
      .prepare("INSERT INTO profiles(id,email,name) VALUES(?,?,'Other')")
      .bind(other, "other@test.local")
      .run();
    await db
      .prepare("UPDATE conversation_messages SET body=body WHERE id=?")
      .bind(m.id)
      .run();
    await db
      .prepare(
        "UPDATE organization_memberships SET active=0 WHERE organization_id=?",
      )
      .bind(org)
      .run();
    expect((await translate(m.id)).status).toBe(403);
    expect((await req(`organizations/${org}/glossary`)).status).toBe(403);
  });
  it("enforces daily request, character and per-user frequency quotas atomically, without charging cache hits", async () => {
    const m = await message("Bonjour 3 mm");
    const a = await json<TranslationResult>(await translate(m.id));
    for (let i = 0; i < 29; i++)
      await db
        .prepare(
          "INSERT INTO translation_attempts(id,organization_id,actor_id,characters) VALUES(?,?,?,1)",
        )
        .bind(crypto.randomUUID(), org, admin)
        .run();
    expect((await translate(m.id, "zh-CN")).status).toBe(429);
    expect((await json<TranslationResult>(await translate(m.id))).id).toBe(
      a.id,
    );
    await db
      .prepare("UPDATE translation_attempts SET created=unixepoch()-120")
      .run();
    for (let i = 0; i < 70; i++)
      await db
        .prepare(
          "INSERT INTO translation_attempts(id,organization_id,actor_id,characters,created) VALUES(?,?,?,?,unixepoch()-120)",
        )
        .bind(crypto.randomUUID(), org, admin, 1)
        .run();
    expect((await translate(m.id, "zh-CN")).status).toBe(429);
    await db.prepare("DELETE FROM translation_attempts").run();
    await db
      .prepare(
        "INSERT INTO translation_attempts(id,organization_id,actor_id,characters,created) VALUES(?,?,?,?,unixepoch()-120)",
      )
      .bind(crypto.randomUUID(), org, admin, 500000)
      .run();
    expect((await translate(m.id, "zh-CN")).status).toBe(429);
  });
  it("does not expose keys through config, only uses API Free and rejects invalid or same-language inputs", async () => {
    const config = await req("translations/config");
    expect(await config.text()).not.toContain("test-only");
    const m = await message();
    expect((await translate(m.id, "fr")).status).toBe(400);
    expect((await translate(m.id, "de")).status).toBe(400);
    const p = new DeepLFreeProvider("test-only:fx", simulatedDeepLFetch);
    expect((await p.translate("Bonjour", [], "auto", "en")).text).toBe("Hello");
    const prepared = protect(
      "3 mm · 3 mm · M8 × 1,25 · ISO 2768 · LC-001 · Révision C",
      [],
      "fr",
      "en",
      "test",
    );
    expect(prepared.restore(prepared.text).warnings).toEqual([]);
  });
});

async function revisionFixture() {
  const document = crypto.randomUUID(),
    revision = crypto.randomUUID(),
    objectKey = `translation-test/${revision}.pdf`;
  const bytes = new TextEncoder().encode(
    "%PDF-1.7\nnon confidential translation fixture\n%%EOF",
  );
  await storage.put(objectKey, bytes);
  await db
    .prepare("INSERT INTO documents(id,project_id,name,number) VALUES(?,?,?,?)")
    .bind(document, project, "Test drawing", "LC-001")
    .run();
  await db
    .prepare(
      "INSERT INTO document_revisions(id,document_id,ordinal,label,filename,extension,content_type,size,sha256,object_key,created_by) VALUES(?,?,1,'C','fixture.pdf','pdf','application/pdf',?,?,?,?)",
    )
    .bind(revision, document, bytes.length, "a".repeat(64), objectKey, admin)
    .run();
  return { document, revision, objectKey, bytes };
}
it("translates PDF point title/description and replies and rejection/changes/cancellation reasons without touching geometry, decisions or R2", async () => {
  const f = await revisionFixture(),
    point = crypto.randomUUID();
  await json(
    await req(`revisions/${f.revision}/review-items`, {
      id: point,
      title: "Déplacer le trou",
      summary: "Le trou doit être déplacé de 2 mm vers la gauche.",
      page: 1,
      type: "discussion",
      geometry: { points: [] },
    }),
  );
  const reply = crypto.randomUUID();
  await json(
    await req(`review-items/${point}/messages`, {
      id: reply,
      body: "Bonjour 3 mm LC-001",
    }),
  );
  const before = await db
    .prepare("SELECT * FROM review_items WHERE id=?")
    .bind(point)
    .first();
  const refs = [
    { kind: "review_item", id: point, field: "title" },
    { kind: "review_item", id: point, field: "summary" },
    { kind: "review_message", id: reply, field: "body" },
  ];
  for (const ref of refs) {
    const t = await json<TranslationResult>(
      await req("translations", {
        ...ref,
        source_language: "fr",
        target_language: "en",
      }),
    );
    expect(t.warnings).toEqual([]);
    expect(t.machine).not.toBe(t.original);
  }
  const a = crypto.randomUUID();
  await json(
    await req(`approvals`, {
      id: a,
      revision_id: f.revision,
      title: "Déplacer le trou",
      description: "Bonjour 3 mm",
      purpose: "manufacturing",
    }),
  );
  await json(
    await req(`approvals/${a}/actions`, { action: "submit", version: 1 }),
  );
  await json(
    await req(`approvals/${a}/actions`, {
      action: "reject",
      version: 2,
      comment: "Refus technique 3 mm LC-001",
    }),
  );
  const decision = await db
    .prepare("SELECT * FROM approval_requests WHERE id=?")
    .bind(a)
    .first();
  for (const field of ["title", "description", "decision_comment"])
    await json(
      await req("translations", {
        kind: "approval",
        id: a,
        field,
        source_language: "fr",
        target_language: "en",
      }),
    );
  const event = await db
    .prepare(
      "SELECT id FROM approval_events WHERE approval_id=? AND action='approval.reject'",
    )
    .bind(a)
    .first<{ id: string }>();
  const translated = await json<TranslationResult>(
    await req("translations", {
      kind: "approval_event",
      id: event!.id,
      field: "comment",
      source_language: "fr",
      target_language: "zh-CN",
    }),
  );
  expect(translated.machine).toContain("技术拒绝");
  expect(
    await db
      .prepare("SELECT * FROM approval_requests WHERE id=?")
      .bind(a)
      .first(),
  ).toEqual(decision);
  expect(
    await db
      .prepare("SELECT * FROM review_items WHERE id=?")
      .bind(point)
      .first(),
  ).toEqual(before);
  expect(
    new Uint8Array(await (await storage.get(f.objectKey))!.arrayBuffer()),
  ).toEqual(f.bytes);
});
it("protects private content across organizations, prevents cache/correction access and restricts glossary writes to owners", async () => {
  const m = await message("Bonjour 3 mm"),
    a = await json<TranslationResult>(await translate(m.id));
  const other = crypto.randomUUID();
  await db
    .prepare("INSERT INTO profiles(id,email,name) VALUES(?,?,'Other')")
    .bind(other, "other@example.test")
    .run();
  // Identity trigger forbids changing authors: insert a second author's private message instead.
  const privateId = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO conversation_messages(id,conversation_id,author_id,body) VALUES(?,?,?,'Bonjour')",
    )
    .bind(privateId, m.conversation, other)
    .run();
  expect((await translate(privateId)).status).toBe(403);
  await db
    .prepare(
      "UPDATE organization_memberships SET active=0 WHERE organization_id=?",
    )
    .bind(org)
    .run();
  expect(
    (
      await req(
        `translations/${a.id}`,
        { body: "Hello 3 mm", version: 0 },
        "PATCH",
      )
    ).status,
  ).toBe(403);
  const foreignOrg = (
    await json<{ id: string }>(
      await req("organizations", { name: "Other test organization" }),
    )
  ).id;
  expect(
    (
      await req(`organizations/${org}/glossary`, {
        fr: "Test",
        en: "Test",
        "zh-CN": "测试",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await json<{ items: unknown[] }>(
        await req(`organizations/${foreignOrg}/glossary`),
      )
    ).items,
  ).toEqual([]);
});
it("deduplicates concurrent work and retains usable cache while provider configuration is disabled", async () => {
  const m = await message("Bonjour 3 mm");
  const responses = await Promise.all([translate(m.id), translate(m.id)]);
  expect(responses.some((r) => r.status === 201)).toBe(true);
  for (const r of responses) expect([200, 201, 409]).toContain(r.status);
  expect(await scalar("SELECT count(*) n FROM translation_attempts")).toBe(1);
  expect(await scalar("SELECT count(*) n FROM translations")).toBe(1);
  await runtime.dispose();
  runtime = makeRuntime({ TRANSLATION_ENABLED: "false" });
  db = (await runtime.getD1Database("DB")) as unknown as D1Database;
  expect((await json<TranslationResult>(await translate(m.id))).cached).toBe(
    true,
  );
  expect((await translate(m.id, "zh-CN")).status).toBe(503);
  expect(
    (await json<{ enabled: boolean }>(await req("translations/config")))
      .enabled,
  ).toBe(false);
});
