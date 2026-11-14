import {
  rolePermissions,
  type Permissions,
} from "../packages/shared/src/access";
import {
  type PdfTranslationRow,
  type PdfSegment,
} from "../packages/shared/src/pdf-translation";
import { it, expect, beforeAll, beforeEach, afterEach } from "vitest";
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
let signer: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
beforeAll(async () => {
  const key = await generateKeyPair("RS256"),
    jwk = await exportJWK(key.publicKey);
  signer = key.privateKey;
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
    external: ["node:*"],
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
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "approval-test" },
      r2Buckets: { DOCUMENTS: "approval-files" },
      bindings: {
        APP_ORIGIN: origin,
        ACCESS_ISSUER: issuer,
        ACCESS_AUD: "library",
        ADMIN_EMAIL: "library@example.test",
        ADMIN_USER_ID: admin,
        MULTIUSER_ENABLED: "true",
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
const segment: PdfSegment = {
  text: 'REMOVE SHARP EDGES ±0.010 Ø0.530 1/4-20 UNC 9/16" 3 mm AISI 304 ISO 2768-mK LC-120-003 drawing.pdf',
  x: 0.1,
  y: 0.8,
  width: 0.7,
  height: 0.03,
  angle: 0,
  font_size: 12,
  transform: [12, 0, 0, 12, 30, 240],
  order: 0,
};
async function drawing() {
  const document = crypto.randomUUID(),
    revision = crypto.randomUUID(),
    key = `pdf-translation/${revision}.pdf`,
    bytes = new TextEncoder().encode("%PDF-1.7\nSynthetic text fixture\n%%EOF");
  await storage.put(key, bytes);
  await db
    .prepare("INSERT INTO documents(id,project_id,name,number) VALUES(?,?,?,?)")
    .bind(document, project, "Synthetic drawing", "LC-120-003")
    .run();
  await db
    .prepare(
      "INSERT INTO document_revisions(id,document_id,ordinal,label,filename,extension,content_type,size,sha256,object_key,created_by) VALUES(?,?,1,'A','drawing.pdf','pdf','application/pdf',?,?,?,?)",
    )
    .bind(revision, document, bytes.length, "a".repeat(64), key, admin)
    .run();
  return { document, revision, key, bytes };
}
function payload(extra: Record<string, unknown> = {}) {
  return {
    page: 1,
    segments: [segment],
    source_language: "en",
    target_language: "zh-CN",
    audience: "internal",
    ...extra,
  };
}
const generate = (revision: string, extra: Record<string, unknown> = {}) =>
  req(
    `revisions/${revision}/pdf-translate`,
    payload({ consent: true, ...extra }),
  );
it("translates notes without modifying source bytes, preserves protected data, and serves a persistent cache without charging again", async () => {
  const f = await drawing(),
    out = await json<PdfTranslationRow>(await generate(f.revision));
  expect(out.machine).toContain("去除锐边");
  expect(out.warnings).toEqual([]);
  for (const value of [
    "±0.010",
    "Ø0.530",
    "1/4-20 UNC",
    '9/16"',
    "3 mm",
    "AISI 304",
    "ISO 2768-mK",
    "LC-120-003",
    "drawing.pdf",
  ])
    expect(out.machine).toContain(value);
  const before = await db
    .prepare("SELECT count(*) AS n FROM translation_attempts")
    .first<{ n: number }>();
  expect((await json<PdfTranslationRow>(await generate(f.revision))).id).toBe(
    out.id,
  );
  expect(
    await db.prepare("SELECT count(*) AS n FROM translation_attempts").first(),
  ).toEqual(before);
  const lookup = await json<{ items: { translation: PdfTranslationRow }[] }>(
    await req(`revisions/${f.revision}/pdf-text`, payload()),
  );
  expect(lookup.items[0].translation.id).toBe(out.id);
  expect(
    new Uint8Array(await (await storage.get(f.key))!.arrayBuffer()),
  ).toEqual(f.bytes);
});
it("requires explicit consent, rejects ambiguous language, invalid geometry and pure dimensions before provider costs", async () => {
  const f = await drawing();
  expect(
    (await req(`revisions/${f.revision}/pdf-translate`, payload())).status,
  ).toBe(400);
  expect(
    (
      await generate(f.revision, {
        source_language: "auto",
        segments: [{ ...segment, text: "PLATE" }],
      })
    ).status,
  ).toBe(409);
  expect(
    (await generate(f.revision, { segments: [{ ...segment, text: "±0.010" }] }))
      .status,
  ).toBe(400);
  expect(
    (await generate(f.revision, { segments: [{ ...segment, x: 2 }] })).status,
  ).toBe(400);
  expect(
    (
      await generate(f.revision, {
        source_language: "en",
        target_language: "en",
      })
    ).status,
  ).toBe(400);
  expect(
    (await db
      .prepare("SELECT count(*) AS n FROM translation_attempts")
      .first<{ n: number }>())!.n,
  ).toBe(0);
});
it("keeps uncertain source available for an explicit override and supports en→fr and fr→en", async () => {
  const f = await drawing();
  const fr = await json<PdfTranslationRow>(
    await generate(f.revision, {
      target_language: "fr",
      segments: [{ ...segment, text: "REMOVE SHARP EDGES" }],
    }),
  );
  expect(fr.machine).toBe("ENLEVER LES ARÊTES");
  const en = await json<PdfTranslationRow>(
    await generate(f.revision, {
      target_language: "en",
      source_language: "fr",
      segments: [{ ...segment, text: "Enlever les arêtes" }],
    }),
  );
  expect(en.machine).toBe("REMOVE SHARP EDGES");
  expect(
    (await generate(f.revision, { segments: [{ ...segment, text: "PLATE" }] }))
      .status,
  ).toBe(201);
});
it("preserves verified corrections and machine originals, rejects changed engineering values and stale versions, and retains append-only history", async () => {
  const f = await drawing(),
    out = await json<PdfTranslationRow>(await generate(f.revision));
  const corrected = out.machine.replace("去除锐边", "清除锐边");
  const next = await json<PdfTranslationRow>(
    await req(`pdf-translations/${out.id}/corrections`, {
      body: corrected,
      version: 0,
      verify: true,
    }),
  );
  expect(next.body).toBe(corrected);
  expect(next.machine).toBe(out.machine);
  expect(next.status).toBe("verified");
  expect(
    (
      await req(`pdf-translations/${out.id}/corrections`, {
        body: corrected,
        version: 0,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await req(`pdf-translations/${out.id}/corrections`, {
        body: corrected.replace("±0.010", "±0.020"),
        version: 1,
        verify: true,
      })
    ).status,
  ).toBe(400);
  expect((await json<PdfTranslationRow>(await generate(f.revision))).body).toBe(
    corrected,
  );
  const history = await json<{ items: { id: string }[] }>(
    await req(`pdf-translations/${out.id}/history`),
  );
  expect(history.items).toHaveLength(1);
  await expect(
    db
      .prepare(
        "UPDATE pdf_translation_corrections SET body='overwrite' WHERE id=?",
      )
      .bind(history.items[0].id)
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare("DELETE FROM pdf_translation_corrections WHERE id=?")
      .bind(history.items[0].id)
      .run(),
  ).rejects.toThrow();
});
it("records proposals separately, applies only explicit approval and refuses duplicate decisions", async () => {
  const f = await drawing(),
    out = await json<PdfTranslationRow>(await generate(f.revision));
  const body = out.machine.replace("去除锐边", "建议去除锐边");
  const proposal = await json<PdfTranslationRow>(
    await req(`pdf-translations/${out.id}/corrections`, { body, version: 0 }),
  );
  expect(proposal.body).toBe(out.machine);
  expect(proposal.proposals).toHaveLength(1);
  const approve = { correction_id: proposal.proposals[0].id, approved: true };
  const approved = await json<PdfTranslationRow>(
    await req(`pdf-translations/${out.id}/reviews`, approve),
  );
  expect(approved.body).toBe(body);
  expect(approved.status).toBe("verified");
  expect(
    (await req(`pdf-translations/${out.id}/reviews`, approve)).status,
  ).toBe(409);
});
it("isolates revision/page/geometry fingerprints and saves only personal marker offsets", async () => {
  const f = await drawing(),
    out = await json<PdfTranslationRow>(await generate(f.revision));
  for (const extra of [
    { page: 2 },
    { segments: [{ ...segment, x: 0.2 }] },
    { segments: [{ ...segment, text: "GENERAL NOTES" }] },
  ]) {
    const found = await json<{ items: { translation: unknown }[] }>(
      await req(`revisions/${f.revision}/pdf-text`, payload(extra)),
    );
    expect(found.items[0].translation).toBeNull();
  }
  const f2 = await drawing();
  expect(
    (
      await json<{ items: { translation: unknown }[] }>(
        await req(`revisions/${f2.revision}/pdf-text`, payload()),
      )
    ).items[0].translation,
  ).toBeNull();
  await json(
    await req(`pdf-translations/${out.id}/position`, { dx: 0.1, dy: -0.1 }),
  );
  const lookup = await json<{
    items: { position: { dx: number; dy: number } }[];
  }>(await req(`revisions/${f.revision}/pdf-text`, payload()));
  expect(lookup.items[0].position).toEqual({ dx: 0.1, dy: -0.1 });
  expect(
    (await req(`pdf-translations/${out.id}/position`, { dx: 10, dy: 0 }))
      .status,
  ).toBe(400);
});
it("blocks anonymous and unrelated project access, direct history, corrections and cached text", async () => {
  const f = await drawing(),
    out = await json<PdfTranslationRow>(await generate(f.revision));
  expect(
    (
      await req(`revisions/${f.revision}/pdf-text`, payload(), undefined, {
        "Cf-Access-Jwt-Assertion": "",
      })
    ).status,
  ).toBe(401);
  const stranger = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO projects(id,organization_id,code,name) VALUES(?,?,?,?)",
    )
    .bind(stranger, org, "HIDDEN", "Other project")
    .run();
  // Remove the owner membership without changing source objects.
  await db
    .prepare("UPDATE organization_memberships SET active=0 WHERE user_id=?")
    .bind(admin)
    .run();
  expect(
    (await req(`revisions/${f.revision}/pdf-text`, payload())).status,
  ).toBeGreaterThanOrEqual(400);
  expect(
    (await req(`pdf-translations/${out.id}/history`)).status,
  ).toBeGreaterThanOrEqual(400);
});
it("reports provider errors, suppresses unsafe outputs and enforces persistent quotas without duplicate charges", async () => {
  const f = await drawing();
  expect(
    (
      await generate(f.revision, {
        segments: [{ ...segment, text: "REMOVE SHARP EDGES providererror" }],
      })
    ).status,
  ).toBe(502);
  const broken = await json<PdfTranslationRow>(
    await generate(f.revision, {
      segments: [{ ...segment, text: "REMOVE SHARP EDGES 3 mm brokentoken" }],
    }),
  );
  expect(broken.warnings.length).toBeGreaterThan(0);
  await db
    .prepare(
      "INSERT INTO translation_attempts(id,organization_id,actor_id,characters) SELECT ?,?,?,500000",
    )
    .bind(crypto.randomUUID(), org, admin)
    .run();
  expect(
    (
      await generate(f.revision, {
        segments: [{ ...segment, text: "GENERAL NOTES" }],
      })
    ).status,
  ).toBe(429);
});
it("handles concurrent requests with one durable result and a bounded conflict instead of a second bill", async () => {
  const f = await drawing(),
    responses = await Promise.all([generate(f.revision), generate(f.revision)]);
  const statuses = responses.map((r) => r.status);
  expect(statuses.some((s) => s < 300)).toBe(true);
  expect(statuses.every((s) => s < 300 || s === 409)).toBe(true);
  expect(
    (await db
      .prepare("SELECT count(*) AS n FROM pdf_translations")
      .first<{ n: number }>())!.n,
  ).toBe(1);
  expect(
    (await db
      .prepare("SELECT count(*) AS n FROM translation_attempts")
      .first<{ n: number }>())!.n,
  ).toBe(1);
});

async function jwt(email: string, subject = email) {
  return new SignJWT({ email, type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(issuer)
    .setAudience("library")
    .setSubject(subject)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime("30m")
    .sign(signer);
}
async function as(
  session: string,
  path: string,
  body?: unknown,
  method?: string,
) {
  return req(path, body, method, { "Cf-Access-Jwt-Assertion": session });
}
async function supplier(name: string) {
  const r = await json<{ id: string }>(
    await req("suppliers", {
      organization_id: org,
      name,
      country: "China",
      language: "zh-CN",
    }),
  );
  await json(await req(`projects/${project}/suppliers`, { supplier_id: r.id }));
  return r.id;
}
async function invite(
  email: string,
  role = "supplier_engineer",
  supplier_id: string | null = null,
  projects = [project],
) {
  return json<{ id: string; invitation_url: string; delivery: string }>(
    await req(`access/organizations/${org}/invitations`, {
      email,
      role,
      supplier_id,
      project_ids: projects,
    }),
  );
}
async function enroll(
  email: string,
  role = "supplier_engineer",
  supplier_id: string | null = null,
) {
  const i = await invite(email, role, supplier_id),
    session = await jwt(email);
  await json(
    await as(session, "access/invitations/accept", {
      token: new URL(i.invitation_url).hash.slice("#invitation=".length),
    }),
  );
  const me = await json<{ profile: { id: string } }>(await as(session, "me"));
  return { session, id: me.profile.id, invite: i };
}
async function grant(
  user: string,
  role: string,
  changes: Partial<Permissions> = {},
  active = true,
) {
  const members = await json<{ items: { user_id: string; version: number }[] }>(
    await req(`access/projects/${project}/members`),
  );
  const m = members.items.find((m) => m.user_id === user)!;
  await json(
    await req(
      `access/projects/${project}/members/${user}`,
      {
        role,
        active,
        permissions: { ...rolePermissions(role), ...changes },
        version: m.version,
      },
      "PATCH",
    ),
  );
}

it("isolates private glossary and official corrections from suppliers, enforces exact shared revisions and invalidates every direct route on withdrawal", async () => {
  const f = await drawing(),
    sp = await supplier("PDF supplier"),
    member = await enroll("pdf-supplier@example.test", "supplier_engineer", sp);
  await json(
    await req(
      `access/documents/${f.document}/sharing`,
      { shared: true, revision_ids: [f.revision] },
      "PATCH",
    ),
  );
  await json(
    await req(`organizations/${org}/glossary`, {
      fr: "Enlever les arêtes",
      en: "REMOVE SHARP EDGES",
      "zh-CN": "私有秘密术语",
      definition: "",
      domain: "",
      notes: "",
    }),
  );
  const internal = await json<PdfTranslationRow>(await generate(f.revision));
  expect(internal.machine).toContain("私有秘密术语");
  const shared = await json<PdfTranslationRow>(
    await as(
      member.session,
      `revisions/${f.revision}/pdf-translate`,
      payload({ consent: true, audience: "internal" }),
    ),
  );
  expect(shared.machine).toContain("去除锐边");
  expect(shared.machine).not.toContain("私有秘密术语");
  expect(
    (await as(member.session, `pdf-translations/${internal.id}/history`))
      .status,
  ).toBe(404);
  const rejection = await as(
    member.session,
    `pdf-translations/${shared.id}/corrections`,
    { body: shared.machine, version: 0, verify: true },
  );
  expect(rejection.status, await rejection.text()).toBe(404);
  const proposed = await json<PdfTranslationRow>(
    await as(member.session, `pdf-translations/${shared.id}/corrections`, {
      body: shared.machine.replace("去除锐边", "建议去除锐边"),
      version: 0,
    }),
  );
  expect(proposed.status).toBe("automatic");
  const approved = await json<PdfTranslationRow>(
    await req(`pdf-translations/${shared.id}/reviews`, {
      correction_id: proposed.proposals[0].id,
      approved: true,
    }),
  );
  expect(approved.status).toBe("verified");
  const other = await drawing();
  expect(
    (
      await as(
        member.session,
        `revisions/${other.revision}/pdf-text`,
        payload(),
      )
    ).status,
  ).toBe(404);
  await json(
    await req(
      `access/documents/${f.document}/sharing`,
      { shared: false, revision_ids: [] },
      "PATCH",
    ),
  );
  for (const [path, body] of [
    [`revisions/${f.revision}/pdf-text`, payload()],
    [`pdf-translations/${shared.id}/history`, undefined],
    [
      `pdf-translations/${shared.id}/corrections`,
      { body: shared.machine, version: 1 },
    ],
    [`pdf-translations/${shared.id}/position`, { dx: 0, dy: 0 }],
  ] as const)
    expect((await as(member.session, path, body)).status).toBe(404);
});
it("withdraws translation permission independently of PDF viewing and keeps reader corrections forbidden", async () => {
  const f = await drawing(),
    reader = await enroll("pdf-reader@example.test", "reviewer");
  await json(
    await req(
      `access/documents/${f.document}/sharing`,
      { shared: true, revision_ids: [f.revision] },
      "PATCH",
    ),
  );
  const out = await json<PdfTranslationRow>(
    await as(
      reader.session,
      `revisions/${f.revision}/pdf-translate`,
      payload({ consent: true }),
    ),
  );
  expect(
    (
      await as(reader.session, `pdf-translations/${out.id}/corrections`, {
        body: out.machine,
        version: 0,
      })
    ).status,
  ).toBe(404);
  await grant(reader.id, "reviewer", { translate: false });
  expect(
    (await as(reader.session, `revisions/${f.revision}/pdf-text`, payload()))
      .status,
  ).toBe(404);
  expect(
    (await as(reader.session, `pdf-translations/${out.id}/history`)).status,
  ).toBe(404);
});
it("reuses approved wording on a new revision without another provider charge, with new geometry and mandatory review of the new context", async () => {
  const f = await drawing(),
    out = await json<PdfTranslationRow>(await generate(f.revision));
  const reviewed = out.machine.replace("去除锐边", "清除锐边");
  await json(
    await req(`pdf-translations/${out.id}/corrections`, {
      body: reviewed,
      version: 0,
      verify: true,
    }),
  );
  const next = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO document_revisions(id,document_id,ordinal,label,filename,extension,content_type,size,sha256,object_key,created_by) VALUES(?,?,2,'B','new.pdf','pdf','application/pdf',? ,?,?,?)",
    )
    .bind(
      next,
      f.document,
      f.bytes.length,
      "b".repeat(64),
      `next/${next}`,
      admin,
    )
    .run();
  const before = await db
    .prepare("SELECT count(*) AS n FROM translation_attempts")
    .first();
  const reused = await json<PdfTranslationRow>(
    await generate(next, {
      source_language: "auto",
      segments: [{ ...segment, x: 0.4 }],
    }),
  );
  expect(reused.body).toBe(reviewed);
  expect(reused.status).toBe("automatic");
  expect(reused.reused_from).toBe(out.id);
  expect(reused.segment_id).not.toBe(out.segment_id);
  expect(
    await db.prepare("SELECT count(*) AS n FROM translation_attempts").first(),
  ).toEqual(before);
  expect(
    (
      await json<{ items: { translation: PdfTranslationRow }[] }>(
        await req(
          `revisions/${next}/pdf-text`,
          payload({ segments: [{ ...segment, x: 0.4 }] }),
        ),
      )
    ).items[0].translation.id,
  ).toBe(reused.id);
});
it("invalidates machine cache after glossary changes but never silently replaces a verified manual correction", async () => {
  const f = await drawing(),
    one = { ...segment, text: "MATERIAL" },
    extra = { segments: [one] };
  const original = await json<PdfTranslationRow>(
    await generate(f.revision, extra),
  );
  await json(
    await req(`organizations/${org}/glossary`, {
      fr: "Matière",
      en: "MATERIAL",
      "zh-CN": "优选材料",
    }),
  );
  let found = await json<{
    items: { translation: PdfTranslationRow | null }[];
  }>(await req(`revisions/${f.revision}/pdf-text`, payload(extra)));
  expect(found.items[0].translation).toBeNull();
  const changed = await json<PdfTranslationRow>(
    await generate(f.revision, extra),
  );
  expect(changed.id).not.toBe(original.id);
  expect(changed.body).toBe("优选材料");
  await json(
    await req(`pdf-translations/${original.id}/corrections`, {
      body: "人工审核材料",
      version: 0,
      verify: true,
    }),
  );
  found = await json(
    await req(`revisions/${f.revision}/pdf-text`, payload(extra)),
  );
  expect(found.items[0].translation?.body).toBe("人工审核材料");
  expect(
    (await json<PdfTranslationRow>(await generate(f.revision, extra))).body,
  ).toBe("人工审核材料");
});
it("shares a cache between confident automatic detection and the equivalent manual source without paying twice", async () => {
  const f = await drawing(),
    auto = await json<PdfTranslationRow>(
      await generate(f.revision, { source_language: "auto" }),
    );
  const manual = await json<PdfTranslationRow>(await generate(f.revision));
  expect(manual.id).toBe(auto.id);
  expect(
    (await db
      .prepare("SELECT count(*) AS n FROM translation_attempts")
      .first<{ n: number }>())!.n,
  ).toBe(1);
});
