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
    db = (await runtime.getD1Database("DB")) as unknown as D1Database;
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

describe("independent annotations and technical points on actual D1/R2", () => {
  async function fixture() {
    const u = await reserve();
    await content(u.id);
    return complete(u.id);
  }
  async function drawing(rev: string, type = "marker") {
    return json<import("../packages/shared/src/review").ReviewItem>(
      await req(`revisions/${rev}/annotations`, {
        id: crypto.randomUUID(),
        page: 1,
        type,
        geometry: {
          points:
            type === "marker" || type === "text"
              ? [[0.2, 0.3]]
              : [
                  [0.2, 0.3],
                  [0.5, 0.6],
                ],
        },
      }),
    );
  }
  async function point(
    rev: string,
    annotations: string[] = [],
    identifier = crypto.randomUUID(),
  ) {
    return json<import("../packages/shared/src/review").ReviewItem>(
      await req(`revisions/${rev}/review-items`, {
        id: identifier,
        page: 1,
        type: "discussion",
        geometry: { points: [] },
        title: "Move hole 2 mm",
        summary: "Manufacturing question",
        annotation_ids: annotations,
      }),
    );
  }
  async function change(id: string, data: unknown) {
    return json<import("../packages/shared/src/review").ReviewItem>(
      await req(`review-items/${id}`, data, "PATCH"),
    );
  }
  it("draws freely without consuming numbers, links three drawings to one point and preserves discussions after deletion", async () => {
    const a = await fixture(),
      drawings = [];
    for (const type of ["arrow", "rectangle", "text"])
      drawings.push(await drawing(a.revision_id, type));
    expect(
      (
        await json<{ items: unknown[] }>(
          await req(`documents/${a.id}/review-items`),
        )
      ).items,
    ).toHaveLength(0);
    expect(
      (
        await db
          .prepare("SELECT review_counter AS n FROM documents WHERE id=?")
          .bind(a.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    const p = await point(
      a.revision_id,
      drawings.map((a) => a.id),
    );
    expect(p.number).toBe(1);
    expect(p.annotation_count).toBe(3);
    expect(p.publication).toBe("draft");
    const mid = crypto.randomUUID();
    await json(
      await req(`review-items/${p.id}/messages`, {
        id: mid,
        body: "Check drilling",
      }),
    );
    await json(
      await req(
        `review-messages/${mid}`,
        { version: 1, body: "Check drilling tolerance" },
        "PATCH",
      ),
    );
    let detail = await json<{
      annotations: { id: string; version: number }[];
      messages: { body: string }[];
    }>(await req(`review-items/${p.id}`));
    expect(detail.messages[0].body).toBe("Check drilling tolerance");
    await json(
      await req(`revisions/${a.revision_id}/annotation-links`, {
        point_id: null,
        annotations: [detail.annotations[0]],
      }),
    );
    detail = await json(await req(`review-items/${p.id}`));
    expect(detail.annotations).toHaveLength(2);
    await json(
      await req(
        `annotations/${detail.annotations[0].id}`,
        { version: detail.annotations[0].version, annotation_deleted: true },
        "PATCH",
      ),
    );
    detail = await json(await req(`review-items/${p.id}`));
    expect(detail.annotations).toHaveLength(1);
    expect(detail.messages).toHaveLength(1);
    expect(await (await req(`revisions/${a.revision_id}/content`)).text()).toBe(
      new TextDecoder().decode(bytes),
    );
  });
  it("publishes, cancels, soft-deletes drafts without deleting drawings, and never reuses numbers", async () => {
    const a = await fixture(),
      ann = await drawing(a.revision_id),
      p = await point(a.revision_id, [ann.id]);
    const published = await change(p.id, {
      version: p.version,
      publication: "published",
    });
    expect(published.publication).toBe("published");
    expect(
      (
        await req(
          `review-items/${p.id}`,
          { version: published.version, point_deleted: true },
          "PATCH",
        )
      ).status,
    ).toBe(409);
    await change(p.id, { version: published.version, cancelled: true });
    const other = await point(a.revision_id);
    expect(other.number).toBe(2);
    await change(other.id, { version: other.version, point_deleted: true });
    expect(
      (
        await json<{ items: { id: string }[] }>(
          await req(`documents/${a.id}/review-items`),
        )
      ).items.map((i) => i.id),
    ).toEqual([p.id]);
    const third = await point(a.revision_id, [/* no duplicate geometry */]);
    expect(third.number).toBe(3);
    expect(
      (
        await json<{ items: unknown[] }>(
          await req(`revisions/${a.revision_id}/annotations?page_number=1`),
        )
      ).items,
    ).toHaveLength(1);
    const draft = await point(a.revision_id);
    await json(
      await req(`revisions/${a.revision_id}/annotation-links`, {
        point_id: draft.id,
        annotations: [{ id: ann.id, version: 2 }],
      }),
    );
    await change(draft.id, { version: draft.version, point_deleted: true });
    const rows = await json<{ items: { point_id: string | null }[] }>(
      await req(`revisions/${a.revision_id}/annotations?page_number=1`),
    );
    expect(rows.items[0].point_id).toBeNull();
  });
  it("isolates A/B/C/D, rejects cross-revision links, stale writes, unauthenticated and revoked access", async () => {
    const a = await fixture(),
      revisions = [a.revision_id];
    for (const label of ["B", "C", "D"]) {
      const u = await reserve({ document_id: a.id, label });
      await content(u.id);
      revisions.push((await complete(u.id)).revision_id);
    }
    const anns = [],
      points = [];
    for (const r of revisions) {
      const ann = await drawing(r);
      anns.push(ann);
      const p = await point(r, [ann.id]);
      points.push(p);
      await json(
        await req(`review-items/${p.id}/messages`, {
          id: crypto.randomUUID(),
          body: `Reply ${r}`,
        }),
      );
      await change(p.id, { version: 1, status: "waiting" });
    }
    for (let i = 0; i < revisions.length; i++) {
      const rows = await json<{ items: { id: string }[] }>(
        await req(`revisions/${revisions[i]}/annotations?page_number=1`),
      );
      expect(rows.items.map((a) => a.id)).toEqual([anns[i].id]);
    }
    expect(
      (
        await req(`revisions/${revisions[0]}/annotation-links`, {
          point_id: points[1].id,
          annotations: [{ id: anns[0].id, version: 2 }],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await req(
          `annotations/${anns[0].id}`,
          { version: 1, color: "green" },
          "PATCH",
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await runtime.dispatchFetch(
          `${origin}/api/v1/revisions/${revisions[0]}/annotations?page_number=1`,
        )
      ).status,
    ).toBe(401);
    await runtime.dispose();
    runtime = makeRuntime();
    db = (await runtime.getD1Database("DB")) as unknown as D1Database;
    expect(
      (
        await json<{ messages: unknown[] }>(
          await req(`review-items/${points[2].id}`),
        )
      ).messages,
    ).toHaveLength(1);
    await db
      .prepare(
        "UPDATE organization_memberships SET active=0 WHERE organization_id=? AND user_id=?",
      )
      .bind(org, admin)
      .run();
    expect((await req(`review-items/${points[0].id}`)).status).toBe(403);
  });
  it("keeps concurrent point numbers unique and replays a confirmed creation without duplicate links", async () => {
    const a = await fixture(),
      ann = await drawing(a.revision_id),
      identifier = crypto.randomUUID();
    const first = await point(a.revision_id, [ann.id], identifier),
      replay = await point(a.revision_id, [ann.id], identifier);
    expect(replay.id).toBe(first.id);
    expect(replay.annotation_count).toBe(1);
    const points = await Promise.all(
      Array.from({ length: 5 }, () => point(a.revision_id)),
    );
    expect(new Set([first.number, ...points.map((p) => p.number)]).size).toBe(
      6,
    );
    expect(
      (
        await db
          .prepare("SELECT review_counter AS n FROM documents WHERE id=?")
          .bind(a.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(6);
    const second = await drawing(a.revision_id);
    expect(
      (
        await req(`revisions/${a.revision_id}/annotation-links`, {
          point_id: first.id,
          annotations: [
            { id: ann.id, version: 1 },
            { id: second.id, version: 1 },
          ],
        })
      ).status,
    ).toBe(409);
    const detail = await json<{ annotations: { id: string }[] }>(
      await req(`review-items/${first.id}`),
    );
    expect(detail.annotations.map((i) => i.id)).toEqual([ann.id]);
    const changed = { version: 1, geometry: { points: [[0.5, 0.6]] } };
    const saved = await json<{ version: number }>(
      await req(`annotations/${second.id}`, changed, "PATCH"),
    );
    const retry = await json<{ version: number }>(
      await req(`annotations/${second.id}`, changed, "PATCH"),
    );
    expect(retry.version).toBe(saved.version);
  });
  it("associates one hundred drawings atomically without exceeding D1 parameter limits", async () => {
    const a = await fixture(),
      ids = Array.from({ length: 100 }, () => crypto.randomUUID());
    await db.batch(
      ids.map((id) =>
        db
          .prepare(
            "INSERT INTO graphical_annotations(id,document_id,revision_id,page,type,color,geometry,created_by) VALUES(?,?,?,1,'marker','red',?,?)",
          )
          .bind(
            id,
            a.id,
            a.revision_id,
            JSON.stringify({ points: [[0.2, 0.3]] }),
            admin,
          ),
      ),
    );
    const p = await point(a.revision_id, ids);
    expect(p.annotation_count).toBe(100);
    await json(
      await req(`revisions/${a.revision_id}/annotation-links`, {
        point_id: null,
        annotations: ids.map((id) => ({ id, version: 2 })),
      }),
    );
    const detail = await json<{
      annotations: unknown[];
      history: { action: string }[];
    }>(await req(`review-items/${p.id}`));
    expect(detail.annotations).toHaveLength(0);
    expect(
      detail.history.some((h) => h.action === "annotations.detached"),
    ).toBe(true);
  });
  it("validates drawing geometry, protects authorship and rolls back failed point history", async () => {
    const a = await fixture();
    expect(
      (
        await req(`revisions/${a.revision_id}/annotations`, {
          id: crypto.randomUUID(),
          page: 1,
          type: "marker",
          geometry: { points: [[-1, 0.2]] },
        })
      ).status,
    ).toBe(400);
    const ann = await drawing(a.revision_id),
      other = crypto.randomUUID();
    await db
      .prepare("INSERT INTO profiles(id,name) VALUES(?,?)")
      .bind(other, "Other author")
      .run();
    const foreignId = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO graphical_annotations(id,document_id,revision_id,page,type,color,geometry,created_by) VALUES(?,?,?,1,'marker','red',?,?)",
      )
      .bind(
        foreignId,
        a.id,
        a.revision_id,
        JSON.stringify({ points: [[0.1, 0.2]] }),
        other,
      )
      .run();
    expect(
      (
        await req(
          `annotations/${foreignId}`,
          { version: 1, color: "green" },
          "PATCH",
        )
      ).status,
    ).toBe(403);
    await db
      .prepare(
        "CREATE TRIGGER test_review_fail BEFORE INSERT ON review_events BEGIN SELECT RAISE(ABORT,'test history failure'); END;",
      )
      .run();
    expect(
      (
        await req(`revisions/${a.revision_id}/review-items`, {
          id: crypto.randomUUID(),
          page: 1,
          type: "discussion",
          geometry: { points: [] },
          title: "Atomic point",
          annotation_ids: [ann.id],
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await db
          .prepare("SELECT review_counter AS n FROM documents WHERE id=?")
          .bind(a.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await json<{ items: { point_id: unknown }[] }>(
          await req(`revisions/${a.revision_id}/annotations?page_number=1`),
        )
      ).items.find((i) => i.point_id)?.point_id ?? null,
    ).toBeNull();
  });
});

it("migrates a populated phase-3 copy without losing annotations, messages, histories or legacy numbers", async () => {
  const u = await reserve();
  await content(u.id);
  const a = await complete(u.id);
  const legacy = await createDatabase();
  try {
    await migrate(legacy.db, { through: "0004_pdf_review.sql" });
    for (const table of [
      "profiles",
      "organizations",
      "organization_memberships",
      "projects",
      "documents",
      "document_revisions",
    ]) {
      const columns = (
        await legacy.db
          .prepare(`PRAGMA table_info(${table})`)
          .all<{ name: string }>()
      ).results.map((c) => c.name);
      const rows = (
        await db
          .prepare(`SELECT ${columns.join(",")} FROM ${table}`)
          .all<Record<string, unknown>>()
      ).results;
      for (const row of rows)
        await legacy.db
          .prepare(
            `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
          )
          .bind(...columns.map((c) => row[c]))
          .run();
    }
    const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
    for (let i = 0; i < ids.length; i++)
      await legacy.db
        .prepare(
          "INSERT INTO review_items(id,document_id,revision_id,number,page,type,color,geometry,created_by,summary,annotation_deleted_at) VALUES(?,?,?,?,1,?,'red',?,?,?,?)",
        )
        .bind(
          ids[i],
          a.id,
          a.revision_id,
          i + 1,
          i === 3 ? "discussion" : "marker",
          JSON.stringify({ points: i === 3 ? [] : [[0.3, 0.4]] }),
          admin,
          i === 2 ? "Verify tolerance" : "",
          i === 1 ? "2026-10-30" : null,
        )
        .run();
    await legacy.db
      .prepare("UPDATE documents SET review_counter=5 WHERE id=?")
      .bind(a.id)
      .run();
    await legacy.db
      .prepare(
        "INSERT INTO review_messages(id,item_id,body,author_id) VALUES(?,?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        ids[4],
        "Significant exchange; preserve exactly",
        admin,
      )
      .run();
    await legacy.db
      .prepare(
        "INSERT INTO review_events(id,item_id,actor_id,action,payload) VALUES(?,?,?,'reply.created','{}')",
      )
      .bind(crypto.randomUUID(), ids[4], admin)
      .run();
    const before = await legacy.db
        .prepare("SELECT * FROM review_items ORDER BY id")
        .all<Record<string, unknown>>(),
      messages = await legacy.db.prepare("SELECT * FROM review_messages").all(),
      events = await legacy.db.prepare("SELECT * FROM review_events").all();
    await migrate(legacy.db, { after: "0004_pdf_review.sql" });
    const after = await legacy.db
      .prepare("SELECT * FROM review_items ORDER BY id")
      .all<Record<string, unknown>>();
    for (let i = 0; i < before.results.length; i++)
      for (const [key, value] of Object.entries(before.results[i]))
        expect(after.results[i][key]).toEqual(value);
    expect(
      (await legacy.db.prepare("SELECT * FROM review_messages").all()).results,
    ).toEqual(messages.results);
    expect(
      (await legacy.db.prepare("SELECT * FROM review_events").all()).results,
    ).toEqual(events.results);
    expect(
      (
        await legacy.db
          .prepare("SELECT COUNT(*) AS n FROM graphical_annotations")
          .first<{ n: number }>()
      )?.n,
    ).toBe(4);
    const points = (
      await legacy.db
        .prepare(
          "SELECT id,publication FROM review_items WHERE is_point=1 ORDER BY id",
        )
        .all<{ id: string; publication: string }>()
    ).results;
    expect(points.map((p) => p.id).sort()).toEqual(
      [ids[2], ids[3], ids[4]].sort(),
    );
    expect(points.every((p) => p.publication === "draft")).toBe(true);
    expect(
      (
        await legacy.db
          .prepare("SELECT point_id FROM graphical_annotations WHERE id=?")
          .bind(ids[0])
          .first<{ point_id: string | null }>()
      )?.point_id,
    ).toBeNull();
    expect(
      (
        await legacy.db
          .prepare("SELECT review_counter AS n FROM documents WHERE id=?")
          .bind(a.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(5);
  } finally {
    await legacy.runtime.dispose();
  }
});
