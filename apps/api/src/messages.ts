import { Hono } from "hono";
import { z } from "zod";
import { Store } from "./database";
import { HttpError, type Bindings, type Principal } from "./types";
import { fileTypes } from "../../../packages/shared/src/documents";
import {
  messageSchema,
  referenceSchema,
  requestSchema,
  requestStatuses,
  requestPriorities,
  type Message,
  type MessageReference,
} from "../../../packages/shared/src/messages";
type Vars = { store: Store; principal: Principal; requestId: string };
const time = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const v = schema.safeParse(input);
  if (!v.success) throw new HttpError(400, "Invalid communication data");
  return v.data;
}
function id(input: unknown) {
  return parse(z.uuid(), input);
}
function page(input: string | undefined) {
  return parse(z.coerce.number().int().min(0).max(10000), input ?? 0);
}
function guard(s: Store, project: string) {
  const g = s.scopeProject("p", true);
  return {
    text: `EXISTS(SELECT 1 FROM projects p WHERE p.id=? AND ${g.text})`,
    args: [project, ...g.args],
  };
}
function event(
  s: Store,
  project: string,
  resource: string,
  action: string,
  payload: unknown,
) {
  return s.statement(
    `INSERT INTO communication_events(id,project_id,resource_id,actor_id,action,payload) SELECT ?,?,?,?,?,? WHERE changes()>0`,
    crypto.randomUUID(),
    project,
    resource,
    s.userId,
    action,
    JSON.stringify(payload),
  );
}
async function conversation(s: Store, value: unknown, write = false) {
  const row = await s
    .statement("SELECT * FROM project_conversations WHERE id=?", id(value))
    .first<{
      id: string;
      project_id: string;
      archived: number;
      version: number;
      title: string;
    }>();
  if (!row) throw new HttpError(404, "Conversation not found");
  const p = await s.requireProject(row.project_id, true); // Internal conversations remain unavailable to supplier roles.
  if (write && row.archived) throw new HttpError(409, "Conversation archived");
  return { ...row, organization_id: p.organization_id };
}
const messageSelect = `SELECT m.*,p.name AS author,(SELECT count(*) FROM conversation_messages r WHERE r.parent_id=m.id AND (r.shared=1 OR r.author_id=?) AND r.deleted_at IS NULL) AS reply_count FROM conversation_messages m JOIN profiles p ON p.id=m.author_id`;
async function message(s: Store, value: unknown, write = false) {
  const row = await s
    .statement(
      `${messageSelect} WHERE m.id=? AND (m.shared=1 OR m.author_id=?)`,
      s.userId,
      id(value),
      s.userId,
    )
    .first<Message>();
  if (!row) throw new HttpError(404, "Message not found");
  const conv = await conversation(s, row.conversation_id, write);
  if (write && row.deleted_at) throw new HttpError(409, "Message deleted");
  return { row, conv };
}
async function hydrate(s: Store, rows: Message[]) {
  if (!rows.length) return rows;
  const marks = rows.map(() => "?").join(","),
    ids = rows.map((r) => r.id);
  const refs = await s.all<MessageReference & { message_id: string }>(
    `SELECT f.*,CASE WHEN d.id IS NULL THEN p.name ELSE COALESCE(NULLIF(d.number,''),d.name)||CASE WHEN r.id IS NULL THEN '' ELSE ' · '||r.label END||CASE WHEN f.page IS NULL THEN '' ELSE ' · p. '||f.page END||CASE WHEN i.id IS NULL THEN '' ELSE ' · #'||i.number||' '||i.title END END AS label FROM message_references f JOIN conversation_messages m ON m.id=f.message_id JOIN project_conversations c ON c.id=m.conversation_id JOIN projects p ON p.id=c.project_id LEFT JOIN documents d ON d.id=f.document_id LEFT JOIN document_revisions r ON r.id=f.revision_id LEFT JOIN review_items i ON i.id=f.point_id WHERE f.message_id IN (${marks})`,
    ...ids,
  );
  const attachments = await s.all<{
    id: string;
    message_id: string;
    filename: string;
    size: number;
    extension: string;
    content_type: string;
  }>(
    `SELECT id,message_id,filename,size,extension,content_type FROM message_attachments WHERE message_id IN (${marks}) AND state='attached'`,
    ...ids,
  );
  return rows.map((r) => ({
    ...r,
    references: refs.filter((f) => f.message_id === r.id),
    attachments: attachments.filter((f) => f.message_id === r.id),
  }));
}
async function validateReferences(
  s: Store,
  project: string,
  refs: z.infer<typeof referenceSchema>[],
) {
  if (!refs.length) return;
  // One project-scoped query for up to eight references keeps the maximal message
  // below the Free-plan per-invocation D1 query budget, even with five attachments.
  const result = await s
    .statement(
      `SELECT count(*) AS n FROM json_each(?) f
    LEFT JOIN documents d ON d.id=json_extract(f.value,'$.document_id')
    LEFT JOIN document_revisions r ON r.id=json_extract(f.value,'$.revision_id') AND r.document_id=d.id
    LEFT JOIN review_items i ON i.id=json_extract(f.value,'$.point_id') AND i.document_id=d.id AND i.revision_id=r.id
    WHERE (json_extract(f.value,'$.document_id') IS NULL OR (d.id IS NOT NULL AND d.project_id=?))
      AND (json_extract(f.value,'$.revision_id') IS NULL OR r.id IS NOT NULL)
      AND (json_extract(f.value,'$.page') IS NULL OR r.extension='pdf')
      AND (json_extract(f.value,'$.point_id') IS NULL OR (i.id IS NOT NULL AND i.is_point=1 AND i.point_deleted_at IS NULL AND (json_extract(f.value,'$.page') IS NULL OR json_extract(f.value,'$.page')=i.page)))`,
      JSON.stringify(refs),
      project,
    )
    .first<{ n: number }>();
  if (result?.n !== refs.length)
    throw new HttpError(
      400,
      "Document, revision, PDF page or technical point outside this project",
    );
}

function bucket(env: Bindings) {
  if (!env.DOCUMENTS) throw new HttpError(503, "Private storage unavailable");
  return env.DOCUMENTS;
}
type Attachment = {
  id: string;
  conversation_id: string;
  message_id: string | null;
  author_id: string;
  filename: string;
  size: number;
  extension: string;
  content_type: string;
  sha256: string;
  object_key: string;
  state: string;
  expires_at: string;
};
async function attachment(s: Store, value: unknown, upload = false) {
  const a = await s
    .statement("SELECT * FROM message_attachments WHERE id=?", id(value))
    .first<Attachment>();
  if (!a) throw new HttpError(404, "Attachment unavailable");
  const conv = await conversation(s, a.conversation_id, upload);
  if (
    upload &&
    (a.author_id !== s.userId ||
      !["pending", "ready"].includes(a.state) ||
      a.expires_at < new Date().toISOString())
  )
    throw new HttpError(409, "Attachment transfer unavailable");
  if (!upload) {
    if (!a.message_id || a.state !== "attached")
      throw new HttpError(404, "Attachment not attached to a message");
    const m = await message(s, a.message_id);
    if (m.row.deleted_at) throw new HttpError(404, "Message deleted");
  }
  return { a, conv };
}
export function communicationRoutes() {
  const app = new Hono<{ Bindings: Bindings; Variables: Vars }>();
  app.get("/api/v1/projects/:project/conversations", async (c) => {
    const s = c.get("store"),
      project = id(c.req.param("project"));
    await s.requireProject(project, true);
    const archived = parse(z.enum(["0", "1"]), c.req.query("archived") ?? "0");
    const rows = await s.all(
      `SELECT c.*,(SELECT substr(m.body,1,160) FROM conversation_messages m WHERE m.conversation_id=c.id AND m.deleted_at IS NULL AND (m.shared=1 OR m.author_id=?) ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS last_message FROM project_conversations c WHERE c.project_id=? AND c.archived=? ORDER BY c.updated_at DESC,c.id LIMIT 31 OFFSET ?`,
      s.userId,
      project,
      Number(archived),
      page(c.req.query("page")) * 30,
    );
    return c.json({ items: rows.slice(0, 30), hasMore: rows.length > 30 });
  });
  app.post("/api/v1/projects/:project/conversations", async (c) => {
    const s = c.get("store"),
      project = id(c.req.param("project")),
      p = await s.requireProject(project, true);
    const v = parse(
      z.object({ title: z.string().trim().min(1).max(160) }),
      await c.req.json().catch(() => null),
    );
    const key = crypto.randomUUID(),
      g = guard(s, project);
    await s.write(
      [
        s.statement(
          `INSERT INTO project_conversations(id,project_id,title,created_by) SELECT ?,?,?,? WHERE ${g.text}`,
          key,
          project,
          v.title,
          s.userId,
          ...g.args,
        ),
        event(s, project, key, "conversation.created", v),
      ],
      p.organization_id,
      "conversation.created",
      key,
    );
    return c.json({ id: key }, 201);
  });
  app.get("/api/v1/conversations/:id", async (c) =>
    c.json(await conversation(c.get("store"), c.req.param("id"))),
  );
  app.patch("/api/v1/conversations/:id", async (c) => {
    const s = c.get("store"),
      conv = await conversation(s, c.req.param("id"));
    const v = parse(
        z.object({
          title: z.string().trim().min(1).max(160),
          archived: z.boolean(),
          version: z.number().int().positive(),
        }),
        await c.req.json().catch(() => null),
      ),
      g = guard(s, conv.project_id);
    await s.write(
      [
        s.statement(
          `UPDATE project_conversations SET title=?,archived=?,version=version+1,updated_at=${time} WHERE id=? AND version=? AND ${g.text}`,
          v.title,
          Number(v.archived),
          conv.id,
          v.version,
          ...g.args,
        ),
        event(s, conv.project_id, conv.id, "conversation.updated", {
          before: { title: conv.title, archived: conv.archived },
          after: v,
        }),
      ],
      conv.organization_id,
      "conversation.updated",
      conv.id,
      true,
    );
    return c.json({ updated: true });
  });
  app.get("/api/v1/conversations/:id/messages", async (c) => {
    const s = c.get("store"),
      conv = await conversation(s, c.req.param("id"));
    const before = c.req.query("before") ? id(c.req.query("before")) : null;
    const rows = await s.all<Message>(
      `${messageSelect} WHERE m.conversation_id=? AND m.parent_id IS NULL AND (m.shared=1 OR m.author_id=?) AND (? IS NULL OR (m.created_at,m.id)<(SELECT created_at,id FROM conversation_messages WHERE id=? AND conversation_id=?)) ORDER BY m.created_at DESC,m.id DESC LIMIT 31`,
      s.userId,
      conv.id,
      s.userId,
      before,
      before,
      conv.id,
    );
    return c.json({
      items: await hydrate(s, rows.slice(0, 30)),
      next: rows.length > 30 ? rows[29].id : null,
    });
  });
  app.get("/api/v1/messages/:id", async (c) => {
    const s = c.get("store"),
      m = await message(s, c.req.param("id"));
    return c.json((await hydrate(s, [m.row]))[0]);
  });
  app.get("/api/v1/messages/:id/replies", async (c) => {
    const s = c.get("store"),
      m = await message(s, c.req.param("id"));
    if (m.row.parent_id) throw new HttpError(400, "Open the root thread");
    const before = c.req.query("before") ? id(c.req.query("before")) : null;
    const rows = await s.all<Message>(
      `${messageSelect} WHERE m.parent_id=? AND (m.shared=1 OR m.author_id=?) AND (? IS NULL OR (m.created_at,m.id)<(SELECT created_at,id FROM conversation_messages WHERE id=? AND parent_id=?)) ORDER BY m.created_at DESC,m.id DESC LIMIT 31`,
      s.userId,
      m.row.id,
      s.userId,
      before,
      before,
      m.row.id,
    );
    return c.json({
      items: await hydrate(s, rows.slice(0, 30)),
      next: rows.length > 30 ? rows[29].id : null,
    });
  });
  app.post("/api/v1/conversations/:id/messages", async (c) => {
    const s = c.get("store"),
      conv = await conversation(s, c.req.param("id"), true),
      v = parse(messageSchema, await c.req.json().catch(() => null));
    const existing = await s
      .statement("SELECT id FROM conversation_messages WHERE id=?", v.id)
      .first();
    if (existing) {
      const stored = (await message(s, v.id)).row;
      const rendered = (await hydrate(s, [stored]))[0];
      const links = (refs: MessageReference[]) =>
        refs
          .map(({ document_id, revision_id, point_id, page }) =>
            JSON.stringify({ document_id, revision_id, point_id, page }),
          )
          .sort();
      if (
        stored.conversation_id === conv.id &&
        stored.author_id === s.userId &&
        !stored.deleted_at &&
        stored.body === v.body &&
        stored.parent_id === v.parent_id &&
        !!stored.shared === v.shared &&
        JSON.stringify(links(rendered.references)) ===
          JSON.stringify(links(v.references)) &&
        JSON.stringify(rendered.attachments.map((a) => a.id).sort()) ===
          JSON.stringify([...v.attachments].sort())
      )
        return c.json(rendered);
      throw new HttpError(
        409,
        "Message identifier already used with different content",
      );
    }
    if (v.parent_id) {
      const parent = await message(s, v.parent_id);
      if (
        parent.row.conversation_id !== conv.id ||
        parent.row.parent_id ||
        parent.row.deleted_at
      )
        throw new HttpError(
          400,
          "Reply must belong to the root message in this conversation",
        );
    }
    await validateReferences(s, conv.project_id, v.references);
    if (new Set(v.attachments).size !== v.attachments.length)
      throw new HttpError(400, "Duplicate attachment");
    for (const key of v.attachments) {
      const a = await attachment(s, key, true);
      if (
        a.a.conversation_id !== conv.id ||
        a.a.state !== "ready" ||
        a.a.message_id
      )
        throw new HttpError(400, "Attachment not ready for this conversation");
    }
    const g = guard(s, conv.project_id),
      marks = v.attachments.map(() => "?").join(",");
    const available = v.attachments.length
      ? `AND (SELECT count(*) FROM message_attachments WHERE id IN (${marks}) AND conversation_id=? AND author_id=? AND state='ready' AND message_id IS NULL AND expires_at>?)=?`
      : "";
    const statements = [
      s.statement(
        `INSERT INTO conversation_messages(id,conversation_id,parent_id,author_id,body,shared) SELECT ?,?,?,?,?,? WHERE ${g.text} AND EXISTS(SELECT 1 FROM project_conversations WHERE id=? AND archived=0) ${available}`,
        v.id,
        conv.id,
        v.parent_id,
        s.userId,
        v.body,
        Number(v.shared),
        ...g.args,
        conv.id,
        ...(v.attachments.length
          ? [
              ...v.attachments,
              conv.id,
              s.userId,
              new Date().toISOString(),
              v.attachments.length,
            ]
          : []),
      ),
      event(s, conv.project_id, v.id, "message.created", v),
    ];
    for (const ref of v.references)
      statements.push(
        s.statement(
          "INSERT INTO message_references(id,message_id,document_id,revision_id,point_id,page) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM conversation_messages WHERE id=?)",
          crypto.randomUUID(),
          v.id,
          ref.document_id,
          ref.revision_id,
          ref.point_id,
          ref.page,
          v.id,
        ),
      );
    for (const key of v.attachments)
      statements.push(
        s.statement(
          "UPDATE message_attachments SET message_id=?,state='attached' WHERE id=? AND state='ready' AND EXISTS(SELECT 1 FROM conversation_messages WHERE id=?)",
          v.id,
          key,
          v.id,
        ),
      );
    statements.push(
      s.statement(
        `UPDATE project_conversations SET updated_at=${time} WHERE id=? AND EXISTS(SELECT 1 FROM conversation_messages WHERE id=?)`,
        conv.id,
        v.id,
      ),
    );
    await s.write(
      statements,
      conv.organization_id,
      "message.created",
      v.id,
      true,
    );
    return c.json((await hydrate(s, [(await message(s, v.id)).row]))[0], 201);
  });
  app.patch("/api/v1/messages/:id", async (c) => {
    const s = c.get("store"),
      m = await message(s, c.req.param("id"), true),
      v = parse(
        z.object({
          body: z.string().trim().min(1).max(8000),
          version: z.number().int().positive(),
          shared: z.boolean(),
        }),
        await c.req.json().catch(() => null),
      );
    if (m.row.author_id !== s.userId || (m.row.shared && !v.shared))
      throw new HttpError(403, "Only author edits; sharing cannot be reversed");
    const g = guard(s, m.conv.project_id);
    await s.write(
      [
        s.statement(
          `UPDATE conversation_messages SET body=?,shared=?,version=version+1,updated_at=${time} WHERE id=? AND version=? AND deleted_at IS NULL AND ${g.text} AND EXISTS(SELECT 1 FROM project_conversations WHERE id=? AND archived=0)`,
          v.body,
          Number(v.shared),
          m.row.id,
          v.version,
          ...g.args,
          m.conv.id,
        ),
        event(s, m.conv.project_id, m.row.id, "message.edited", {
          before: { body: m.row.body, shared: m.row.shared },
          after: v,
        }),
        s.statement(
          `UPDATE project_conversations SET updated_at=${time} WHERE id=? AND changes()>0`,
          m.conv.id,
        ),
      ],
      m.conv.organization_id,
      "message.edited",
      m.row.id,
      true,
    );
    return c.json({ updated: true });
  });
  app.delete("/api/v1/messages/:id", async (c) => {
    const s = c.get("store"),
      m = await message(s, c.req.param("id"), true),
      v = parse(
        z.object({ version: z.number().int().positive() }),
        await c.req.json().catch(() => null),
      );
    if (m.row.author_id !== s.userId || m.row.shared)
      throw new HttpError(403, "Shared decisions cannot be deleted");
    const g = guard(s, m.conv.project_id);
    await s.write(
      [
        s.statement(
          `UPDATE conversation_messages SET deleted_at=${time},version=version+1,updated_at=${time} WHERE id=? AND version=? AND shared=0 AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM technical_requests WHERE message_id=?) AND NOT EXISTS(SELECT 1 FROM approval_requests WHERE message_id=conversation_messages.id AND deleted_at IS NULL) AND NOT EXISTS(SELECT 1 FROM conversation_messages WHERE parent_id=?) AND ${g.text} AND EXISTS(SELECT 1 FROM project_conversations WHERE id=? AND archived=0)`,
          m.row.id,
          v.version,
          m.row.id,
          m.row.id,
          ...g.args,
          m.conv.id,
        ),
        event(s, m.conv.project_id, m.row.id, "message.deleted", {
          body: m.row.body,
        }),
      ],
      m.conv.organization_id,
      "message.deleted",
      m.row.id,
      true,
    );
    return c.json({ deleted: true });
  });
  app.get("/api/v1/conversations/:id/history", async (c) => {
    const s = c.get("store"),
      conv = await conversation(s, c.req.param("id"));
    const rows = await s.all(
      `SELECT e.*,p.name AS author FROM communication_events e JOIN profiles p ON p.id=e.actor_id WHERE e.project_id=? AND (e.resource_id=? OR e.resource_id IN(SELECT id FROM conversation_messages WHERE conversation_id=? AND (shared=1 OR author_id=?)) OR e.resource_id IN(SELECT t.id FROM technical_requests t JOIN conversation_messages m ON m.id=t.message_id WHERE m.conversation_id=? AND (m.shared=1 OR m.author_id=?))) ORDER BY e.created_at DESC,e.id DESC LIMIT 31 OFFSET ?`,
      conv.project_id,
      conv.id,
      conv.id,
      s.userId,
      conv.id,
      s.userId,
      page(c.req.query("page")) * 30,
    );
    return c.json({ items: rows.slice(0, 30), hasMore: rows.length > 30 });
  });
  app.get("/api/v1/projects/:project/message-search", async (c) => {
    const s = c.get("store"),
      project = id(c.req.param("project"));
    await s.requireProject(project, true);
    const q = parse(z.string().trim().min(1).max(200), c.req.query("q"));
    const rows = await s.all(
      `SELECT m.id,m.parent_id,m.conversation_id,substr(m.body,1,240) AS body,m.created_at,p.name AS author,c.title AS conversation_title FROM conversation_messages m JOIN project_conversations c ON c.id=m.conversation_id JOIN profiles p ON p.id=m.author_id WHERE c.project_id=? AND m.deleted_at IS NULL AND (m.shared=1 OR m.author_id=?) AND (instr(lower(m.body),lower(?))>0 OR instr(lower(c.title),lower(?))>0 OR EXISTS(SELECT 1 FROM message_references f LEFT JOIN documents d ON d.id=f.document_id LEFT JOIN document_revisions r ON r.id=f.revision_id LEFT JOIN review_items i ON i.id=f.point_id WHERE f.message_id=m.id AND instr(lower(COALESCE(d.name,'')||' '||COALESCE(d.number,'')||' '||COALESCE(r.label,'')||' '||COALESCE(i.title,'')),lower(?))>0)) ORDER BY m.created_at DESC,m.id DESC LIMIT 31 OFFSET ?`,
      project,
      s.userId,
      q,
      q,
      q,
      page(c.req.query("page")) * 30,
    );
    return c.json({ items: rows.slice(0, 30), hasMore: rows.length > 30 });
  });
  app.get("/api/v1/projects/:project/message-uploads", async (c) => {
    const s = c.get("store"),
      project = id(c.req.param("project"));
    await s.requireProject(project, true);
    return c.json(
      await s.all(
        "SELECT a.id,a.filename,a.size,a.state,a.expires_at,c.title AS conversation_title FROM message_attachments a JOIN project_conversations c ON c.id=a.conversation_id WHERE c.project_id=? AND a.author_id=? AND a.message_id IS NULL AND a.state IN('pending','ready') ORDER BY a.created_at LIMIT 20",
        project,
        s.userId,
      ),
    );
  });
  app.post("/api/v1/conversations/:id/attachments", async (c) => {
    const s = c.get("store"),
      conv = await conversation(s, c.req.param("id"), true);
    bucket(c.env);
    const v = parse(
      z.object({
        filename: z
          .string()
          .min(1)
          .max(240)
          .refine((v) => !/[\x00-\x1f/\\]/.test(v)),
        size: z.number().int().min(1).max(10485760),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
      await c.req.json().catch(() => null),
    );
    const extension = v.filename.split(".").pop()!.toLowerCase();
    if (!Object.hasOwn(fileTypes, extension))
      throw new HttpError(400, "Unsupported attachment type");
    const libraryMatch = await s
      .statement(
        "SELECT d.name,r.label FROM document_revisions r JOIN documents d ON d.id=r.document_id WHERE d.project_id=? AND r.sha256=? AND r.size=? LIMIT 1",
        conv.project_id,
        v.sha256,
        v.size,
      )
      .first<{ name: string; label: string }>();
    if (libraryMatch)
      throw new HttpError(
        409,
        `File already exists in project library: ${libraryMatch.name}. Insert an explicit document revision reference instead.`,
      );
    const pending = await s
      .statement(
        "SELECT count(*) AS n FROM message_attachments a JOIN project_conversations c ON c.id=a.conversation_id WHERE a.author_id=? AND c.project_id=? AND a.state IN('pending','ready')",
        s.userId,
        conv.project_id,
      )
      .first<{ n: number }>();
    if ((pending?.n ?? 0) >= 20)
      throw new HttpError(
        429,
        "Cancel unfinished attachments before uploading more",
      );
    const key = crypto.randomUUID(),
      objectKey = `organizations/${conv.organization_id}/projects/${conv.project_id}/conversations/${conv.id}/attachments/${key}`,
      g = guard(s, conv.project_id);
    await s.write(
      [
        s.statement(
          `INSERT INTO message_attachments(id,conversation_id,author_id,filename,size,extension,content_type,sha256,object_key,expires_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${g.text}`,
          key,
          conv.id,
          s.userId,
          v.filename,
          v.size,
          extension,
          fileTypes[extension],
          v.sha256,
          objectKey,
          new Date(Date.now() + 86400000).toISOString(),
          ...g.args,
        ),
      ],
      conv.organization_id,
      "message.attachment.reserved",
      key,
    );
    return c.json({ id: key }, 201);
  });
  app.put("/api/v1/message-attachments/:id/content", async (c) => {
    const s = c.get("store"),
      { a } = await attachment(s, c.req.param("id"), true),
      b = bucket(c.env);
    if (!c.req.raw.body || Number(c.req.header("Content-Length")) !== a.size)
      throw new HttpError(400, "Attachment size mismatch");
    const existing = await b.head(a.object_key);
    if (existing) {
      if (
        existing.size !== a.size ||
        hex(existing.checksums.sha256 ?? new ArrayBuffer(0)) !== a.sha256
      )
        throw new HttpError(409, "Immutable attachment conflict");
    } else {
      const stream = new FixedLengthStream(a.size),
        pump = c.req.raw.body.pipeTo(stream.writable),
        write = b.put(a.object_key, stream.readable, {
          sha256: a.sha256,
          onlyIf: { etagDoesNotMatch: "*" },
          httpMetadata: { contentType: a.content_type },
          customMetadata: { attachment: a.id },
        });
      try {
        const [, object] = await Promise.all([pump, write]);
        if (!object) throw new Error("Object conflict");
      } catch {
        await Promise.allSettled([pump, write]);
        throw new HttpError(400, "Attachment transfer or checksum failed");
      }
    }
    // Verify recognizable formats before making a new object available to messages.
    const head = await b.get(a.object_key, {
      range: { offset: 0, length: 16 },
    });
    const prefix = head
      ? new Uint8Array(await head.arrayBuffer())
      : new Uint8Array();
    const text = new TextDecoder().decode(prefix);
    const valid =
      a.extension === "pdf"
        ? text.startsWith("%PDF-")
        : a.extension === "png"
          ? prefix[0] === 137 && text.slice(1, 4) === "PNG"
          : ["jpg", "jpeg"].includes(a.extension)
            ? prefix[0] === 255 && prefix[1] === 216
            : a.extension === "webp"
              ? text.startsWith("RIFF") && text.slice(8, 12) === "WEBP"
              : ["zip", "docx", "xlsx"].includes(a.extension)
                ? text.startsWith("PK")
                : true;
    if (!valid) {
      await b.delete(a.object_key);
      throw new HttpError(400, "Attachment signature mismatch");
    }
    const result = await s
      .statement(
        "UPDATE message_attachments SET state='ready' WHERE id=? AND state IN('pending','ready')",
        a.id,
      )
      .run();
    if (!result.meta.changes) {
      const latest = await s
        .statement("SELECT state FROM message_attachments WHERE id=?", a.id)
        .first<{ state: string }>();
      if (latest?.state === "cancelled") await b.delete(a.object_key);
      throw new HttpError(409, "Transfer already attached or cancelled");
    }
    return c.json({ uploaded: true });
  });
  app.delete("/api/v1/message-attachments/:id", async (c) => {
    const s = c.get("store"),
      key = id(c.req.param("id"));
    const a = await s
      .statement(
        "SELECT * FROM message_attachments WHERE id=? AND author_id=?",
        key,
        s.userId,
      )
      .first<Attachment>();
    if (!a) throw new HttpError(404, "Attachment unavailable");
    await conversation(s, a.conversation_id);
    const changed = await s
      .statement(
        "UPDATE message_attachments SET state='cancelled' WHERE id=? AND message_id IS NULL AND state IN('pending','ready','cancelled')",
        key,
      )
      .run();
    if (!changed.meta.changes)
      throw new HttpError(409, "Attached files must be preserved");
    await bucket(c.env).delete(a.object_key);
    return c.json({ cancelled: true });
  });
  app.get("/api/v1/message-attachments/:id/content", async (c) => {
    const { a } = await attachment(c.get("store"), c.req.param("id")),
      b = bucket(c.env);
    const object = await b.get(a.object_key);
    if (!object) throw new HttpError(404, "Attachment missing from storage");
    const preview =
      ["pdf", "png", "jpg", "jpeg", "webp"].includes(a.extension) &&
      c.req.query("download") !== "1";
    return new Response(object.body, {
      headers: {
        "Content-Type": a.content_type,
        "Content-Length": String(a.size),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
      },
    });
  });
  app.post("/api/v1/messages/:id/requests", async (c) => {
    const s = c.get("store"),
      m = await message(s, c.req.param("id"), true),
      v = parse(requestSchema, await c.req.json().catch(() => null)),
      g = guard(s, m.conv.project_id);
    if (v.point_id) {
      const p = await s
        .statement(
          "SELECT i.id FROM review_items i JOIN documents d ON d.id=i.document_id WHERE i.id=? AND i.is_point=1 AND i.point_deleted_at IS NULL AND d.project_id=?",
          v.point_id,
          m.conv.project_id,
        )
        .first();
      if (!p) throw new HttpError(400, "Technical point outside project");
    }
    const key = crypto.randomUUID();
    await s.write(
      [
        s.statement(
          `INSERT INTO technical_requests(id,project_id,message_id,point_id,title,description,responsible,due_date,priority,status,created_by) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${g.text} AND EXISTS(SELECT 1 FROM conversation_messages m JOIN project_conversations c ON c.id=m.conversation_id WHERE m.id=? AND m.deleted_at IS NULL AND c.archived=0)`,
          key,
          m.conv.project_id,
          m.row.id,
          v.point_id,
          v.title,
          v.description,
          v.responsible,
          v.due_date,
          v.priority,
          v.status,
          s.userId,
          ...g.args,
          m.row.id,
        ),
        event(s, m.conv.project_id, key, "request.created", v),
      ],
      m.conv.organization_id,
      "request.created",
      key,
    );
    return c.json({ id: key }, 201);
  });
  app.get("/api/v1/projects/:project/requests", async (c) => {
    const s = c.get("store"),
      project = id(c.req.param("project"));
    await s.requireProject(project, true);
    const status = c.req.query("status")
        ? parse(z.enum(requestStatuses), c.req.query("status"))
        : "",
      priority = c.req.query("priority")
        ? parse(z.enum(requestPriorities), c.req.query("priority"))
        : "",
      q = (c.req.query("q") ?? "").slice(0, 200);
    const sort = parse(
      z.enum(["updated", "due", "priority"]),
      c.req.query("sort") ?? "updated",
    );
    const order =
      sort === "due"
        ? "t.due_date IS NULL,t.due_date"
        : sort === "priority"
          ? "CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END"
          : "t.updated_at DESC";
    const rows = await s.all(
      `SELECT t.*,m.conversation_id,COALESCE(d.name,(SELECT group_concat(name,', ') FROM (SELECT DISTINCT rd.name FROM message_references f JOIN documents rd ON rd.id=f.document_id WHERE f.message_id=t.message_id))) AS document_name FROM technical_requests t JOIN conversation_messages m ON m.id=t.message_id LEFT JOIN review_items i ON i.id=t.point_id LEFT JOIN documents d ON d.id=i.document_id WHERE t.project_id=? AND (m.shared=1 OR m.author_id=?) AND (?='' OR t.status=?) AND (?='' OR t.priority=?) AND (?='' OR instr(lower(t.title||' '||t.description||' '||t.responsible),lower(?))>0) ORDER BY ${order},t.id LIMIT 31 OFFSET ?`,
      project,
      s.userId,
      status,
      status,
      priority,
      priority,
      q,
      q,
      page(c.req.query("page")) * 30,
    );
    return c.json({ items: rows.slice(0, 30), hasMore: rows.length > 30 });
  });
  app.patch("/api/v1/requests/:id", async (c) => {
    const s = c.get("store"),
      key = id(c.req.param("id"));
    const row = await s
      .statement("SELECT * FROM technical_requests WHERE id=?", key)
      .first<{ project_id: string; message_id: string; version: number }>();
    if (!row) throw new HttpError(404, "Request not found");
    const m = await message(s, row.message_id);
    const p = await s.requireProject(row.project_id, true);
    const v = parse(
        requestSchema
          .omit({ point_id: true })
          .extend({ version: z.number().int().positive() }),
        await c.req.json().catch(() => null),
      ),
      g = guard(s, row.project_id);
    await s.write(
      [
        s.statement(
          `UPDATE technical_requests SET title=?,description=?,responsible=?,due_date=?,priority=?,status=?,version=version+1,updated_at=${time} WHERE id=? AND version=? AND ${g.text}`,
          v.title,
          v.description,
          v.responsible,
          v.due_date,
          v.priority,
          v.status,
          key,
          v.version,
          ...g.args,
        ),
        event(s, row.project_id, key, "request.updated", {
          before: row,
          after: v,
        }),
      ],
      p.organization_id,
      "request.updated",
      key,
      true,
    );
    void m;
    return c.json({ updated: true });
  });
  return app;
}
function hex(value: ArrayBuffer) {
  return Array.from(new Uint8Array(value), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
}
