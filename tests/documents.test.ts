import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createDatabase, migrate } from "./helpers/d1";
const admin = "00000000-0000-4000-8000-000000000001",
  origin = "https://workspace.example.test",
  issuer = "https://library-test.cloudflareaccess.com";
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
      contents: `import {createApp} from './apps/api/src/index';import {AccessIdentityProvider} from './apps/api/src/identity';import {createLocalJWKSet} from 'jose';export default createApp(new AccessIdentityProvider(createLocalJWKSet({keys:[${JSON.stringify({ ...jwk, kid: "test", alg: "RS256" })}]})));`,
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
function makeRuntime() {
  return new Miniflare(
    convertV4MiniflareOptions({
      resourcePersistencePath: persistence,
      modules: true,
      script,
      compatibilityDate: "2026-10-29",
      d1Databases: { DB: "library-test" },
      r2Buckets: { DOCUMENTS: "library-files" },
      bindings: {
        APP_ORIGIN: origin,
        ACCESS_ISSUER: issuer,
        ACCESS_AUD: "library",
        ADMIN_EMAIL: "library@example.test",
        ADMIN_USER_ID: admin,
      },
    }),
  );
}
beforeEach(async () => {
  persistence = await mkdtemp(join(tmpdir(), "forgebridge-library-test-"));
  runtime = makeRuntime();
  db = (await runtime.getD1Database("DB")) as unknown as D1Database;
  storage = (await runtime.getR2Bucket("DOCUMENTS")) as unknown as R2Bucket;
  await migrate(db);
  org = (
    await json<{ id: string }>(
      await req("organizations", { name: "Library test" }),
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
const bytes = new TextEncoder().encode(
  "%PDF-1.7\nnon confidential test file\n%%EOF",
);
async function reserve(extra: Record<string, unknown> = {}) {
  const sha256 = Buffer.from(
    await crypto.subtle.digest("SHA-256", bytes),
  ).toString("hex");
  return json<{ id: string; document_id: string }>(
    await req(`projects/${project}/uploads`, {
      name: "Mechanism",
      number: "LC-001",
      filename: "plan.pdf",
      size: bytes.byteLength,
      sha256,
      ...extra,
    }),
  );
}
async function content(id: string, data: Uint8Array = bytes) {
  return runtime.dispatchFetch(`${origin}/api/v1/uploads/${id}/content`, {
    method: "PUT",
    headers: {
      Origin: origin,
      "Cf-Access-Jwt-Assertion": token,
      "Content-Length": String(data.byteLength),
    },
    body: Buffer.from(data),
  });
}
async function complete(id: string) {
  return json<{ id: string; revision_id: string }>(
    await req(`uploads/${id}/complete`, {}),
  );
}
describe("document library on real workerd D1 and R2", () => {
  it("uploads private originals, retains revisions and supports ranges and immutable downloads", async () => {
    const u = await reserve();
    expect((await content(u.id)).status).toBe(200);
    const first = await complete(u.id);
    const second = await reserve({
      document_id: first.id,
      label: "B",
      change_description: "Support dimensions",
    });
    expect((await content(second.id)).status).toBe(200);
    const latest = await complete(second.id);
    const detail = await json<{ revisions: { id: string; label: string }[] }>(
      await req(`documents/${first.id}`),
    );
    expect(detail.revisions.map((r) => r.label)).toEqual(["B", "A"]);
    const original = await req(`revisions/${first.revision_id}/content`);
    expect(original.headers.get("Cache-Control")).toContain("no-store");
    expect(await original.text()).toBe(new TextDecoder().decode(bytes));
    const ranged = await req(
      `revisions/${latest.revision_id}/content`,
      undefined,
      "GET",
      { Range: "bytes=0-3" },
    );
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("%PDF");
    expect(
      (
        await req(`revisions/${latest.revision_id}/content?download=1`)
      ).headers.get("Content-Disposition"),
    ).toContain("attachment");
    const raw = await db
      .prepare("SELECT object_key FROM document_revisions WHERE id=?")
      .bind(first.revision_id)
      .first<{ object_key: string }>();
    expect((await storage.head(raw!.object_key))?.size).toBe(bytes.byteLength);
    await expect(
      db
        .prepare("UPDATE document_revisions SET label='C' WHERE id=?")
        .bind(first.revision_id)
        .run(),
    ).rejects.toThrow("immutable");
    expect(
      (
        await req(`projects/${project}/uploads`, {
          name: "Duplicate",
          filename: "other.pdf",
          size: bytes.length,
          sha256: Buffer.from(
            await crypto.subtle.digest("SHA-256", bytes),
          ).toString("hex"),
          document_id: first.id,
          label: "A",
        })
      ).status,
    ).toBe(409);
    expect((await req(`uploads/${u.id}/complete`, {})).status).toBe(200);
    await runtime.dispose();
    runtime = makeRuntime();
    expect(
      (await json<{ revisions: unknown[] }>(await req(`documents/${first.id}`)))
        .revisions,
    ).toHaveLength(2);
    expect(
      await (await req(`revisions/${first.revision_id}/content`)).text(),
    ).toBe(new TextDecoder().decode(bytes));
  });
  it("persists folders and moves, rejects cycles and cross-project destinations, records status history", async () => {
    const folder = (
      await json<{ id: string }>(
        await req(`projects/${project}/folders`, { name: "Plans" }),
      )
    ).id;
    const child = (
      await json<{ id: string }>(
        await req(`projects/${project}/folders`, {
          name: "Mechanical",
          parent_id: folder,
        }),
      )
    ).id;
    expect(
      (
        await req(
          `folders/${folder}`,
          { name: "Plans", parent_id: child },
          "PATCH",
        )
      ).status,
    ).toBe(409);
    const path = await json<{ name: string }[]>(
      await req(`folders/${child}/path`),
    );
    expect(path.map((f) => f.name)).toEqual(["Plans", "Mechanical"]);
    await expect(
      db
        .prepare("UPDATE document_folders SET parent_id=? WHERE id=?")
        .bind(child, folder)
        .run(),
    ).rejects.toThrow("folder cycle");
    const u = await reserve({ folder_id: child });
    await content(u.id);
    const d = await complete(u.id);
    await json(
      await req(
        `documents/${d.id}`,
        {
          name: "Renamed mechanism",
          number: "LC-002",
          folder_id: folder,
          status: "approved",
        },
        "PATCH",
      ),
    );
    const detail = await json<{
      document: { folder_id: string; name: string };
      history: { to_status: string }[];
    }>(await req(`documents/${d.id}`));
    expect(detail.document.name).toBe("Renamed mechanism");
    expect(detail.history[0].to_status).toBe("approved");
    const other = (
      await json<{ id: string }>(
        await req("projects", {
          organization_id: org,
          code: "OTHER",
          name: "Other project",
        }),
      )
    ).id;
    expect(
      (
        await req(`projects/${other}/folders`, {
          name: "Invalid",
          parent_id: folder,
        })
      ).status,
    ).toBe(400);
    await json(await req(`folders/${folder}/archive`, {}));
    expect(
      (
        await json<{ document: { status: string } }>(
          await req(`documents/${d.id}`),
        )
      ).document.status,
    ).toBe("archived");
    expect((await req(`revisions/${d.revision_id}/content`)).status).toBe(200);
  });
  it("filters and paginates server-side, preserves legacy projects and supports completed status", async () => {
    const u = await reserve();
    await content(u.id);
    const d = await complete(u.id);
    const find = await json<{ items: { id: string }[] }>(
      await req(
        `projects/${project}/documents?folder_id=all&q=LC-001&extension=pdf&revision=A&status=draft&sort=size`,
      ),
    );
    expect(find.items[0].id).toBe(d.id);
    expect(
      (
        await json<{ items: unknown[] }>(
          await req(`projects/${project}/documents?q=missing`),
        )
      ).items,
    ).toHaveLength(0);
    await json(
      await req("projects", {
        id: project,
        organization_id: org,
        code: "LIB",
        name: "Completed library",
        status: "completed",
      }),
    );
    const list = await json<{
      items: { status: string; document_count: number }[];
    }>(await req(`projects/search?organization_id=${org}&status=completed`));
    expect(list.items[0].status).toBe("completed");
    expect(list.items[0].document_count).toBe(1);
    const records: D1PreparedStatement[] = [];
    for (let i = 0; i < 55; i++) {
      const id = crypto.randomUUID();
      records.push(
        db
          .prepare("INSERT INTO documents(id,project_id,name) VALUES(?,?,?)")
          .bind(id, project, `Pagination fixture ${i}`),
      );
      records.push(
        db
          .prepare(
            "INSERT INTO document_revisions(id,document_id,ordinal,label,filename,extension,content_type,size,sha256,object_key,created_by) VALUES(?,?,1,'A','test.pdf','pdf','application/pdf',1,?,?,?)",
          )
          .bind(
            crypto.randomUUID(),
            id,
            "0".repeat(64),
            `pagination-fixture/${id}`,
            admin,
          ),
      );
    }
    await db.batch(records);
    const first = await json<{ items: unknown[]; hasMore: boolean }>(
      await req(`projects/${project}/documents?folder_id=all`),
    );
    const second = await json<{ items: unknown[]; hasMore: boolean }>(
      await req(`projects/${project}/documents?folder_id=all&page=1`),
    );
    expect(first.items).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(second.items).toHaveLength(6);
    expect(second.hasMore).toBe(false);
  });
  it("rejects checksum/size errors, incomplete finalization and unauthorized content requests", async () => {
    const sha = Buffer.from(
      await crypto.subtle.digest("SHA-256", bytes),
    ).toString("hex");
    for (const filename of [
      "unsafe.html",
      "unsafe.constructor",
      "unsafe.__proto__",
    ])
      expect(
        (
          await req(`projects/${project}/uploads`, {
            name: "Unsafe",
            filename,
            size: bytes.length,
            sha256: sha,
          })
        ).status,
      ).toBe(400);
    const u = await reserve();
    expect((await req(`uploads/${u.id}/complete`, {})).status).toBe(409);
    const wrong = bytes.slice();
    wrong[8] = 1;
    expect((await content(u.id, wrong)).status).toBe(400);
    expect((await content(u.id, bytes.slice(0, 5))).status).toBe(400);
    expect((await content(u.id)).status).toBe(200);
    const d = await complete(u.id);
    const unauthorized = await runtime.dispatchFetch(
      `${origin}/api/v1/revisions/${d.revision_id}/content`,
    );
    expect(unauthorized.status).toBe(401);
    expect((await req(`uploads/${u.id}`, undefined, "DELETE")).status).toBe(
      409,
    );
    const cancel = await reserve({ name: "Cancelled" });
    await content(cancel.id);
    await json(await req(`uploads/${cancel.id}`, undefined, "DELETE"));
    expect((await req(`uploads/${cancel.id}/complete`, {})).status).toBe(409);
    const otherUser = crypto.randomUUID();
    await db
      .prepare("INSERT INTO profiles(id,name) VALUES(?,?)")
      .bind(otherUser, "Other")
      .run();
    await db
      .prepare(
        "UPDATE organization_memberships SET active=0 WHERE organization_id=? AND user_id=?",
      )
      .bind(org, admin)
      .run();
    expect((await req(`documents/${d.id}`)).status).toBe(403);
    expect((await req(`revisions/${d.revision_id}/content`)).status).toBe(403);
  });
});

it("adds the library schema without losing pre-phase-2 projects or memberships", async () => {
  const legacy = await createDatabase();
  try {
    await migrate(legacy.db, { through: "0002_profile_email.sql" });
    const org = crypto.randomUUID(),
      project = crypto.randomUUID();
    await legacy.db.batch([
      legacy.db
        .prepare("INSERT INTO profiles(id,name) VALUES(?,?)")
        .bind(admin, "Existing administrator"),
      legacy.db
        .prepare("INSERT INTO organizations(id,name) VALUES(?,?)")
        .bind(org, "Existing organization"),
      legacy.db
        .prepare(
          "INSERT INTO organization_memberships(organization_id,user_id,role) VALUES(?,?,'owner')",
        )
        .bind(org, admin),
      legacy.db
        .prepare(
          "INSERT INTO projects(id,organization_id,code,name,status) VALUES(?,?,?,?,'paused')",
        )
        .bind(project, org, "EXISTING", "Existing industrial project"),
    ]);
    await migrate(legacy.db, { after: "0002_profile_email.sql" });
    const existing = await legacy.db
      .prepare(
        "SELECT name,status,COALESCE(lifecycle_status,status) AS effective FROM projects WHERE id=?",
      )
      .bind(project)
      .first();
    expect(existing).toMatchObject({
      name: "Existing industrial project",
      status: "paused",
      effective: "paused",
    });
    expect(
      (
        await legacy.db
          .prepare(
            "SELECT count(*) AS n FROM organization_memberships WHERE user_id=?",
          )
          .bind(admin)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  } finally {
    await legacy.runtime.dispose();
  }
});

describe("phase 3 review on actual workerd D1 and private R2", () => {
  it("persists numbered review items and discussions without changing original bytes", async () => {
    const upload = await reserve();
    await content(upload.id);
    const revision = await complete(upload.id);
    const meta = await json<{
      document_id: string;
      label: string;
      object_key?: string;
    }>(await req(`revisions/${revision.revision_id}`));
    expect(meta.document_id).toBe(revision.id);
    expect(meta.label).toBe("A");
    expect(meta.object_key).toBeUndefined();
    const itemId = crypto.randomUUID();
    const point = await json<{ id: string; number: number; version: number }>(
      await req(`revisions/${revision.revision_id}/review-items`, {
        id: itemId,
        page: 3,
        type: "marker",
        color: "red",
        geometry: { points: [[0.25, 0.7]] },
        summary: "Increase hole diameter to 8 mm",
      }),
    );
    expect(point.number).toBe(1);
    const replay = await json<{ number: number }>(
      await req(`revisions/${revision.revision_id}/review-items`, {
        id: itemId,
        page: 3,
        type: "marker",
        color: "red",
        geometry: { points: [[0.25, 0.7]] },
      }),
    );
    expect(replay.number).toBe(1);
    await json(
      await req(
        `review-items/${itemId}`,
        {
          version: 1,
          color: "blue",
          status: "in_progress",
          geometry: { points: [[0.3, 0.6]] },
        },
        "PATCH",
      ),
    );
    const message = crypto.randomUUID();
    await json(
      await req(`review-items/${itemId}/messages`, {
        id: message,
        body: "Changed in revision B",
      }),
    );
    await json(
      await req(
        `review-messages/${message}`,
        { version: 1, body: "Changed and verified in revision B" },
        "PATCH",
      ),
    );
    const detail = await json<{
      item: { geometry: { points: number[][] }; version: number };
      messages: { body: string; version: number }[];
      history: { action: string; payload: string }[];
    }>(await req(`review-items/${itemId}`));
    expect(detail.item.geometry.points).toEqual([[0.3, 0.6]]);
    expect(detail.messages[0]).toMatchObject({
      body: "Changed and verified in revision B",
      version: 2,
    });
    expect(
      detail.history.some(
        (e) =>
          e.action === "reply.updated" &&
          e.payload.includes("Changed in revision B"),
      ),
    ).toBe(true);
    expect(
      (
        await req(
          `review-items/${itemId}`,
          { version: 1, summary: "Stale overwrite" },
          "PATCH",
        )
      ).status,
    ).toBe(409);
    expect(
      await (await req(`revisions/${revision.revision_id}/content`)).text(),
    ).toBe(new TextDecoder().decode(bytes));
    await runtime.dispose();
    runtime = makeRuntime();
    const restored = await json<{ item: { summary: string } }>(
      await req(`review-items/${itemId}`),
    );
    expect(restored.item.summary).toBe("Increase hole diameter to 8 mm");
  });
  it("keeps historical numbers, resolved threads and independent revision spaces", async () => {
    const u = await reserve();
    await content(u.id);
    const a = await complete(u.id);
    const first = await json<{ id: string }>(
      await req(`revisions/${a.revision_id}/review-items`, {
        id: crypto.randomUUID(),
        page: 1,
        type: "rectangle",
        geometry: {
          points: [
            [0.1, 0.1],
            [0.4, 0.5],
          ],
        },
      }),
    );
    await json(
      await req(
        `review-items/${first.id}`,
        { version: 1, annotation_deleted: true },
        "PATCH",
      ),
    );
    const second = await json<{ id: string; number: number }>(
      await req(`revisions/${a.revision_id}/review-items`, {
        id: crypto.randomUUID(),
        page: 2,
        type: "marker",
        geometry: { points: [[0.7, 0.2]] },
        summary: "Check support",
      }),
    );
    expect(second.number).toBe(2);
    await json(
      await req(
        `review-items/${second.id}`,
        { version: 1, status: "resolved" },
        "PATCH",
      ),
    );
    expect(
      (
        await json<{ items: unknown[] }>(
          await req(`documents/${a.id}/review-items?hide_resolved=1`),
        )
      ).items,
    ).toHaveLength(1);
    expect(
      (
        await json<{ items: unknown[] }>(
          await req(
            `documents/${a.id}/review-items?status=resolved&page_number=2`,
          ),
        )
      ).items,
    ).toHaveLength(1);
    expect(
      (
        await json<{ items: unknown[] }>(
          await req(`revisions/${a.revision_id}/annotations?page_number=1`),
        )
      ).items,
    ).toHaveLength(0);
    const newUpload = await reserve({ document_id: a.id, label: "B" });
    await content(newUpload.id);
    const b = await complete(newUpload.id);
    expect(
      (
        await json<{ items: unknown[] }>(
          await req(`revisions/${b.revision_id}/annotations?page_number=2`),
        )
      ).items,
    ).toHaveLength(0);
    expect(
      (
        await json<{ items: unknown[] }>(
          await req(`revisions/${a.revision_id}/annotations?page_number=2`),
        )
      ).items,
    ).toHaveLength(1);
    const third = await json<{ number: number }>(
      await req(`revisions/${b.revision_id}/review-items`, {
        id: crypto.randomUUID(),
        page: 1,
        type: "discussion",
        geometry: { points: [] },
        summary: "New revision discussion",
      }),
    );
    expect(third.number).toBe(3);
    await expect(
      db.prepare("DELETE FROM review_items WHERE id=?").bind(first.id).run(),
    ).rejects.toThrow("preserved");
  });
  it("validates normalized coordinates and enforces access and authorship", async () => {
    const u = await reserve();
    await content(u.id);
    const revision = await complete(u.id);
    for (const geometry of [
      { points: [[-0.1, 0.4]] },
      { points: [[1.2, 0.5]] },
      { points: [] },
      {
        points: [
          [0.1, 0.2],
          [0.4, 0.5],
        ],
      },
    ])
      expect(
        (
          await req(`revisions/${revision.revision_id}/review-items`, {
            id: crypto.randomUUID(),
            page: 1,
            type: "marker",
            geometry,
          })
        ).status,
      ).toBe(400);
    const annotation = await json<{ id: string }>(
      await req(`revisions/${revision.revision_id}/review-items`, {
        id: crypto.randomUUID(),
        page: 1,
        type: "arrow",
        geometry: {
          points: [
            [0.1, 0.2],
            [0.4, 0.5],
          ],
        },
      }),
    );
    const other = crypto.randomUUID();
    await db
      .prepare("INSERT INTO profiles(id,name) VALUES(?,?)")
      .bind(other, "Future other author")
      .run();
    const message = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO review_messages(id,item_id,body,author_id) VALUES(?,?,?,?)",
      )
      .bind(message, annotation.id, "Another author's reply", other)
      .run();
    expect(
      (
        await req(
          `review-messages/${message}`,
          { version: 1, body: "Forbidden edit" },
          "PATCH",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await runtime.dispatchFetch(
          `${origin}/api/v1/revisions/${revision.revision_id}/annotations?page_number=1`,
        )
      ).status,
    ).toBe(401);
    await db
      .prepare(
        "UPDATE organization_memberships SET active=0 WHERE organization_id=? AND user_id=?",
      )
      .bind(org, admin)
      .run();
    expect((await req(`review-items/${annotation.id}`)).status).toBe(403);
    expect(
      (
        await req(
          `review-items/${annotation.id}`,
          { version: 1, status: "resolved" },
          "PATCH",
        )
      ).status,
    ).toBe(403);
  });
  it("rolls back review edits if immutable history cannot be written", async () => {
    const u = await reserve();
    await content(u.id);
    const revision = await complete(u.id),
      id = crypto.randomUUID();
    await db
      .prepare(
        "CREATE TRIGGER test_review_fail BEFORE INSERT ON review_events BEGIN SELECT RAISE(ABORT,'test history failure'); END;",
      )
      .run();
    expect(
      (
        await req(`revisions/${revision.revision_id}/review-items`, {
          id,
          page: 1,
          type: "marker",
          geometry: { points: [[0.5, 0.5]] },
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM review_items WHERE id=?")
          .bind(id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await db
          .prepare("SELECT review_counter FROM documents WHERE id=?")
          .bind(revision.id)
          .first<{ review_counter: number }>()
      )?.review_counter,
    ).toBe(0);
  });
});
