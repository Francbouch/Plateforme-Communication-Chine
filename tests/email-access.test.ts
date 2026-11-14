import { it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { migrate } from "./helpers/d1";
let runtime: Miniflare,
  db: D1Database,
  script: string,
  access: string,
  recovery: string,
  org: string,
  project: string;
const origin = "https://workspace.example.test",
  admin = "00000000-0000-4000-8000-000000000001",
  email = "owner@example.test";
beforeAll(async () => {
  const key = await generateKeyPair("RS256"),
    jwk = await exportJWK(key.publicKey),
    issuer = "https://email-test.cloudflareaccess.com";
  access = await new SignJWT({ email, type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setSubject("existing-owner")
    .setIssuer(issuer)
    .setAudience("test")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key.privateKey);
  recovery = await new SignJWT({ email, type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setSubject("existing-owner")
    .setIssuer(issuer)
    .setAudience("test-recovery")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key.privateKey);
  const out = await build({
    stdin: {
      contents: `import {createApp} from './apps/api/src/index';import {AccessIdentityProvider} from './apps/api/src/identity';import {createLocalJWKSet} from 'jose';const mail=new Map();let sends=0;const app=createApp(new AccessIdentityProvider(createLocalJWKSet({keys:[${JSON.stringify({ ...jwk, kid: "test", alg: "RS256" })}]})),async()=>new Response('<html>Test frontend</html>',{headers:{'Content-Type':'text/html'}}),undefined,async(url,init)=>{if(String(url)!=='https://api.resend.com/emails')throw new Error('Unexpected mail host');const m=JSON.parse(init.body);sends++;mail.set(m.to[0],m.text);return Response.json({id:'simulated-not-delivered'});});export default {async fetch(req,env,ctx){const url=new URL(req.url);if(url.pathname==='/test-mail')return Response.json({text:mail.get(url.searchParams.get('email')),sends});return app.fetch(req,env,ctx);}};`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["node:*"],
    write: false,
  });
  script = out.outputFiles[0].text;
});
beforeEach(async () => {
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: "2026-10-29",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "email-access" },
      r2Buckets: { DOCUMENTS: "email-files" },
      bindings: {
        APP_ORIGIN: origin,
        VERCEL_ORIGIN: "https://test.vercel.app",
        ORIGIN_SHARED_SECRET: "x".repeat(50),
        ACCESS_ISSUER: "https://email-test.cloudflareaccess.com",
        ACCESS_AUD: "test",
        RECOVERY_ACCESS_AUD: "test-recovery",
        ADMIN_EMAIL: email,
        ADMIN_USER_ID: admin,
        MULTIUSER_ENABLED: "true",
        EMAIL_AUTH_ENABLED: "staging",
        EMAIL_AUTH_SECURITY_REVIEWED: "true",
        EMAIL_AUTH_BACKUP_PROOF: "a".repeat(64),
        BETTER_AUTH_SECRET: "test-only-secret-" + "b".repeat(48),
        RESEND_API_KEY: "test-only",
        AUTH_FROM: "auth@example.test",
      },
    }),
  );
  db = (await runtime.getD1Database("DB")) as unknown as D1Database;
  await migrate(db);
  org = (
    await json(await owner("organizations", { name: "Preserved organization" }))
  ).id;
  project = (
    await json(
      await owner("projects", {
        organization_id: org,
        code: "AUTH",
        name: "Preserved project",
      }),
    )
  ).id;
});
afterEach(async () => {
  await runtime.dispose();
});
function req(
  path: string,
  body?: unknown,
  cookie = "",
  headers: Record<string, string> = {},
) {
  return runtime.dispatchFetch(origin + path, {
    method: body ? "POST" : "GET",
    redirect: "manual",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "cf-connecting-ip": "192.0.2.1",
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
function owner(path: string, body?: unknown) {
  return req("/api/v1/" + path, body, "", {
    "Cf-Access-Jwt-Assertion": access,
  });
}
async function json(r: Awaited<ReturnType<typeof req>>): Promise<{
  id: string;
  invitation_url: string;
  sends: number;
  text: string;
  enabled: boolean;
  is_primary_admin: boolean;
  profile: { id: string };
  organizations: { id: string }[];
  items: { id: string; expiresAt: string }[];
  [index: number]: { id: string; role: string };
}> {
  const text = await r.text();
  expect(r.status, text).toBeLessThan(400);
  return JSON.parse(text);
}
async function approve(user = admin, address = email) {
  return json(
    await owner("access/email-auth/enrollments", {
      user_id: user,
      email: address,
    }),
  );
}
async function code(address = email) {
  await json(
    await req("/api/auth/email-otp/send-verification-otp", {
      email: address,
      type: "sign-in",
    }),
  );
  const m = await json(
    await req("/test-mail?email=" + encodeURIComponent(address)),
  );
  return (m.text as string).match(/\b\d{8}\b/)![0];
}
async function signin(address = email, otp?: string) {
  return req("/api/auth/sign-in/email-otp", {
    email: address,
    otp: otp ?? (await code(address)),
    role: "owner",
    user_id: admin,
  });
}
function cookie(r: Awaited<ReturnType<typeof req>>) {
  const raw = r.headers.get("Set-Cookie") ?? "";
  const value = raw.match(
    /(?:__Secure-)?forgebridge\.session_token=[^;]+/,
  )?.[0];
  expect(value, raw).toBeTruthy();
  return value!;
}
async function login() {
  await approve();
  const response = await signin();
  expect(response.status, await response.clone().text()).toBe(200);
  return cookie(response);
}
async function invite(address: string, role = "reviewer") {
  const result = await json(
    await owner(`access/organizations/${org}/invitations`, {
      email: address,
      role,
      project_ids: [project],
      supplier_id: null,
    }),
  );
  if (!result.invitation_url) {
    const mail = await json(
      await req("/test-mail?email=" + encodeURIComponent(address)),
    );
    result.invitation_url = mail.text.match(
      /https:\/\/[^\s]+#invitation=[^\s]+/,
    )![0];
  }
  return result;
}

it("does not bootstrap a public administrator and exposes only the narrow auth surface", async () => {
  await json(
    await req("/api/auth/email-otp/send-verification-otp", {
      email,
      type: "sign-in",
    }),
  );
  expect((await json(await req("/test-mail?email=" + email))).sends).toBe(0);
  expect((await req("/api/v1/me")).status).toBe(401);
  for (const path of [
    "/api/auth/sign-up/email",
    "/api/auth/get-session",
    "/api/auth/update-user",
    "/api/auth/email-otp/check-verification-otp",
  ])
    expect((await req(path, {})).status).toBe(404);
  expect((await req("/api/v1/revisions/unknown/content")).status).toBe(401);
  expect(
    (
      await req(
        "/api/auth/email-otp/send-verification-otp",
        { email, type: "sign-in" },
        "",
        { Origin: "https://evil.test" },
      )
    ).status,
  ).toBe(403);
  expect((await req("/recovery")).status).toBe(401);
});
it("links the verified administrator to the exact original UUID and projects, with secure persistent cookie and no token in JSON", async () => {
  const c = await login();
  const me = await json(await req("/api/v1/me", undefined, c));
  expect(me.profile.id).toBe(admin);
  expect(me.is_primary_admin).toBe(true);
  expect(me.organizations[0].id).toBe(org);
  expect(
    (
      await json(
        await req(`/api/v1/projects?organization_id=${org}`, undefined, c),
      )
    )[0].id,
  ).toBe(project);
  expect(await db.prepare("SELECT count(*) n FROM profiles").first("n")).toBe(
    1,
  );
  expect(
    await db
      .prepare("SELECT provider FROM identity_links WHERE user_id=?")
      .bind(admin)
      .first("provider"),
  ).toBe("cloudflare-access");
  expect((await owner("me")).status).toBe(200);
  const sessions = await json(
    await req("/api/v1/access/email-auth/sessions", undefined, c),
  );
  expect(sessions.items).toHaveLength(1);
  expect(JSON.stringify(sessions)).not.toContain("token");
  const expiry = new Date(sessions.items[0].expiresAt).getTime() - Date.now();
  expect(expiry).toBeGreaterThan(6 * 86400000);
});
it("hashes codes with a server secret, expires them, limits wrong guesses and rejects replay", async () => {
  await approve();
  const otp = await code();
  const row = await db
    .prepare("SELECT value FROM email_auth_verification")
    .first<{ value: string }>();
  expect(row!.value).not.toContain(otp);
  const first = await signin(email, otp);
  expect(first.status).toBe(200);
  expect(first.headers.get("Set-Cookie")).toContain("HttpOnly");
  expect(first.headers.get("Set-Cookie")).toContain("Secure");
  expect(await first.json()).toEqual({ ok: true });
  expect((await signin(email, otp)).status).toBe(401);
});
it("expires the verification record and refuses all guesses after five wrong attempts", async () => {
  await approve();
  const otp = await code();
  for (let n = 0; n < 5; n++)
    expect(
      (await signin(email, otp === "00000000" ? "11111111" : "00000000"))
        .status,
    ).toBe(401);
  expect((await signin(email, otp)).status).toBe(401);
  await db.prepare("DELETE FROM email_auth_windows").run();
  const next = await code();
  await db
    .prepare(
      "UPDATE email_auth_verification SET expiresAt='2000-01-01T00:00:00.000Z'",
    )
    .run();
  expect((await signin(email, next)).status).toBe(401);
});
it("consumes a valid code atomically under concurrent sign-in requests", async () => {
  await approve();
  const otp = await code();
  const responses = await Promise.all([signin(email, otp), signin(email, otp)]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
  expect(
    await db.prepare("SELECT count(*) n FROM email_auth_session").first("n"),
  ).toBe(1);
});
it("enforces persistent email cooldowns even on valid addresses without duplicate delivery", async () => {
  await approve();
  await code();
  expect(
    (
      await req("/api/auth/email-otp/send-verification-otp", {
        email,
        type: "sign-in",
      })
    ).status,
  ).toBe(429);
  expect((await json(await req("/test-mail?email=" + email))).sends).toBe(1);
});
it("logs out and immediately refuses a copied old cookie", async () => {
  const c = await login();
  const response = await req("/api/v1/access/logout", {}, c);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toEqual({ logout_url: "/" });
  expect((await req("/api/v1/me", undefined, c)).status).toBe(401);
  expect(
    await db.prepare("SELECT count(*) n FROM email_auth_session").first("n"),
  ).toBe(0);
});
it("grants only accepted invitation scopes and reader permissions, never browser chosen admin privileges", async () => {
  const address = "reader@example.test",
    i = await invite(address);
  const response = await signin(address);
  expect(response.status, await response.clone().text()).toBe(200);
  const c = cookie(response);
  expect(
    await json(await req("/api/v1/collaboration/projects", undefined, c)),
  ).toHaveLength(0);
  await json(
    await req(
      "/api/v1/access/invitations/accept",
      { token: new URL(i.invitation_url).hash.slice(12) },
      c,
    ),
  );
  const projects = await json(
    await req("/api/v1/collaboration/projects", undefined, c),
  );
  expect(projects[0].id).toBe(project);
  expect(projects[0].role).toBe("reviewer");
  expect(
    (
      await req(
        `/api/v1/projects/${project}/conversations`,
        { title: "Forbidden" },
        c,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await req(
        "/api/v1/access/email-auth/enrollments",
        { user_id: admin, email },
        c,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await req(
        "/api/v1/collaboration/projects/00000000-0000-4000-8000-000000000999/documents",
        undefined,
        c,
      )
    ).status,
  ).toBe(404);
  const uid = (await json(await req("/api/v1/me", undefined, c))).profile.id;
  await json(
    await owner(`access/organizations/${org}/revoke-sessions/${uid}`, {}),
  );
  expect((await req("/api/v1/me", undefined, c)).status).toBe(401);
});
it("does not send to revoked/expired invitations or automatically attach an existing profile", async () => {
  const address = "revoked@example.test",
    i = await invite(address);
  await db
    .prepare(
      "UPDATE access_invitations SET revoked_at=datetime('now') WHERE id=?",
    )
    .bind(i.id)
    .run();
  await json(
    await req("/api/auth/email-otp/send-verification-otp", {
      email: address,
      type: "sign-in",
    }),
  );
  expect((await json(await req("/test-mail?email=" + address))).sends).toBe(1); // invitation email only
  await db
    .prepare(
      "INSERT INTO profiles(id,email,name) VALUES(?,'existing@example.test','Existing member')",
    )
    .bind(crypto.randomUUID())
    .run();
  await invite("existing@example.test");
  await json(
    await req("/api/auth/email-otp/send-verification-otp", {
      email: "existing@example.test",
      type: "sign-in",
    }),
  );
  expect(
    (await json(await req("/test-mail?email=existing@example.test"))).sends,
  ).toBe(2); // two invitation emails, no OTP
});
it("rejects native cookies at recovery, validates independent Access, then enables only after all administrator proofs", async () => {
  await approve();
  expect(
    (
      await req("/recovery/action", { action: "enable" }, "", {
        "Cf-Access-Jwt-Assertion": recovery,
      })
    ).status,
  ).toBe(409);
  const c = await login();
  expect((await req("/recovery", undefined, c)).status).toBe(401);
  expect(
    (
      await req("/recovery", undefined, "", {
        "Cf-Access-Jwt-Assertion": recovery,
      })
    ).status,
  ).toBe(200);
  await json(await req("/api/v1/me", undefined, c));
  expect(
    (
      await req("/recovery/action", { action: "verify-recovery" }, "", {
        "Cf-Access-Jwt-Assertion": recovery,
      })
    ).status,
  ).toBe(303);
  expect(
    (
      await req("/recovery/action", { action: "enable" }, "", {
        "Cf-Access-Jwt-Assertion": recovery,
      })
    ).status,
  ).toBe(303);
  expect(
    await db.prepare("SELECT enabled FROM email_auth_control").first("enabled"),
  ).toBe(1);
  expect(
    (
      await req("/recovery/action", { action: "revoke-native" }, "", {
        "Cf-Access-Jwt-Assertion": recovery,
      })
    ).status,
  ).toBe(303);
  expect((await req("/api/v1/me", undefined, c)).status).toBe(401);
  expect((await owner("me")).status).toBe(200);
  expect(
    (
      await req("/recovery/action", { action: "disable" }, "", {
        "Cf-Access-Jwt-Assertion": recovery,
      })
    ).status,
  ).toBe(303);
  expect((await json(await req("/api/auth/config"))).enabled).toBe(false);
  expect((await owner("me")).status).toBe(200);
});
it("protects shared exact R2 revisions with a native cookie and invalidates old URLs on permission withdrawal", async () => {
  const address = "files@example.test",
    i = await invite(address),
    signed = await signin(address),
    c = cookie(signed);
  await json(
    await req(
      "/api/v1/access/invitations/accept",
      { token: new URL(i.invitation_url).hash.slice(12) },
      c,
    ),
  );
  const document = crypto.randomUUID(),
    b = crypto.randomUUID(),
    next = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO documents(id,project_id,name,externally_shared) VALUES(?,?,?,1)",
    )
    .bind(document, project, "Shared fixture")
    .run();
  const bucket = await runtime.getR2Bucket("DOCUMENTS"),
    bytes = new TextEncoder().encode("%PDF-1.7 fixture original");
  for (const [id, ordinal] of [
    [b, 1],
    [next, 2],
  ] as const) {
    await bucket.put("test-only/" + id, bytes);
    await db
      .prepare(
        "INSERT INTO document_revisions(id,document_id,ordinal,label,filename,extension,content_type,size,sha256,object_key,created_by) VALUES(?,?,?,?,'test.pdf','pdf','application/pdf',?,?,?,?)",
      )
      .bind(
        id,
        document,
        ordinal,
        String(ordinal),
        bytes.length,
        "a".repeat(64),
        "test-only/" + id,
        admin,
      )
      .run();
  }
  await db
    .prepare("INSERT INTO revision_shares(revision_id,shared_by) VALUES(?,?)")
    .bind(b, admin)
    .run();
  const path = `/api/v1/collaboration/revisions/${b}/content`;
  const partial = await req(path, undefined, c, { Range: "bytes=0-7" });
  expect(partial.status).toBe(206);
  expect(new Uint8Array(await partial.arrayBuffer())).toEqual(
    bytes.slice(0, 8),
  );
  expect(
    (await req(`/api/v1/collaboration/revisions/${next}/content`, undefined, c))
      .status,
  ).toBe(404);
  expect(
    (await req(`/api/v1/revisions/${b}/content`, undefined, c)).status,
  ).toBe(404);
  const uid = (await json(await req("/api/v1/me", undefined, c))).profile.id;
  await db
    .prepare(
      "UPDATE project_memberships SET active=0 WHERE user_id=? AND project_id=?",
    )
    .bind(uid, project)
    .run();
  expect((await req(path, undefined, c, { Range: "bytes=0-7" })).status).toBe(
    404,
  );
  expect(
    new Uint8Array(await (await bucket.get("test-only/" + b))!.arrayBuffer()),
  ).toEqual(bytes);
});
it("preserves a reviewed pre-existing member UUID and roles instead of creating or promoting a second profile", async () => {
  const uid = crypto.randomUUID(),
    address = "existing@example.test";
  await db
    .prepare("INSERT INTO profiles(id,email,name) VALUES(?,?,?)")
    .bind(uid, address, "Existing identity")
    .run();
  await db
    .prepare(
      "INSERT INTO identity_links(provider,issuer,subject,user_id) VALUES('cloudflare-access','https://email-test.cloudflareaccess.com','existing-subject',?)",
    )
    .bind(uid)
    .run();
  await db
    .prepare(
      "INSERT INTO organization_memberships(organization_id,user_id,role) VALUES(?,?,'designer')",
    )
    .bind(org, uid)
    .run();
  await db
    .prepare(
      "INSERT INTO project_memberships(organization_id,project_id,user_id,role,access_enabled) VALUES(?,?,?,'designer',1)",
    )
    .bind(org, project, uid)
    .run();
  await approve(uid, address);
  const signed = await signin(address),
    c = cookie(signed);
  expect(signed.status, await signed.clone().text()).toBe(200);
  const me = await json(await req("/api/v1/me", undefined, c));
  expect(me.profile.id).toBe(uid);
  expect(me.is_primary_admin).toBe(false);
  const projects = await json(
    await req("/api/v1/collaboration/projects", undefined, c),
  );
  expect(projects[0].id).toBe(project);
  expect(projects[0].role).toBe("designer");
  expect(await db.prepare("SELECT count(*) n FROM profiles").first("n")).toBe(
    2,
  );
  expect(
    await db
      .prepare("SELECT role FROM organization_memberships WHERE user_id=?")
      .bind(uid)
      .first("role"),
  ).toBe("designer");
  expect(
    await db
      .prepare("SELECT provider FROM identity_links WHERE user_id=?")
      .bind(uid)
      .first("provider"),
  ).toBe("cloudflare-access");
});
it("rejects an invitation withdrawn after code delivery and refuses an expired session", async () => {
  const address = "withdrawn@example.test",
    i = await invite(address),
    otp = await code(address);
  await db
    .prepare(
      "UPDATE access_invitations SET revoked_at=datetime('now') WHERE id=?",
    )
    .bind(i.id)
    .run();
  expect((await signin(address, otp)).status).toBe(401);
  const c = await login();
  await db
    .prepare(
      "UPDATE email_auth_session SET expiresAt='2000-01-01T00:00:00.000Z'",
    )
    .run();
  expect((await req("/api/v1/me", undefined, c)).status).toBe(401);
  expect((await owner("me")).status).toBe(200);
});
