import {
  rolePermissions,
  type Permissions,
} from "../packages/shared/src/access";
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
      contents: `import {DeepLFreeProvider} from './apps/api/src/translation/provider';import {simulatedDeepLFetch} from './tests/helpers/translation-provider';import {createApp} from './apps/api/src/index';import {AccessIdentityProvider} from './apps/api/src/identity';import {createLocalJWKSet} from 'jose';const app=createApp(new AccessIdentityProvider(createLocalJWKSet({keys:[${JSON.stringify({ ...jwk, kid: "test", alg: "RS256" })}]})),fetch,env=>new DeepLFreeProvider(env.DEEPL_API_KEY,simulatedDeepLFetch),async(input,init)=>{if(String(input)!=="https://api.resend.com/emails")throw new Error("Unexpected test mail destination");const payload=JSON.parse(String(init.body));return new Response(JSON.stringify({id:"simulated-not-sent"}),{status:payload.to[0].startsWith("mail-ok")?200:503,headers:{"Content-Type":"application/json"}});});export default {async fetch(request,env,ctx){let queries=0;const DB=new Proxy(env.DB,{get(raw,name){const value=Reflect.get(raw,name);if(name==='prepare')return(...args)=>{queries++;return raw.prepare(...args);};return typeof value==='function'?value.bind(raw):value;}});const res=await app.fetch(request,{...env,DB},ctx);const headers=new Headers(res.headers);headers.set('X-Test-D1-Statements',String(queries));return new Response(res.body,{status:res.status,headers});}};`,
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
        MULTIUSER_ENABLED: "true",
        TRANSLATION_ENABLED: "true",
        DEEPL_API_KEY: "test-only:fx",
        ...overrides,
      },
    }),
  );
}
beforeEach(async () => {
  persistence = await mkdtemp(join(tmpdir(), "forgebridge-access-test-"));
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
async function drawing() {
  const document = crypto.randomUUID(),
    revision = crypto.randomUUID(),
    key = `non-confidential/${revision}`;
  const bytes = new TextEncoder().encode(
    "%PDF-1.7\nisolated security fixture\n%%EOF",
  );
  await storage.put(key, bytes);
  await db
    .prepare("INSERT INTO documents(id,project_id,name,number) VALUES(?,?,?,?)")
    .bind(document, project, "Internal industrial test drawing", "SEC-001")
    .run();
  await db
    .prepare(
      "INSERT INTO document_revisions(id,document_id,ordinal,label,filename,extension,content_type,size,sha256,object_key,created_by) VALUES(?,?,1,'B','test.pdf','pdf','application/pdf',?,?,?,?)",
    )
    .bind(revision, document, bytes.length, "a".repeat(64), key, admin)
    .run();
  return { document, revision, key, bytes };
}
async function share(
  f: Awaited<ReturnType<typeof drawing>>,
  shared = true,
  revisions = [f.revision],
) {
  return json(
    await req(
      `access/documents/${f.document}/sharing`,
      { shared, revision_ids: revisions },
      "PATCH",
    ),
  );
}
async function conversation(shared = false) {
  const c = await json<{ id: string }>(
    await req(`projects/${project}/conversations`, {
      title: shared ? "Shared test" : "Internal test",
    }),
  );
  if (shared)
    await json(
      await req(
        `access/conversations/${c.id}/sharing`,
        { shared: true },
        "PATCH",
      ),
    );
  return c.id;
}
async function send(conv: string, body: string, shared = true) {
  const id = crypto.randomUUID();
  await json(await req(`conversations/${conv}/messages`, { id, body, shared }));
  return id;
}
async function point(revision: string, published = true) {
  const id = crypto.randomUUID();
  await json(
    await req(`revisions/${revision}/review-items`, {
      id,
      page: 1,
      type: "discussion",
      title: published ? "Published test point" : "Confidential draft",
      summary: "Non confidential 3 mm",
      geometry: { points: [] },
    }),
  );
  if (published)
    await json(
      await req(
        `review-items/${id}`,
        { version: 1, publication: "published" },
        "PATCH",
      ),
    );
  return id;
}
it("retains the configured signed administrator and denies anonymous, forged, uninvited identities and public bootstrap", async () => {
  expect(
    (await req("me", undefined, "GET", { "Cf-Access-Jwt-Assertion": "" }))
      .status,
  ).toBe(401);
  expect((await as(await jwt("unknown@example.test"), "me")).status).toBe(403);
  expect(
    (
      await req("me", undefined, "GET", {
        "Cf-Access-Jwt-Assertion": token.slice(0, -5) + "abcde",
      })
    ).status,
  ).toBe(401);
  const me = await json<{ profile: { id: string }; is_primary_admin: boolean }>(
    await req("me"),
  );
  expect(me.profile.id).toBe(admin);
  expect(me.is_primary_admin).toBe(true);
  expect(await db.prepare("SELECT count(*) n FROM profiles").first("n")).toBe(
    1,
  );
});
it("uses hashed email-bound expiring invitations and accepts exactly once without exposing stored tokens", async () => {
  const sp = await supplier("Supplier A"),
    i = await invite("supplier-a@example.test", "supplier_engineer", sp),
    session = await jwt("supplier-a@example.test");
  expect(i.delivery).toBe("not_configured");
  const secret = new URL(i.invitation_url).hash.slice(12);
  const row = await db
    .prepare("SELECT token_hash FROM access_invitations WHERE id=?")
    .bind(i.id)
    .first<{ token_hash: string }>();
  expect(row!.token_hash).toHaveLength(64);
  expect(row!.token_hash).not.toBe(secret);
  expect(
    await (await req(`access/organizations/${org}/invitations`)).text(),
  ).not.toContain(secret);
  const results = await Promise.all([
    as(session, "access/invitations/accept", { token: secret }),
    as(session, "access/invitations/accept", { token: secret }),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(
    (await as(session, "access/invitations/accept", { token: secret })).status,
  ).toBe(404);
  expect(
    await db
      .prepare(
        "SELECT count(*) n FROM security_events WHERE action='invitation.accepted'",
      )
      .first("n"),
  ).toBe(1);
  const projects = await json<{ id: string }[]>(
    await as(session, "collaboration/projects"),
  );
  expect(projects.map((p) => p.id)).toEqual([project]);
});
it("refuses expired, revoked, wrong-email and historical private-mode invitation tokens", async () => {
  const sp = await supplier("Supplier A"),
    a = await invite("a@example.test", "supplier_engineer", sp),
    b = await invite("b@example.test", "supplier_engineer", sp),
    ta = await jwt("a@example.test"),
    tb = await jwt("b@example.test");
  await json(await as(ta, "me"));
  await json(await as(tb, "me"));
  expect(
    (
      await as(tb, "access/invitations/accept", {
        token: new URL(a.invitation_url).hash.slice(12),
      })
    ).status,
  ).toBe(404);
  await db
    .prepare("UPDATE access_invitations SET expires_at='2000-01-01' WHERE id=?")
    .bind(a.id)
    .run();
  expect(
    (
      await as(ta, "access/invitations/accept", {
        token: new URL(a.invitation_url).hash.slice(12),
      })
    ).status,
  ).toBe(404);
  await json(await req(`access/invitations/${b.id}`, {}, "DELETE"));
  expect(
    (
      await as(tb, "access/invitations/accept", {
        token: new URL(b.invitation_url).hash.slice(12),
      })
    ).status,
  ).toBe(404);
  expect(
    (await as(tb, "invitations/accept", { token: "legacy-token" })).status,
  ).toBe(404);
});
it("isolates projects and organizations, search/statistics and blocks every unreviewed legacy API for suppliers", async () => {
  const a = await enroll(
      "a@example.test",
      "supplier_engineer",
      await supplier("A"),
    ),
    other = await json<{ id: string }>(
      await req("projects", {
        organization_id: org,
        code: "OTHER",
        name: "Secret other project",
      }),
    );
  const f = await drawing();
  for (const p of [
    `collaboration/projects/${other.id}/documents`,
    `collaboration/projects/${other.id}/summary`,
    `projects/${project}/documents`,
    `projects/${project}/approval-summary`,
    `projects/${project}/message-search?q=Secret`,
    "suppliers?organization_id=" + org,
    "audit_events?organization_id=" + org,
  ])
    expect((await as(a.session, p)).status, p).toBe(404);
  const foreign = crypto.randomUUID(),
    owner = crypto.randomUUID(),
    proj = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO profiles(id,email,name) VALUES(?,'foreign@example.test','Other admin')",
    )
    .bind(owner)
    .run();
  await db
    .prepare(
      "INSERT INTO organizations(id,name) VALUES(?,'Other organization')",
    )
    .bind(foreign)
    .run();
  await db
    .prepare(
      "INSERT INTO organization_memberships(organization_id,user_id,role) VALUES(?,?,'owner')",
    )
    .bind(foreign, owner)
    .run();
  await db
    .prepare(
      "INSERT INTO projects(id,organization_id,code,name) VALUES(?,?,'FOREIGN','Private foreign')",
    )
    .bind(proj, foreign)
    .run();
  expect(
    (await as(a.session, `collaboration/projects/${proj}/summary`)).status,
  ).toBe(404);
  expect((await req(`projects/${proj}/documents`)).status).toBe(404);
  expect(
    (await as(a.session, `collaboration/revisions/${f.revision}/content`))
      .status,
  ).toBe(404);
});
it("shares exact document revisions, protects new revisions and old direct R2 URLs after withdrawal or revocation", async () => {
  const a = await enroll(
      "a@example.test",
      "supplier_engineer",
      await supplier("A"),
    ),
    f = await drawing();
  expect(
    (await as(a.session, `collaboration/documents/${f.document}`)).status,
  ).toBe(404);
  await share(f);
  const content = await as(
    a.session,
    `collaboration/revisions/${f.revision}/content`,
  );
  expect(content.headers.get("Content-Security-Policy")).toBe(
    "default-src 'none'; sandbox",
  );
  expect(content.headers.get("Cache-Control")).toBe("private, no-store");
  expect(new Uint8Array(await content.arrayBuffer())).toEqual(f.bytes);
  const revision = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO document_revisions(id,document_id,ordinal,label,filename,extension,content_type,size,sha256,object_key,created_by) SELECT ?,document_id,2,'C',filename,extension,content_type,size,sha256,?,created_by FROM document_revisions WHERE id=?",
    )
    .bind(revision, "new-private-key", f.revision)
    .run();
  const detail = await json<{ revisions: { id: string }[] }>(
    await as(a.session, `collaboration/documents/${f.document}`),
  );
  expect(detail.revisions.map((r) => r.id)).toEqual([f.revision]);
  expect(
    (await as(a.session, `collaboration/revisions/${revision}`)).status,
  ).toBe(404);
  const list = await json<{ items: { id: string; revision_id: string }[] }>(
    await as(a.session, `collaboration/projects/${project}/documents?q=SEC`),
  );
  expect(list.items[0]).toMatchObject({
    id: f.document,
    revision_id: f.revision,
  });
  await share(f, false);
  expect(
    (await as(a.session, `collaboration/revisions/${f.revision}/content`))
      .status,
  ).toBe(404);
  await share(f);
  await grant(a.id, "supplier_engineer", {}, false);
  expect(
    (await as(a.session, `collaboration/revisions/${f.revision}/content`))
      .status,
  ).toBe(404);
  expect(
    new Uint8Array(await (await storage.get(f.key))!.arrayBuffer()),
  ).toEqual(f.bytes);
});
it("hides draft points, unlinked drawings, internal conversations/messages/references and their attachments", async () => {
  const a = await enroll(
      "a@example.test",
      "supplier_engineer",
      await supplier("A"),
    ),
    f = await drawing();
  await share(f);
  const pub = await point(f.revision),
    draft = await point(f.revision, false);
  const points = await json<{ items: { id: string }[] }>(
    await as(a.session, `collaboration/revisions/${f.revision}/points`),
  );
  expect(points.items.map((p) => p.id)).toEqual([pub]);
  expect(
    (
      await as(a.session, `review-items/${draft}/messages`, {
        id: crypto.randomUUID(),
        body: "Attempt",
      })
    ).status,
  ).toBe(404);
  const internal = await conversation(),
    shared = await conversation(true),
    hidden = await send(shared, "Internal private note", false);
  await send(shared, "Shared decision");
  expect(
    (await as(a.session, `collaboration/conversations/${internal}/messages`))
      .status,
  ).toBe(404);
  const rows = await json<{ items: { id: string }[] }>(
    await as(a.session, `collaboration/conversations/${shared}/messages`),
  );
  expect(rows.items.map((m) => m.id)).not.toContain(hidden);
  const file = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO message_attachments(id,conversation_id,message_id,author_id,filename,size,extension,content_type,sha256,object_key,state,expires_at) VALUES(?,?,?,?,'private.txt',1,'txt','text/plain',?,'private-attachment','attached','2099-01-01')",
    )
    .bind(file, shared, hidden, admin, "a".repeat(64))
    .run();
  expect(
    (await as(a.session, `collaboration/attachments/${file}/content`)).status,
  ).toBe(404);
  expect(
    (await as(a.session, `message-attachments/${file}/content`)).status,
  ).toBe(404);
  expect((await as(a.session, "collaboration/unknown-statistics")).status).toBe(
    404,
  );
});
it("enforces reader and customized permissions on API writes, then permits only explicitly granted actions", async () => {
  const reader = await enroll("reader@example.test", "reviewer"),
    internal = await enroll("internal@example.test", "designer"),
    a = await enroll(
      "a@example.test",
      "supplier_engineer",
      await supplier("A"),
    ),
    f = await drawing();
  await share(f);
  const p = await point(f.revision),
    c = await conversation(true);
  for (const actor of [reader]) {
    expect(
      (
        await as(actor.session, `review-items/${p}/messages`, {
          id: crypto.randomUUID(),
          body: "Forbidden",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await as(actor.session, `conversations/${c}/messages`, {
          id: crypto.randomUUID(),
          body: "Forbidden",
          shared: true,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await as(actor.session, `projects/${project}/uploads`, {
          name: "Forbidden",
        })
      ).status,
    ).toBe(404);
  }
  await json(
    await as(a.session, `review-items/${p}/messages`, {
      id: crypto.randomUUID(),
      body: "Supplier reply",
    }),
  );
  await json(
    await as(internal.session, `conversations/${c}/messages`, {
      id: crypto.randomUUID(),
      body: "Internal participant",
      shared: true,
    }),
  );
  expect(
    (
      await as(
        a.session,
        `access/projects/${project}/members/${a.id}`,
        {
          role: "project_admin",
          active: true,
          permissions: rolePermissions("project_admin"),
          version: 1,
        },
        "PATCH",
      )
    ).status,
  ).toBe(404);
  await grant(a.id, "supplier_engineer", {
    reply_points: false,
    participate_conversations: false,
    download_documents: false,
  });
  expect(
    (
      await as(a.session, `review-items/${p}/messages`, {
        id: crypto.randomUUID(),
        body: "No longer allowed",
      })
    ).status,
  ).toBe(404);
  expect(
    (await as(a.session, `collaboration/revisions/${f.revision}/content`))
      .status,
  ).toBe(404);
  await grant(reader.id, "reviewer", { approve: true, add_documents: true });
  const saved = await db
    .prepare("SELECT permissions FROM project_memberships WHERE user_id=?")
    .bind(reader.id)
    .first<string>("permissions");
  expect(JSON.parse(saved!).approve).toBe(false);
});
it("requires explicit approver assignment, sharing, permission and confirmation; stamps the verified actor without altering historical decisions", async () => {
  const a = await enroll(
      "a@example.test",
      "supplier_engineer",
      await supplier("A"),
    ),
    b = await enroll(
      "b@example.test",
      "supplier_engineer",
      await supplier("B"),
    ),
    f = await drawing();
  await share(f);
  const id = crypto.randomUUID();
  await json(
    await req("approvals", {
      id,
      revision_id: f.revision,
      title: "Exact B approval",
    }),
  );

  expect(
    (
      await as(a.session, `approvals/${id}/actions`, {
        action: "approve",
        version: 2,
        confirmed: true,
      })
    ).status,
  ).toBe(404);
  await grant(a.id, "supplier_engineer", {
    approve: true,
    view_approvals: true,
  });
  await json(
    await req(
      `access/approvals/${id}/sharing`,
      { shared: true, approver_id: a.id },
      "PATCH",
    ),
  );
  await json(
    await req(`approvals/${id}/actions`, { action: "submit", version: 1 }),
  );
  expect(
    (
      await as(b.session, `approvals/${id}/actions`, {
        action: "approve",
        version: 2,
        confirmed: true,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await as(a.session, `approvals/${id}/actions`, {
        action: "approve",
        version: 2,
      })
    ).status,
  ).toBe(404);
  await json(
    await as(a.session, `approvals/${id}/actions`, {
      action: "approve",
      version: 2,
      confirmed: true,
      decided_by: b.id,
    }),
  );
  const decision = await db
    .prepare(
      "SELECT decided_by,decision_identity FROM approval_requests WHERE id=?",
    )
    .bind(id)
    .first<{ decided_by: string; decision_identity: string }>();
  expect(decision!.decided_by).toBe(a.id);
  expect(JSON.parse(decision!.decision_identity).subject).toBe(
    "a@example.test",
  );
  expect(
    (
      await as(a.session, `approvals/${id}/actions`, {
        action: "reject",
        version: 3,
        confirmed: true,
        comment: "Overwrite",
      })
    ).status,
  ).toBe(409);
});
it("revokes a session immediately on logout or administrator invalidation and preserves signed content history", async () => {
  const a = await enroll(
    "a@example.test",
    "supplier_engineer",
    await supplier("A"),
  );
  await json(await as(a.session, "access/logout", {}));
  expect((await as(a.session, "me")).status).toBe(401);
  const fresh = await jwt("a@example.test");
  expect((await as(fresh, "me")).status).toBe(200);
  await json(
    await req(`access/organizations/${org}/revoke-sessions/${a.id}`, {}),
  );
  expect((await as(fresh, "me")).status).toBe(401);
  expect(
    await db
      .prepare(
        "SELECT count(*) n FROM security_events WHERE action='session.logout'",
      )
      .first("n"),
  ).toBe(1);
  await expect(db.prepare("DELETE FROM security_events").run()).rejects.toThrow(
    /append-only/,
  );
  expect((await req("me")).status).toBe(200);
});
it("invalidates pending invitation grants when permissions change and rotates resend tokens without representing an email as sent", async () => {
  const sp = await supplier("A"),
    a = await enroll("a@example.test", "supplier_engineer", sp),
    pending = await invite("a@example.test", "supplier_engineer", sp);
  await grant(a.id, "supplier_engineer", { reply_points: false });
  expect(
    (
      await as(a.session, "access/invitations/accept", {
        token: new URL(pending.invitation_url).hash.slice(12),
      })
    ).status,
  ).toBe(404);
  const resend = await invite("new@example.test", "supplier_engineer", sp);
  const rotated = await json<{ invitation_url: string; delivery: string }>(
    await req(`access/invitations/${resend.id}/resend`, {}),
  );
  expect(rotated.delivery).toBe("not_configured");
  const session = await jwt("new@example.test");
  expect(
    (
      await as(session, "access/invitations/accept", {
        token: new URL(resend.invitation_url).hash.slice(12),
      })
    ).status,
  ).toBe(404);
  await json(
    await as(session, "access/invitations/accept", {
      token: new URL(rotated.invitation_url).hash.slice(12),
    }),
  );
});
it("supports explicitly granted supplier drawing and document submission with preserved authors and originals", async () => {
  const a = await enroll(
      "a@example.test",
      "supplier_engineer",
      await supplier("A"),
    ),
    f = await drawing();
  await share(f);
  const p = await point(f.revision);
  await grant(a.id, "supplier_engineer", {
    annotate: true,
    add_documents: true,
    add_revisions: true,
  });
  const id = crypto.randomUUID();
  await json(
    await as(a.session, `revisions/${f.revision}/annotations`, {
      id,
      page: 1,
      type: "marker",
      color: "blue",
      geometry: { points: [[0.4, 0.4]] },
      point_id: p,
    }),
  );
  expect(
    await db
      .prepare("SELECT created_by FROM graphical_annotations WHERE id=?")
      .bind(id)
      .first("created_by"),
  ).toBe(a.id);
  const annotations = await json<{
    items: { id: string; geometry: unknown }[];
  }>(
    await as(
      a.session,
      `collaboration/revisions/${f.revision}/annotations?page_number=1`,
    ),
  );
  expect(annotations.items[0].geometry).toEqual({ points: [[0.4, 0.4]] });
  const other = await drawing();
  await share(other);
  expect(
    (
      await as(a.session, `revisions/${f.revision}/annotations`, {
        id: crypto.randomUUID(),
        page: 1,
        type: "marker",
        geometry: { points: [[0.2, 0.2]] },
        point_id: await point(other.revision),
      })
    ).status,
  ).toBe(404);
  const bytes = new TextEncoder().encode(
      "%PDF-1.7\nisolated submitted document\n%%EOF",
    ),
    sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString(
      "hex",
    );
  const upload = await json<{ id: string }>(
    await as(a.session, `projects/${project}/uploads`, {
      name: "Supplier submission",
      label: "A",
      filename: "supplier.pdf",
      size: bytes.length,
      sha256,
    }),
  );
  const sent = await runtime.dispatchFetch(
    `${origin}/api/v1/uploads/${upload.id}/content`,
    {
      method: "PUT",
      headers: {
        Origin: origin,
        "Cf-Access-Jwt-Assertion": a.session,
        "Content-Length": String(bytes.length),
      },
      body: bytes,
    },
  );
  expect(sent.status).toBeLessThan(300);
  const saved = await json<{ id: string; revision_id: string }>(
    await as(a.session, `uploads/${upload.id}/complete`, {}),
  );
  expect(
    await db
      .prepare("SELECT created_by FROM document_revisions WHERE id=?")
      .bind(saved.revision_id)
      .first("created_by"),
  ).toBe(a.id);
  expect(
    (
      await as(
        a.session,
        `collaboration/revisions/${saved.revision_id}/content`,
      )
    ).status,
  ).toBe(404);
  expect(
    new Uint8Array(await (await storage.get(f.key))!.arrayBuffer()),
  ).toEqual(f.bytes);
});
it("keeps legacy project memberships disabled until an explicit reviewed grant and restores permission state after restart", async () => {
  const a = await enroll(
      "a@example.test",
      "supplier_engineer",
      await supplier("A"),
    ),
    other = await json<{ id: string }>(
      await req("projects", {
        organization_id: org,
        code: "LEGACY",
        name: "Unreviewed legacy",
      }),
    );
  await db
    .prepare(
      "INSERT INTO project_memberships(organization_id,project_id,user_id,role) VALUES(?,?,?,'reviewer')",
    )
    .bind(org, other.id, a.id)
    .run();
  expect(
    (await as(a.session, `collaboration/projects/${other.id}/summary`)).status,
  ).toBe(404);
  await runtime.dispose();
  runtime = makeRuntime();
  db = (await runtime.getD1Database("DB")) as unknown as D1Database;
  const projects = await json<{ id: string }[]>(
    await as(a.session, "collaboration/projects"),
  );
  expect(projects.map((p) => p.id)).toEqual([project]);
});
it("validates a configured mail transport using a deterministic test-only response and reports errors without sending real email", async () => {
  await runtime.dispose();
  runtime = makeRuntime({
    RESEND_API_KEY: "simulated-test-key",
    INVITATION_FROM: "test@example.test",
  });
  db = (await runtime.getD1Database("DB")) as unknown as D1Database;
  const ok = await invite("mail-ok@example.test", "reviewer"),
    failed = await invite("mail-failure@example.test", "reviewer");
  expect(ok.delivery).toBe("sent");
  expect(ok.invitation_url).toBeUndefined();
  expect(failed.delivery).toBe("failed");
  expect(failed.invitation_url).toBeTruthy();
});
it("never exposes cached translations or corrections after source visibility is withdrawn", async () => {
  const a = await enroll(
      "a@example.test",
      "supplier_engineer",
      await supplier("A"),
    ),
    f = await drawing();
  await share(f);
  const id = await point(f.revision);
  const generated = await json<{ id: string }>(
    await as(a.session, "translations", {
      kind: "review_item",
      id,
      field: "summary",
      source_language: "fr",
      target_language: "en",
    }),
  );
  await json(
    await as(
      a.session,
      `translations/${generated.id}`,
      { body: "Corrected 3 mm", version: 0 },
      "PATCH",
    ),
  );
  await share(f, false);
  expect(
    (
      await as(
        a.session,
        `translations/${generated.id}`,
        { body: "Blocked 3 mm", version: 1 },
        "PATCH",
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await as(a.session, "translations", {
        kind: "review_item",
        id,
        field: "summary",
        target_language: "en",
      })
    ).status,
  ).toBe(404);
  expect(
    (await as(a.session, "access/organizations/" + org + "/events")).status,
  ).toBe(404);
  const reader = await enroll("reader@example.test", "reviewer");
  expect(
    (await as(reader.session, `collaboration/documents/${f.document}`)).status,
  ).toBe(404);
  expect(
    (
      await as(
        a.session,
        "access/organizations/" + org + "/revoke-sessions/" + admin,
        {},
      )
    ).status,
  ).toBe(404);
});
it("requires valid administrator configuration even for invited sessions and keeps request assignment within authorized shared sources", async () => {
  const a = await enroll(
      "a@example.test",
      "supplier_engineer",
      await supplier("A"),
    ),
    b = await enroll(
      "b@example.test",
      "supplier_engineer",
      await supplier("B"),
    ),
    conv = await conversation(true),
    m = await send(conv, "Assignable shared request"),
    request = await json<{ id: string }>(
      await req(`messages/${m}/requests`, {
        title: "Shared request",
        description: "Non confidential",
      }),
    );
  await json(
    await req(
      `access/requests/${request.id}/assignee`,
      { assignee_id: a.id },
      "PATCH",
    ),
  );
  const list = await json<{ items: { id: string }[] }>(
    await as(a.session, `collaboration/projects/${project}/requests`),
  );
  expect(list.items.map((r) => r.id)).toContain(request.id);
  expect(
    (
      await json<{ items: unknown[] }>(
        await as(b.session, `collaboration/projects/${project}/requests`),
      )
    ).items,
  ).toHaveLength(0);
  const internal = await conversation(),
    secret = await send(internal, "Internal request"),
    privateRequest = await json<{ id: string }>(
      await req(`messages/${secret}/requests`, { title: "Private request" }),
    );
  expect(
    (
      await req(
        `access/requests/${privateRequest.id}/assignee`,
        { assignee_id: a.id },
        "PATCH",
      )
    ).status,
  ).toBe(404);
  await runtime.dispose();
  runtime = makeRuntime({ ADMIN_EMAIL: "" });
  db = (await runtime.getD1Database("DB")) as unknown as D1Database;
  expect((await as(a.session, "me")).status).toBe(503);
});
it("keeps the original administrator workspace usable on the phase-6 schema when multiuser activation is off", async () => {
  await runtime.dispose();
  const old = persistence;
  persistence = await mkdtemp(join(tmpdir(), "forgebridge-phase6-compat-"));
  await rm(old, { recursive: true, force: true });
  runtime = makeRuntime({ MULTIUSER_ENABLED: "false" });
  db = (await runtime.getD1Database("DB")) as unknown as D1Database;
  storage = (await runtime.getR2Bucket("DOCUMENTS")) as unknown as R2Bucket;
  await migrate(db, { through: "0008_integrated_translations.sql" });
  expect((await req("me")).status).toBe(200);
  org = (
    await json<{ id: string }>(
      await req("organizations", { name: "Preserved phase 6" }),
    )
  ).id;
  project = (
    await json<{ id: string }>(
      await req("projects", {
        organization_id: org,
        code: "COMPAT",
        name: "Pre-migration workspace",
      }),
    )
  ).id;
  const f = await drawing();
  expect((await req(`revisions/${f.revision}/content`)).status).toBe(200);
  const id = crypto.randomUUID();
  await json(
    await req("approvals", {
      id,
      revision_id: f.revision,
      title: "Pre-migration decision",
    }),
  );
  await json(
    await req(`approvals/${id}/actions`, { action: "submit", version: 1 }),
  );
  await json(
    await req(`approvals/${id}/actions`, { action: "approve", version: 2 }),
  );
  expect(
    await db
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE name='access_invitations'",
      )
      .first("n"),
  ).toBe(0);
  expect(
    (await json<{ logout_url: string }>(await req("access/logout", {})))
      .logout_url,
  ).toBe("/cdn-cgi/access/logout");
  expect((await as(await jwt("unknown@example.test"), "me")).status).toBe(403);
});
it("rechecks resource visibility for idempotent legacy writes and uploads after a member becomes external or sharing is withdrawn", async () => {
  const sp = await supplier("A"),
    a = await enroll("a@example.test", "designer"),
    f = await drawing();
  await share(f);
  const pub = await point(f.revision),
    draft = crypto.randomUUID(),
    annotation = crypto.randomUUID(),
    conv = await conversation(true),
    privateMessage = crypto.randomUUID();
  await json(
    await as(a.session, `revisions/${f.revision}/review-items`, {
      id: draft,
      page: 1,
      type: "discussion",
      title: "Old internal draft",
      summary: "Secret internal text",
      geometry: { points: [] },
    }),
  );
  await json(
    await as(a.session, `revisions/${f.revision}/annotations`, {
      id: annotation,
      page: 1,
      type: "marker",
      geometry: { points: [[0.2, 0.2]] },
      content: "Internal drawing",
    }),
  );
  await json(
    await as(a.session, `conversations/${conv}/messages`, {
      id: privateMessage,
      body: "Old internal message",
      shared: false,
    }),
  );
  const next = await invite("a@example.test", "supplier_engineer", sp);
  await json(
    await as(a.session, "access/invitations/accept", {
      token: new URL(next.invitation_url).hash.slice(12),
    }),
  );
  await grant(a.id, "supplier_engineer", {
    annotate: true,
    create_points: true,
    add_revisions: true,
  });
  expect(
    (
      await as(a.session, `revisions/${f.revision}/review-items`, {
        id: draft,
        page: 1,
        type: "discussion",
        title: "Retry",
        geometry: { points: [] },
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await as(a.session, `revisions/${f.revision}/annotations`, {
        id: annotation,
        page: 1,
        type: "marker",
        point_id: pub,
        geometry: { points: [[0.2, 0.2]] },
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await as(a.session, `conversations/${conv}/messages`, {
        id: privateMessage,
        body: "Old internal message",
        shared: true,
      })
    ).status,
  ).toBe(404);
  const bytes = new TextEncoder().encode(
      "%PDF-1.7\nnon confidential pending revision\n%%EOF",
    ),
    sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString(
      "hex",
    );
  const u = await json<{ id: string }>(
    await as(a.session, `projects/${project}/uploads`, {
      document_id: f.document,
      name: "Pending proposal",
      label: "C",
      filename: "pending.pdf",
      size: bytes.length,
      sha256,
    }),
  );
  await share(f, false);
  const r = await runtime.dispatchFetch(
    `${origin}/api/v1/uploads/${u.id}/content`,
    {
      method: "PUT",
      headers: {
        Origin: origin,
        "Cf-Access-Jwt-Assertion": a.session,
        "Content-Length": String(bytes.length),
      },
      body: bytes,
    },
  );
  expect(r.status).toBe(404);
  expect((await as(a.session, `uploads/${u.id}/complete`, {})).status).toBe(
    404,
  );
  expect(
    new Uint8Array(await (await storage.get(f.key))!.arrayBuffer()),
  ).toEqual(f.bytes);
});
it("does not give the primary administrator owner privileges in another organization where they were invited as a supplier", async () => {
  const owner = crypto.randomUUID(),
    foreign = crypto.randomUUID(),
    foreignProject = crypto.randomUUID(),
    sp = crypto.randomUUID(),
    email = "other-owner@example.test";
  await db.batch([
    db
      .prepare("INSERT INTO profiles(id,email,name) VALUES(?,?,?)")
      .bind(owner, email, "Other owner"),
    db
      .prepare(
        "INSERT INTO identity_links(provider,issuer,subject,user_id) VALUES(?,?,?,?)",
      )
      .bind("cloudflare-access", issuer, email, owner),
    db
      .prepare("INSERT INTO organizations(id,name) VALUES(?,'Other company')")
      .bind(foreign),
    db
      .prepare(
        "INSERT INTO organization_memberships(organization_id,user_id,role) VALUES(?,?,'owner')",
      )
      .bind(foreign, owner),
    db
      .prepare(
        "INSERT INTO projects(id,organization_id,code,name) VALUES(?,?,'OTHERORG','Other company project')",
      )
      .bind(foreignProject, foreign),
    db
      .prepare(
        "INSERT INTO suppliers(id,organization_id,name,country,language) VALUES(?,?,'Partner','CN','en')",
      )
      .bind(sp, foreign),
    db
      .prepare(
        "INSERT INTO project_suppliers(organization_id,project_id,supplier_id) VALUES(?,?,?)",
      )
      .bind(foreign, foreignProject, sp),
  ]);
  const other = await jwt(email),
    i = await json<{ invitation_url: string }>(
      await as(other, `access/organizations/${foreign}/invitations`, {
        email: "library@example.test",
        role: "supplier_engineer",
        supplier_id: sp,
        project_ids: [foreignProject],
      }),
    );
  await json(
    await req("access/invitations/accept", {
      token: new URL(i.invitation_url).hash.slice(12),
    }),
  );
  const originalProject = project;
  project = foreignProject;
  const f = await drawing();
  project = originalProject;
  for (const path of [
    `projects/${foreignProject}/documents`,
    `documents/${f.document}`,
    `revisions/${f.revision}/content`,
    `projects/search?organization_id=${foreign}&q=Other`,
    `suppliers?organization_id=${foreign}`,
  ])
    expect((await req(path)).status, path).toBe(404);
  expect((await req(`collaboration/documents/${f.document}`)).status).toBe(404);
  await json(
    await as(
      other,
      `access/documents/${f.document}/sharing`,
      { shared: true, revision_ids: [f.revision] },
      "PATCH",
    ),
  );
  expect(
    (await req(`collaboration/revisions/${f.revision}/content`)).status,
  ).toBe(200);
  expect((await req(`projects/${project}/documents`)).status).toBe(200);
  await runtime.dispose();
  runtime = makeRuntime({ MULTIUSER_ENABLED: "false" });
  db = (await runtime.getD1Database("DB")) as unknown as D1Database;
  expect((await req(`documents/${f.document}`)).status).toBe(403);
  expect((await req("me")).status).toBe(200);
});
it("filters private requests before pagination and bounds database work when a full message page has many references", async () => {
  const a = await enroll("a@example.test", "designer"),
    sp = await supplier("A"),
    f = await drawing();
  await share(f);
  const conv = await conversation(true);
  for (let n = 0; n < 31; n++) {
    const id = crypto.randomUUID();
    await json(
      await as(a.session, `conversations/${conv}/messages`, {
        id,
        body: "Private internal " + n,
        shared: false,
      }),
    );
    await json(
      await as(a.session, `messages/${id}/requests`, {
        title: "Private request " + n,
      }),
    );
  }
  for (let n = 0; n < 30; n++)
    await json(
      await req(`conversations/${conv}/messages`, {
        id: crypto.randomUUID(),
        body: "Public referenced message " + n,
        shared: true,
        references: [
          { document_id: f.document, revision_id: f.revision, page: 1 },
          { document_id: f.document },
        ],
      }),
    );
  const i = await invite("a@example.test", "supplier_engineer", sp);
  await json(
    await as(a.session, "access/invitations/accept", {
      token: new URL(i.invitation_url).hash.slice(12),
    }),
  );
  const requests = await json<{ items: unknown[]; hasMore: boolean }>(
    await as(a.session, `collaboration/projects/${project}/requests`),
  );
  expect(requests.items).toEqual([]);
  expect(requests.hasMore).toBe(false);
  const response = await as(
    a.session,
    `collaboration/conversations/${conv}/messages`,
  );
  expect(
    Number(response.headers.get("X-Test-D1-Statements")),
  ).toBeLessThanOrEqual(15);
  const result = await json<{ items: { references: unknown[] }[] }>(response);
  expect(result.items).toHaveLength(30);
  expect(result.items.every((m) => m.references.length === 2)).toBe(true);
});
it("keeps internal glossary terms and their cached translations private from external members", async () => {
  const actor = await enroll(
    "a@example.test",
    "supplier_engineer",
    await supplier("A"),
  );
  const message = await send(await conversation(true), "Charnière 3 mm");
  await json(
    await req(`organizations/${org}/glossary`, {
      fr: "Charnière",
      en: "Private hinge",
      "zh-CN": "内部铰链",
      domain: "Mécanique",
      notes: "Internal terminology",
    }),
  );
  const body = {
    kind: "message",
    id: message,
    field: "body",
    source_language: "fr",
    target_language: "en",
  };
  const internal = await json<{ id: string; machine: string }>(
    await req("translations", body),
  );
  expect(internal.machine).toBe("Private hinge 3 mm");
  expect(
    (await as(actor.session, `organizations/${org}/glossary`)).status,
  ).toBe(404);
  const external = await json<{ id: string; machine: string }>(
    await as(actor.session, "translations", body),
  );
  expect(external.machine).toBe("Hinge 3 mm");
  expect(external.id).not.toBe(internal.id);
  expect(
    (
      await as(
        actor.session,
        `translations/${internal.id}`,
        { body: "Correction 3 mm", version: 0 },
        "PATCH",
      )
    ).status,
  ).toBe(409);
});
it("serves exact authorized supplier byte ranges and rejects every old range URL after sharing withdrawal", async () => {
  const f = await drawing(),
    actor = await enroll(
      "range@example.test",
      "supplier_engineer",
      await supplier("Range"),
    );
  await share(f);
  const path = `collaboration/revisions/${f.revision}/content`;
  const r = await req(path, undefined, "GET", {
    "Cf-Access-Jwt-Assertion": actor.session,
    Range: "bytes=0-7",
  });
  expect(r.status).toBe(206);
  expect(r.headers.get("Content-Length")).toBe("8");
  expect(new Uint8Array(await r.arrayBuffer())).toEqual(f.bytes.slice(0, 8));
  await share(f, false, []);
  expect(
    (
      await req(path, undefined, "GET", {
        "Cf-Access-Jwt-Assertion": actor.session,
        Range: "bytes=0-7",
      })
    ).status,
  ).toBe(404);
  expect(
    new Uint8Array(await (await storage.get(f.key))!.arrayBuffer()),
  ).toEqual(f.bytes);
});
