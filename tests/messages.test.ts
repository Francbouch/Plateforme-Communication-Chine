import type {
  Message,
  Conversation,
  TechnicalRequest,
  MessagePage,
} from "../packages/shared/src/messages";
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
  issuer = "https://communication-test.cloudflareaccess.com";
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
      d1Databases: { DB: "communication-test" },
      r2Buckets: { DOCUMENTS: "communication-files" },
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
  persistence = await mkdtemp(
    join(tmpdir(), "forgebridge-communication-test-"),
  );
  runtime = makeRuntime();
  db = (await runtime.getD1Database("DB")) as unknown as D1Database;
  storage = (await runtime.getR2Bucket("DOCUMENTS")) as unknown as R2Bucket;
  await migrate(db);
  org = (
    await json<{ id: string }>(
      await req("organizations", { name: "Communication test" }),
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
async function conv(title = "Mechanism") {
  return (
    await json<{ id: string }>(
      await req(`projects/${project}/conversations`, { title }),
    )
  ).id;
}
async function send(
  conversation: string,
  body = "Support strength",
  extra: Record<string, unknown> = {},
) {
  return json<Message>(
    await req(`conversations/${conversation}/messages`, {
      id: crypto.randomUUID(),
      body,
      ...extra,
    }),
  );
}
async function list(conversation: string, before = "") {
  return json<MessagePage<Message>>(
    await req(`conversations/${conversation}/messages?before=${before}`),
  );
}
async function reserveAttachment(
  conversation: string,
  data = bytes,
  filename = "evidence.pdf",
) {
  return json<{ id: string }>(
    await req(`conversations/${conversation}/attachments`, {
      filename,
      size: data.byteLength,
      sha256: Buffer.from(await crypto.subtle.digest("SHA-256", data)).toString(
        "hex",
      ),
    }),
  );
}
async function uploadAttachment(key: string, data = bytes) {
  return runtime.dispatchFetch(
    `${origin}/api/v1/message-attachments/${key}/content`,
    {
      method: "PUT",
      headers: {
        Origin: origin,
        "Cf-Access-Jwt-Assertion": token,
        "Content-Length": String(data.byteLength),
      },
      body: Buffer.from(data),
    },
  );
}
describe("project communication on real workerd D1/R2", () => {
  it("persists conversations, messages and replies after an actual runtime restart", async () => {
    const c = await conv(),
      m = await send(c, "Persistent industrial decision");
    await send(c, "Thickness 3 mm", { parent_id: m.id });
    expect(
      (
        await db
          .prepare("SELECT body FROM conversation_messages WHERE id=?")
          .bind(m.id)
          .first<{ body: string }>()
      )?.body,
    ).toBe(m.body);
    await runtime.dispose();
    runtime = makeRuntime();
    db = (await runtime.getD1Database("DB")) as unknown as D1Database;
    expect((await list(c)).items[0].body).toBe(m.body);
    const replies = await json<MessagePage<Message>>(
      await req(`messages/${m.id}/replies`),
    );
    expect(replies.items[0].body).toBe("Thickness 3 mm");
    const detail = await json<Conversation>(await req(`conversations/${c}`));
    expect(
      (
        await req(
          `conversations/${c}`,
          { title: "Prototype 1", archived: true, version: detail.version },
          "PATCH",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await req(`conversations/${c}/messages`, {
          id: crypto.randomUUID(),
          body: "Too late",
        })
      ).status,
    ).toBe(409);
    expect((await list(c)).items).toHaveLength(1);
    expect(
      (
        await req(
          `conversations/${c}`,
          { title: "Prototype 1", archived: false, version: detail.version },
          "PATCH",
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await req(
          `conversations/${c}`,
          {
            title: "Prototype 1",
            archived: false,
            version: detail.version + 1,
          },
          "PATCH",
        )
      ).status,
    ).toBe(200);
  });
  it("isolates conversations and bounds replies to one level", async () => {
    const a = await conv("A"),
      b = await conv("B"),
      m = await send(a),
      r = await send(a, "Reply", { parent_id: m.id });
    expect((await list(b)).items).toHaveLength(0);
    for (const [conversation, parent_id] of [
      [a, r.id],
      [b, m.id],
    ])
      expect(
        (
          await req(`conversations/${conversation}/messages`, {
            id: crypto.randomUUID(),
            body: "Wrong root",
            parent_id,
          })
        ).status,
      ).toBe(400);
    expect((await req(`messages/${r.id}/replies`)).status).toBe(400);
  });
  it("records edits and soft deletions, rejects stale saves and protects shared decisions", async () => {
    const c = await conv(),
      m = await send(c, "Original");
    const patch = { body: "Corrected", version: 1, shared: true };
    expect((await req(`messages/${m.id}`, patch, "PATCH")).status).toBe(200);
    expect((await req(`messages/${m.id}`, patch, "PATCH")).status).toBe(409);
    expect(
      (
        await req(
          `messages/${m.id}`,
          { ...patch, version: 2, shared: false },
          "PATCH",
        )
      ).status,
    ).toBe(403);
    expect(
      (await req(`messages/${m.id}`, { version: 2 }, "DELETE")).status,
    ).toBe(403);
    const events = await json<{ items: { action: string; payload: string }[] }>(
      await req(`conversations/${c}/history`),
    );
    const edit = events.items.find((e) => e.action === "message.edited");
    expect(JSON.parse(edit!.payload).before.body).toBe("Original");
    expect(
      events.items.filter((e) => e.action === "message.edited"),
    ).toHaveLength(1);
    const privateMessage = await send(c, "Mistake");
    expect(
      (await req(`messages/${privateMessage.id}`, { version: 1 }, "DELETE"))
        .status,
    ).toBe(200);
    expect(
      (await json<Message>(await req(`messages/${privateMessage.id}`)))
        .deleted_at,
    ).toBeTruthy();
    expect(
      (await req(`messages/${privateMessage.id}`, patch, "PATCH")).status,
    ).toBe(409);
    const key = await db
      .prepare("SELECT id FROM communication_events LIMIT 1")
      .first<{ id: string }>();
    await expect(
      db
        .prepare("DELETE FROM communication_events WHERE id=?")
        .bind(key!.id)
        .run(),
    ).rejects.toThrow("append-only");
  });
  it("keeps stable document/revision/page/point references across renames and validates project ownership", async () => {
    const u = await reserve();
    await content(u.id);
    const doc = await complete(u.id);
    const u2 = await reserve({ document_id: doc.id, label: "B" });
    await content(u2.id);
    await complete(u2.id);
    const point = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO review_items(id,document_id,revision_id,number,page,type,color,geometry,created_by,is_point,title) VALUES(?,?,?,1,2,'discussion','red','{}',?,1,'Metal strength')",
      )
      .bind(point, doc.id, doc.revision_id, admin)
      .run();
    const c = await conv(),
      reference = {
        document_id: doc.id,
        revision_id: doc.revision_id,
        point_id: point,
        page: 2,
      };
    const m = await send(c, "Check revision A", { references: [reference] });
    expect(m.references[0].revision_id).toBe(doc.revision_id);
    const before = (await storage.list()).objects.length;
    await req(
      `documents/${doc.id}`,
      { name: "Renamed mechanism", number: "LC-RENAMED" },
      "PATCH",
    );
    const stored = await json<Message>(await req(`messages/${m.id}`));
    expect(stored.references[0].label).toContain("LC-RENAMED");
    expect(stored.references[0].revision_id).toBe(doc.revision_id);
    expect((await storage.list()).objects).toHaveLength(before);
    const other = (
      await json<{ id: string }>(
        await req("projects", {
          organization_id: org,
          code: "OTHER",
          name: "Other",
        }),
      )
    ).id;
    const foreign = (
      await json<{ id: string }>(
        await req(`projects/${other}/conversations`, {
          title: "Other project",
        }),
      )
    ).id;
    expect(
      (
        await req(`conversations/${foreign}/messages`, {
          id: crypto.randomUUID(),
          body: "Cross project",
          references: [reference],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req(`conversations/${c}/messages`, {
          id: crypto.randomUUID(),
          body: "Bad page",
          references: [{ ...reference, page: 3 }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req(`conversations/${c}/messages`, {
          id: crypto.randomUUID(),
          body: "Wrong document",
          references: [{ ...reference, document_id: crypto.randomUUID() }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await json<{ items: Message[] }>(
          await req(`projects/${project}/message-search?q=LC-RENAMED`),
        )
      ).items[0].id,
    ).toBe(m.id);
    expect((await list(foreign)).items).toHaveLength(0);
  });
  it("uploads checksummed private attachments, preserves archived downloads and cancels only unbound objects", async () => {
    const c = await conv(),
      file = await reserveAttachment(c);
    expect((await req(`message-attachments/${file.id}/content`)).status).toBe(
      404,
    );
    expect((await uploadAttachment(file.id)).status).toBe(200);
    expect((await uploadAttachment(file.id)).status).toBe(200);
    const m = await send(c, "Evidence", { attachments: [file.id] });
    const response = await req(
      `message-attachments/${file.id}/content?download=1`,
    );
    expect(await response.text()).toBe(new TextDecoder().decode(bytes));
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(
      (await req(`message-attachments/${file.id}`, undefined, "DELETE")).status,
    ).toBe(409);
    expect((await uploadAttachment(file.id)).status).toBe(409);
    expect(
      (
        await req(`conversations/${c}/messages`, {
          id: crypto.randomUUID(),
          body: "Reuse bound",
          attachments: [file.id],
        })
      ).status,
    ).toBe(409);
    await req(
      `conversations/${c}`,
      { title: "Archived evidence", archived: true, version: 1 },
      "PATCH",
    );
    expect((await req(`message-attachments/${file.id}/content`)).status).toBe(
      200,
    );
    expect(
      (await json<Message>(await req(`messages/${m.id}`))).attachments[0].id,
    ).toBe(file.id);
    const second = await conv("Transfers"),
      pending = await reserveAttachment(second);
    await uploadAttachment(pending.id);
    expect(
      (await req(`message-attachments/${pending.id}`, undefined, "DELETE"))
        .status,
    ).toBe(200);
    expect(
      (await req(`message-attachments/${pending.id}`, undefined, "DELETE"))
        .status,
    ).toBe(200);
    expect(
      (await req(`message-attachments/${pending.id}/content`)).status,
    ).toBe(404);
    expect((await storage.list()).objects).toHaveLength(1);
  });
  it("rejects invalid attachment sizes, types, hashes, signatures and cross-conversation reuse", async () => {
    const c = await conv(),
      other = await conv("Other"),
      f = await reserveAttachment(c);
    expect(
      (await uploadAttachment(f.id, new TextEncoder().encode("bad"))).status,
    ).toBe(400);
    const sameLength = new Uint8Array(bytes.length).fill(65);
    expect((await uploadAttachment(f.id, sameLength)).status).toBe(400);
    await uploadAttachment(f.id);
    expect(
      (
        await req(`conversations/${other}/messages`, {
          id: crypto.randomUUID(),
          body: "Wrong conversation",
          attachments: [f.id],
        })
      ).status,
    ).toBe(400);
    const fake = await reserveAttachment(c, sameLength);
    expect((await uploadAttachment(fake.id, sameLength)).status).toBe(400);
    for (const filename of [
      "malware.html",
      "../evidence.pdf",
      "file.constructor",
    ])
      expect(
        (
          await req(`conversations/${c}/attachments`, {
            filename,
            size: 1,
            sha256: "0".repeat(64),
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await req(`conversations/${c}/attachments`, {
          filename: "large.pdf",
          size: 10485761,
          sha256: "0".repeat(64),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req(`conversations/${c}/messages`, {
          id: crypto.randomUUID(),
          body: "Duplicate",
          attachments: [f.id, f.id],
        })
      ).status,
    ).toBe(400);
    expect((await list(c)).items).toHaveLength(0);
  });
  it("creates traceable requests without duplicate source/point, filters and updates status optimistically", async () => {
    const c = await conv(),
      m = await send(c, "Verify metal strength");
    const body = {
      title: "Resistance",
      priority: "high",
      responsible: "Design team",
      due_date: "2026-11-12",
    };
    const r = await json<{ id: string }>(
      await req(`messages/${m.id}/requests`, body),
    );
    expect((await req(`messages/${m.id}/requests`, body)).status).toBe(409);
    expect(
      (await req(`messages/${m.id}`, { version: 1 }, "DELETE")).status,
    ).toBe(409);
    const list = await json<{ items: TechnicalRequest[] }>(
      await req(
        `projects/${project}/requests?priority=high&status=todo&q=Resistance&sort=due`,
      ),
    );
    expect(list.items[0].id).toBe(r.id);
    expect(list.items[0].message_id).toBe(m.id);
    const patch = { ...list.items[0], status: "in_progress" };
    expect((await req(`requests/${r.id}`, patch, "PATCH")).status).toBe(200);
    expect((await req(`requests/${r.id}`, patch, "PATCH")).status).toBe(409);
    expect(
      (
        await json<{ items: TechnicalRequest[] }>(
          await req(`projects/${project}/requests?status=in_progress`),
        )
      ).items,
    ).toHaveLength(1);
    expect(
      (
        await json<{ items: TechnicalRequest[] }>(
          await req(`projects/${project}/requests?status=todo`),
        )
      ).items,
    ).toHaveLength(0);
    expect(
      (await req(`messages/${m.id}/requests`, { ...body, due_date: "invalid" }))
        .status,
    ).toBe(400);
  });
  it("paginates tied timestamps without overlap and searches expressions, replies and conversation titles", async () => {
    const c = await conv("Prototype supply");
    const ids = Array.from({ length: 35 }, () => crypto.randomUUID());
    await db.batch(
      ids.map((id, i) =>
        db
          .prepare(
            "INSERT INTO conversation_messages(id,conversation_id,author_id,body,created_at) VALUES(?,?,?,?,?)",
          )
          .bind(
            id,
            c,
            admin,
            `Exact industrial phrase ${i}`,
            "2026-10-30T12:00:00.000Z",
          ),
      ),
    );
    const first = await list(c),
      second = await list(c, first.next!);
    expect(first.items).toHaveLength(30);
    expect(second.items).toHaveLength(5);
    expect(
      new Set([...first.items, ...second.items].map((m) => m.id)).size,
    ).toBe(35);
    expect(second.next).toBeNull();
    const result = await json<{ items: Message[]; hasMore: boolean }>(
      await req(
        `projects/${project}/message-search?q=Exact%20industrial%20phrase`,
      ),
    );
    expect(result.items).toHaveLength(30);
    expect(result.hasMore).toBe(true);
    const byTitle = await json<{ items: Message[] }>(
      await req(
        `projects/${project}/message-search?q=Prototype%20supply&page=1`,
      ),
    );
    expect(byTitle.items).toHaveLength(5);
    await send(c, "Answer searchable", { parent_id: first.items[0].id });
    expect(
      (
        await json<{ items: Message[] }>(
          await req(`projects/${project}/message-search?q=Answer%20searchable`),
        )
      ).items,
    ).toHaveLength(1);
    expect((await req(`projects/${project}/message-search?q=`)).status).toBe(
      400,
    );
  });
  it("enforces authentication, origin, active membership, author and private-message scope on every access", async () => {
    const c = await conv(),
      file = await reserveAttachment(c);
    await uploadAttachment(file.id);
    const m = await send(c, "Private", { attachments: [file.id] });
    expect(
      (
        await runtime.dispatchFetch(
          `${origin}/api/v1/conversations/${c}/messages`,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await req(
          `conversations/${c}/messages`,
          { id: crypto.randomUUID(), body: "CSRF" },
          "POST",
          { Origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    const other = crypto.randomUUID();
    await db
      .prepare("INSERT INTO profiles(id,name) VALUES(?,?)")
      .bind(other, "Other isolated test author")
      .run();
    const hidden = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO conversation_messages(id,conversation_id,author_id,body) VALUES(?,?,?,?)",
      )
      .bind(hidden, c, other, "Other private")
      .run();
    expect((await req(`messages/${hidden}`)).status).toBe(404);
    expect(
      (
        await json<{ items: Message[] }>(
          await req(`projects/${project}/message-search?q=Other%20private`),
        )
      ).items,
    ).toHaveLength(0);
    await db
      .prepare("UPDATE conversation_messages SET shared=1 WHERE id=?")
      .bind(hidden)
      .run();
    expect(
      (
        await req(
          `messages/${hidden}`,
          { version: 1, body: "Impersonate", shared: true },
          "PATCH",
        )
      ).status,
    ).toBe(403);
    await db
      .prepare(
        "UPDATE organization_memberships SET active=0 WHERE organization_id=? AND user_id=?",
      )
      .bind(org, admin)
      .run();
    for (const path of [
      `conversations/${c}/messages`,
      `messages/${m.id}`,
      `message-attachments/${file.id}/content`,
      `projects/${project}/requests`,
      `projects/${project}/message-search?q=Private`,
    ])
      expect((await req(path)).status).toBe(403);
  });
  it("recovers unfinished uploads after reload and allows cancelling an expired archived reservation", async () => {
    const c = await conv(),
      file = await reserveAttachment(c);
    await uploadAttachment(file.id);
    await db
      .prepare(
        "UPDATE message_attachments SET expires_at='2020-01-01T00:00:00.000Z' WHERE id=?",
      )
      .bind(file.id)
      .run();
    const pending = await json<{ id: string }[]>(
      await req(`projects/${project}/message-uploads`),
    );
    expect(pending.map((a) => a.id)).toContain(file.id);
    await req(
      `conversations/${c}`,
      { title: "Archived", archived: true, version: 1 },
      "PATCH",
    );
    expect(
      (await req(`message-attachments/${file.id}`, undefined, "DELETE")).status,
    ).toBe(200);
    expect(
      await json(await req(`projects/${project}/message-uploads`)),
    ).toEqual([]);
    expect((await storage.list()).objects).toHaveLength(0);
  });
  it("reuses a technical point once and protects message and request source identities in D1", async () => {
    const u = await reserve();
    await content(u.id);
    const doc = await complete(u.id),
      point = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO review_items(id,document_id,revision_id,number,page,type,color,geometry,created_by,is_point,title) VALUES(?,?,?,1,1,'discussion','red','{}',?,1,'Existing point')",
      )
      .bind(point, doc.id, doc.revision_id, admin)
      .run();
    const c = await conv(),
      first = await send(c, "Point one"),
      second = await send(c, "Point again");
    const request = await json<{ id: string }>(
      await req(`messages/${first.id}/requests`, {
        title: "Track existing point",
        point_id: point,
      }),
    );
    expect(
      (
        await req(`messages/${second.id}/requests`, {
          title: "Duplicate point",
          point_id: point,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM review_items WHERE is_point=1")
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    await expect(
      db
        .prepare("UPDATE technical_requests SET message_id=? WHERE id=?")
        .bind(second.id, request.id)
        .run(),
    ).rejects.toThrow("immutable");
    await expect(
      db
        .prepare("DELETE FROM conversation_messages WHERE id=?")
        .bind(first.id)
        .run(),
    ).rejects.toThrow("history");
    await req(
      `messages/${second.id}`,
      { body: "Shared", version: 1, shared: true },
      "PATCH",
    );
    await expect(
      db
        .prepare("UPDATE conversation_messages SET shared=0 WHERE id=?")
        .bind(second.id)
        .run(),
    ).rejects.toThrow("remain shared");
  });
  it("makes a lost-response retry idempotent without duplicating messages or history", async () => {
    const c = await conv(),
      payload = { id: crypto.randomUUID(), body: "One decision" };
    expect((await req(`conversations/${c}/messages`, payload)).status).toBe(
      201,
    );
    expect((await req(`conversations/${c}/messages`, payload)).status).toBe(
      200,
    );
    expect(
      (
        await req(`conversations/${c}/messages`, {
          ...payload,
          body: "Different",
        })
      ).status,
    ).toBe(409);
    expect((await list(c)).items).toHaveLength(1);
    const events = await json<{ items: { action: string }[] }>(
      await req(`conversations/${c}/history`),
    );
    expect(
      events.items.filter((e) => e.action === "message.created"),
    ).toHaveLength(1);
  });
  it("avoids copying library objects when the same file is attached locally", async () => {
    const u = await reserve();
    await content(u.id);
    await complete(u.id);
    const c = await conv(),
      count = (await storage.list()).objects.length;
    const response = await req(`conversations/${c}/attachments`, {
      filename: "same-file.pdf",
      size: bytes.byteLength,
      sha256: Buffer.from(
        await crypto.subtle.digest("SHA-256", bytes),
      ).toString("hex"),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain(
      "Insert an explicit document revision reference",
    );
    expect((await storage.list()).objects).toHaveLength(count);
    expect(
      await json(await req(`projects/${project}/message-uploads`)),
    ).toEqual([]);
  });
  it("shows the source document on a request without inventing a technical point", async () => {
    const u = await reserve();
    await content(u.id);
    const doc = await complete(u.id);
    const c = await conv(),
      m = await send(c, "Document-only request", {
        references: [{ document_id: doc.id, revision_id: doc.revision_id }],
      });
    await json(
      await req(`messages/${m.id}/requests`, {
        title: "Check source document",
      }),
    );
    const rows = await json<{ items: TechnicalRequest[] }>(
      await req(`projects/${project}/requests`),
    );
    expect(rows.items[0].document_name).toBe("Mechanism");
    expect(rows.items[0].point_id).toBeNull();
  });
});
