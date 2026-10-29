import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, migrate } from "./helpers/d1";
import { createApp } from "../apps/api/src/index";
import { AccessIdentityProvider } from "../apps/api/src/identity";
import { R2Storage, assetKey } from "../apps/api/src/storage";
import { Store } from "../apps/api/src/database";
import type { Bindings } from "../apps/api/src/types";
const admin = "00000000-0000-4000-8000-000000000001";
const issuer = "https://forgebridge-test.cloudflareaccess.com";
const email = "owner@example.test";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let app: ReturnType<typeof createApp>;
let fixture: Awaited<ReturnType<typeof createDatabase>>;
let env: Bindings;
let token: string;
const upstream = vi.fn<typeof fetch>();
async function sign(overrides: Record<string, unknown> = {}, key?: CryptoKey) {
  return new SignJWT({ email, type: "app", ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "integration" })
    .setSubject("real-test-subject")
    .setIssuer(issuer)
    .setAudience("forgebridge-audience")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key ?? keys.privateKey);
}
async function request(
  path: string,
  body?: unknown,
  method?: string,
  headers: Record<string, string> = {},
) {
  return app.request(
    path.startsWith("/") ? path : `/api/v1/${path}`,
    {
      method: method ?? (body ? "POST" : "GET"),
      headers: {
        Origin: env.APP_ORIGIN!,
        "Cf-Access-Jwt-Assertion": token,
        "Content-Type": "application/json",
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    },
    env,
  );
}
async function organization() {
  const r = await request("organizations", { name: "Test organization" });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}
async function project(org: string, code = "P1") {
  const r = await request("projects", {
    organization_id: org,
    code,
    name: "Industrial project",
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  token = await sign();
});
beforeEach(async () => {
  fixture = await createDatabase();
  await migrate(fixture.db);
  const jwk = await exportJWK(keys.publicKey);
  app = createApp(
    new AccessIdentityProvider(
      createLocalJWKSet({
        keys: [{ ...jwk, kid: "integration", alg: "RS256" }],
      }),
    ),
    upstream,
  );
  env = {
    DB: fixture.db,
    APP_ORIGIN: "https://private.example.test",
    ACCESS_ISSUER: issuer,
    ACCESS_AUD: "forgebridge-audience",
    ADMIN_EMAIL: email,
    ADMIN_USER_ID: admin,
    VERCEL_ORIGIN: "https://forgebridge-test.vercel.app",
    ORIGIN_SHARED_SECRET: "x".repeat(43),
  };
  upstream.mockReset();
  upstream.mockResolvedValue(
    new Response("<html>ForgeBridge</html>", {
      headers: { "Content-Type": "text/html" },
    }),
  );
});
afterEach(async () => {
  await fixture?.runtime.dispose();
});
describe("real D1 and signed Access boundary", () => {
  it("initializes only the verified real principal and no demo organization", async () => {
    const r = await request("me");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      profile: { id: admin },
      organizations: [],
      mode: "private-developer",
    });
    expect(
      await fixture.db.prepare("SELECT count(*) AS n FROM profiles").first("n"),
    ).toBe(1);
  });
  it("rejects absent tokens on API, health, HTML and assets", async () => {
    for (const p of ["me", "health", "/", "/assets/app.js"])
      expect(
        (
          await request(p, undefined, undefined, {
            "Cf-Access-Jwt-Assertion": "",
          })
        ).status,
      ).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("rejects a forged JWT signature", async () => {
    const other = await generateKeyPair("RS256");
    expect(
      (
        await request("me", undefined, undefined, {
          "Cf-Access-Jwt-Assertion": await sign({}, other.privateKey),
        })
      ).status,
    ).toBe(401);
  });
  it("rejects expired JWTs", async () => {
    const expired = await new SignJWT({ email, type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "integration" })
      .setSubject("real-test-subject")
      .setIssuer(issuer)
      .setAudience("forgebridge-audience")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(keys.privateKey);
    expect(
      (
        await request("me", undefined, undefined, {
          "Cf-Access-Jwt-Assertion": expired,
        })
      ).status,
    ).toBe(401);
  });
  it("rejects another audience or issuer", async () => {
    for (const [iss, aud] of [
      [issuer, "wrong-audience"],
      ["https://other.cloudflareaccess.com", "forgebridge-audience"],
    ]) {
      const t = await new SignJWT({ email, type: "app" })
        .setProtectedHeader({ alg: "RS256", kid: "integration" })
        .setSubject("real-test-subject")
        .setIssuer(iss)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey);
      expect(
        (
          await request("me", undefined, undefined, {
            "Cf-Access-Jwt-Assertion": t,
          })
        ).status,
      ).toBe(401);
    }
  });
  it("rejects non-application tokens and non-admin identities", async () => {
    expect(
      (
        await request("me", undefined, undefined, {
          "Cf-Access-Jwt-Assertion": await sign({ type: "org" }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request("me", undefined, undefined, {
          "Cf-Access-Jwt-Assertion": await sign({
            email: "supplier@example.test",
          }),
        })
      ).status,
    ).toBe(403);
  });
  it("fails closed if Access or administrator configuration is absent", async () => {
    env.ACCESS_AUD = "";
    expect((await request("me")).status).toBe(503);
    env.ACCESS_AUD = "forgebridge-audience";
    env.ADMIN_USER_ID = "";
    expect((await request("me")).status).toBe(503);
  });
  it("refuses spoofed browser identity headers and a suspended profile", async () => {
    await request("me");
    await fixture.db
      .prepare("UPDATE profiles SET status='suspended' WHERE id=?")
      .bind(admin)
      .run();
    expect(
      (
        await request("me", undefined, undefined, {
          "X-User-ID": admin,
          "Cf-Access-Authenticated-User-Email": email,
        })
      ).status,
    ).toBe(403);
  });
  it("creates, edits and reads projects with audit/outbox persisted", async () => {
    const org = await organization();
    const id = await project(org);
    const edit = await request("projects", {
      organization_id: org,
      id,
      code: "P1",
      name: "Updated project",
      description: "Persistent drawing",
      status: "paused",
    });
    expect(edit.status).toBe(201);
    const r = await request(`projects?organization_id=${org}`);
    expect(await r.json()).toMatchObject([
      { id, name: "Updated project", status: "paused" },
    ]);
    expect(
      await fixture.db
        .prepare("SELECT count(*) FROM audit_events")
        .first("count(*)"),
    ).toBe(3);
    expect(
      await fixture.db.prepare("SELECT count(*) FROM outbox").first("count(*)"),
    ).toBe(3);
  });
  it("survives database runtime restart using D1 persisted state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forgebridge-d1-"));
    let local = await createDatabase(dir);
    try {
      await migrate(local.db);
      await local.db
        .prepare(
          "INSERT INTO profiles(id,email,name) VALUES(?,'owner@example.test','Owner')",
        )
        .bind(admin)
        .run();
      const store = new Store(local.db, admin);
      const org = await store.createOrganization("Persistent org");
      await store.saveProject({
        organization_id: org.id,
        id: null,
        code: "R1",
        name: "Restart proof",
        description: "",
        status: "active",
      });
      await local.runtime.dispose();
      local = await createDatabase(dir);
      expect(await new Store(local.db, admin).projects(org.id)).toMatchObject([
        { name: "Restart proof" },
      ]);
    } finally {
      await local.runtime.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("rejects invalid input and conflicting codes without a false success or extra event", async () => {
    const org = await organization();
    await project(org);
    expect(
      (
        await request("projects", {
          organization_id: org,
          code: "../bad",
          name: "X",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("projects", {
          organization_id: org,
          code: "P1",
          name: "Duplicate",
        })
      ).status,
    ).toBe(409);
    expect(
      await fixture.db
        .prepare("SELECT count(*) FROM projects")
        .first("count(*)"),
    ).toBe(1);
    expect(
      await fixture.db
        .prepare("SELECT count(*) FROM audit_events")
        .first("count(*)"),
    ).toBe(2);
  });
  it("denies a forged organization ID and invalid cross-tenant references", async () => {
    const org = await organization();
    const other = crypto.randomUUID();
    expect((await request(`projects?organization_id=${other}`)).status).toBe(
      403,
    );
    expect(
      (
        await request("projects", {
          organization_id: other,
          name: "Forbidden",
          code: "X",
        })
      ).status,
    ).toBe(403);
    const p = await project(org);
    expect(
      (
        await request(`projects/${p}/suppliers`, {
          supplier_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(403);
  });
  it("persists suppliers, notes, preferences and project associations", async () => {
    const org = await organization();
    const p = await project(org);
    const r = await request("suppliers", {
      organization_id: org,
      name: "Manufacturing company",
      country: "China",
      language: "zh-CN",
      internal_notes: "Internal",
    });
    expect(r.status).toBe(201);
    const s = ((await r.json()) as { id: string }).id;
    expect(
      (await request(`projects/${p}/suppliers`, { supplier_id: s })).status,
    ).toBe(200);
    expect(
      await (await request(`suppliers?organization_id=${org}`)).json(),
    ).toMatchObject([
      { id: s, supplier_notes: { internal_notes: "Internal" } },
    ]);
    expect(
      (
        await request(
          "me",
          { name: "Owner", language: "en", timezone: "Asia/Shanghai" },
          "PATCH",
        )
      ).status,
    ).toBe(200);
    expect(await (await request("me")).json()).toMatchObject({
      profile: { language: "en", timezone: "Asia/Shanghai" },
    });
  });
  it("stores hashed preparatory invitations, revokes them and disables redemption", async () => {
    const org = await organization();
    const p = await project(org);
    const r = await request("invitations", {
      project_id: p,
      supplier_id: null,
      email: "reviewer@example.test",
      role: "reviewer",
    });
    expect(r.status).toBe(201);
    const v = (await r.json()) as {
      id: string;
      token: string;
      redeemable: boolean;
    };
    expect(v.redeemable).toBe(false);
    const hash = await fixture.db
      .prepare("SELECT token_hash FROM invitations WHERE id=?")
      .bind(v.id)
      .first("token_hash");
    expect(hash).toHaveLength(64);
    expect(hash).not.toBe(v.token);
    expect(
      (await request("invitations/accept", { token: v.token })).status,
    ).toBe(409);
    expect(
      (await request(`invitations/${v.id}`, undefined, "DELETE")).status,
    ).toBe(200);
    expect(
      await (await request(`invitations?organization_id=${org}`)).json(),
    ).toMatchObject([{ id: v.id, revoked_at: expect.any(String) }]);
  });
  it("prevents self-revocation and honours configured quotas", async () => {
    const org = await organization();
    expect(
      (
        await request(
          `organization_memberships/${admin}`,
          { organization_id: org, role: "owner", active: false },
          "PATCH",
        )
      ).status,
    ).toBe(403);
    env.RATE_LIMITER = { limit: async () => ({ success: false }) };
    expect((await request("me")).status).toBe(429);
  });
  it("rejects cross-origin mutations and restricts CORS", async () => {
    expect(
      (
        await request("organizations", { name: "X" }, undefined, {
          Origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    const pre = await request("projects", undefined, "OPTIONS", {
      "Access-Control-Request-Method": "POST",
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe(env.APP_ORIGIN);
    const bad = await request("projects", undefined, "OPTIONS", {
      Origin: "https://evil.example",
    });
    expect(bad.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
  it("proxies only after identity checks and strips client credentials", async () => {
    const r = await request("/", undefined, undefined, {
      "X-ForgeBridge-Origin-Key": "forged",
      Cookie: "sensitive=client",
    });
    expect(r.status).toBe(200);
    const init = upstream.mock.calls[0][1]!;
    const h = new Headers(init.headers);
    expect(h.get("X-ForgeBridge-Origin-Key")).toBe(env.ORIGIN_SHARED_SECRET);
    expect(h.get("Cookie")).toBeNull();
    expect(h.get("Cf-Access-Jwt-Assertion")).toBeNull();
    expect(r.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("rolls back the data write when audit storage fails", async () => {
    const org = await organization();
    await fixture.db
      .prepare(
        "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'test failure'); END;",
      )
      .run();
    expect(
      (
        await request("projects", {
          organization_id: org,
          code: "FAIL",
          name: "Must roll back",
        })
      ).status,
    ).toBe(503);
    expect(
      await fixture.db
        .prepare("SELECT count(*) FROM projects")
        .first("count(*)"),
    ).toBe(0);
  });
  it("keeps supplier projects and internal notes isolated in the future permission layer", async () => {
    const org = await organization();
    const p1 = await project(org, "A");
    const p2 = await project(org, "B");
    const supplier = crypto.randomUUID(),
      user = crypto.randomUUID();
    await fixture.db.batch([
      fixture.db
        .prepare(
          "INSERT INTO profiles(id,email,name) VALUES(?,'fixture-supplier@example.test','Test supplier')",
        )
        .bind(user),
      fixture.db
        .prepare(
          "INSERT INTO organization_memberships VALUES(?,?,'supplier_engineer',1)",
        )
        .bind(org, user),
      fixture.db
        .prepare(
          "INSERT INTO suppliers(id,organization_id,name,country,language) VALUES(?,?,'Supplier','CN','zh-CN')",
        )
        .bind(supplier, org),
      fixture.db
        .prepare("INSERT INTO supplier_notes VALUES(?,?,'Secret')")
        .bind(org, supplier),
      fixture.db
        .prepare("INSERT INTO project_suppliers VALUES(?,?,?)")
        .bind(org, p1, supplier),
      fixture.db
        .prepare(
          "INSERT INTO supplier_memberships(organization_id,supplier_id,user_id) VALUES(?,?,?)",
        )
        .bind(org, supplier, user),
      fixture.db
        .prepare(
          "INSERT INTO project_memberships VALUES(?,?,?,'supplier_engineer',?,1)",
        )
        .bind(org, p1, user, supplier),
    ]);
    const future = new Store(fixture.db, user);
    expect(await future.projects(org)).toMatchObject([{ id: p1 }]);
    await expect(future.requireProject(p2)).rejects.toThrow(
      "Project access denied",
    );
    expect(await future.suppliers(org)).toMatchObject([
      { supplier_notes: null },
    ]);
    await expect(
      future.saveProject({
        organization_id: org,
        id: p1,
        code: "HACK",
        name: "No",
        description: "",
        status: "active",
      }),
    ).rejects.toThrow();
    await fixture.db
      .prepare("UPDATE supplier_memberships SET active=0 WHERE user_id=?")
      .bind(user)
      .run();
    expect(await future.projects(org)).toEqual([]);
  });
});

it("rejects tokens without expiry or with a future issue date", async () => {
  for (const future of [false, true]) {
    let jwt = new SignJWT({ email, type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "integration" })
      .setSubject("real-test-subject")
      .setIssuer(issuer)
      .setAudience("forgebridge-audience")
      .setIssuedAt(
        future
          ? Math.floor(Date.now() / 1000) + 60
          : Math.floor(Date.now() / 1000),
      );
    if (future) jwt = jwt.setExpirationTime("5m");
    expect(
      (
        await request("me", undefined, undefined, {
          "Cf-Access-Jwt-Assertion": await jwt.sign(keys.privateKey),
        })
      ).status,
    ).toBe(401);
  }
});
it("does not silently bind another Access subject to the configured administrator", async () => {
  await request("me");
  const other = await new SignJWT({ email, type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "integration" })
    .setSubject("replacement-subject")
    .setIssuer(issuer)
    .setAudience("forgebridge-audience")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
  expect(
    (
      await request("me", undefined, undefined, {
        "Cf-Access-Jwt-Assertion": other,
      })
    ).status,
  ).toBe(403);
});
it("stages private R2 objects with checksum validation and refuses overwrites", async () => {
  const bucket = (await fixture.runtime.getR2Bucket(
    "DOCUMENTS",
  )) as unknown as R2Bucket;
  const storage = new R2Storage(bucket);
  const key = assetKey({
    organizationId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    documentId: crypto.randomUUID(),
  });
  const hash = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode("test-asset"),
      ),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  await storage.stage(key, new TextEncoder().encode("test-asset").buffer, {
    contentType: "application/octet-stream",
    sha256: hash,
  });
  expect(await new Response(await storage.read(key)).text()).toBe("test-asset");
  await expect(
    storage.stage(key, new TextEncoder().encode("test-asset").buffer, {
      contentType: "application/octet-stream",
      sha256: hash,
    }),
  ).rejects.toThrow();
  await expect(
    storage.stage(
      key + "-other",
      new TextEncoder().encode("test-asset").buffer,
      {
        contentType: "application/octet-stream",
        sha256: "0".repeat(64),
      },
    ),
  ).rejects.toThrow();
  await storage.removeIncomplete(key);
  expect(await storage.read(key)).toBeNull();
});
