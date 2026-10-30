import { Hono } from "hono";
import { z } from "zod";
import { Store, projectScope } from "./database";
import { HttpError, type Bindings, type Principal } from "./types";
import { assetKey } from "./storage";
import {
  folderSchema,
  documentSchema,
  uploadSchema,
  fileTypes,
  type Folder,
} from "../../../packages/shared/src/documents";

type Vars = { store: Store; principal: Principal; requestId: string };
type Upload = {
  id: string;
  project_id: string;
  document_id: string;
  revision_id: string;
  actor_id: string;
  object_key: string;
  metadata: string;
  state: string;
  expires_at: string;
};
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
function uuid(s: string | undefined) {
  if (!z.uuid().safeParse(s).success)
    throw new HttpError(400, "Invalid identifier");
  return s!;
}
function parse<T>(schema: z.ZodType<T>, value: unknown) {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, "Invalid document data");
  return r.data;
}
function bucket(env: Bindings) {
  if (!env.DOCUMENTS)
    throw new HttpError(503, "Private R2 DOCUMENTS binding required");
  return env.DOCUMENTS;
}
function guard(store: Store, project: string) {
  const g = projectScope("p", store.userId, true);
  return {
    text: `EXISTS(SELECT 1 FROM projects p WHERE p.id=? AND ${g.text})`,
    args: [project, ...g.args],
  };
}
async function destination(
  store: Store,
  project: string,
  folder: string | null,
) {
  if (!folder) return;
  if (
    !(await store
      .statement(
        "SELECT id FROM document_folders WHERE id=? AND project_id=? AND archived=0",
        folder,
        project,
      )
      .first())
  )
    throw new HttpError(400, "Destination folder unavailable");
}
async function folderRow(store: Store, id: string, admin = true) {
  const row = await store
    .statement("SELECT * FROM document_folders WHERE id=?", id)
    .first<Folder>();
  if (!row) throw new HttpError(404, "Folder not found");
  await store.requireProject(row.project_id, admin);
  return row;
}
async function documentRow(store: Store, id: string, admin = false) {
  const row = await store
    .statement("SELECT * FROM documents WHERE id=?", id)
    .first<{ id: string; project_id: string; status: string }>();
  if (!row) throw new HttpError(404, "Document not found");
  await store.requireProject(row.project_id, admin);
  return row;
}
export function documentRoutes() {
  const app = new Hono<{ Bindings: Bindings; Variables: Vars }>();
  app.get("/api/v1/projects/:project/library", async (c) => {
    const project = uuid(c.req.param("project"));
    await c.get("store").requireProject(project);
    return c.json({
      storageReady: !!c.env.DOCUMENTS,
      maxUploadBytes: 52428800,
    });
  });
  app.get("/api/v1/projects/:project/folders", async (c) => {
    const project = uuid(c.req.param("project")),
      s = c.get("store");
    await s.requireProject(project);
    // Only one directory level is loaded; breadcrumbs resolve separately.
    const parent = c.req.query("parent_id")
      ? uuid(c.req.query("parent_id"))
      : null;
    const page =
      Math.max(0, Math.min(10000, Number(c.req.query("page")) || 0)) | 0;
    const items = await s.all(
      "SELECT * FROM document_folders WHERE project_id=? AND parent_id IS ? AND archived=0 ORDER BY name COLLATE NOCASE,id LIMIT 51 OFFSET ?",
      project,
      parent,
      page * 50,
    );
    return c.json({ items: items.slice(0, 50), hasMore: items.length > 50 });
  });
  app.get("/api/v1/folders/:id/path", async (c) => {
    const s = c.get("store"),
      row = await folderRow(s, uuid(c.req.param("id")), false);
    const items = await s.all(
      `WITH RECURSIVE parents AS (SELECT *,0 AS depth FROM document_folders WHERE id=? UNION ALL SELECT f.*,p.depth+1 FROM document_folders f JOIN parents p ON f.id=p.parent_id WHERE p.depth<100) SELECT id,name,parent_id FROM parents ORDER BY depth DESC`,
      row.id,
    );
    return c.json(items);
  });
  app.post("/api/v1/projects/:project/folders", async (c) => {
    const s = c.get("store"),
      project = uuid(c.req.param("project")),
      p = await s.requireProject(project, true);
    const v = parse(folderSchema, await c.req.json().catch(() => null));
    await destination(s, project, v.parent_id);
    const id = crypto.randomUUID(),
      g = guard(s, project);
    await s.write(
      [
        s.statement(
          `INSERT INTO document_folders(id,project_id,parent_id,name) SELECT ?,?,?,? WHERE ${g.text}`,
          id,
          project,
          v.parent_id,
          v.name,
          ...g.args,
        ),
      ],
      p.organization_id,
      "folder.created",
      id,
    );
    return c.json({ id }, 201);
  });
  app.patch("/api/v1/folders/:id", async (c) => {
    const s = c.get("store"),
      row = await folderRow(s, uuid(c.req.param("id"))),
      p = await s.requireProject(row.project_id, true);
    const v = parse(folderSchema, await c.req.json().catch(() => null));
    await destination(s, row.project_id, v.parent_id);
    if (v.parent_id) {
      const cycle = await s
        .statement(
          `WITH RECURSIVE tree(id) AS (SELECT id FROM document_folders WHERE id=? UNION SELECT f.id FROM document_folders f JOIN tree t ON f.parent_id=t.id) SELECT id FROM tree WHERE id=?`,
          row.id,
          v.parent_id,
        )
        .first();
      if (cycle)
        throw new HttpError(409, "A folder cannot be moved inside itself");
    }
    const g = guard(s, row.project_id);
    await s.write(
      [
        s.statement(
          `UPDATE document_folders SET name=?,parent_id=?,updated_at=${now} WHERE id=? AND archived=0 AND ${g.text}`,
          v.name,
          v.parent_id,
          row.id,
          ...g.args,
        ),
      ],
      p.organization_id,
      "folder.updated",
      row.id,
    );
    return c.json({ id: row.id });
  });
  app.post("/api/v1/folders/:id/archive", async (c) => {
    const s = c.get("store"),
      row = await folderRow(s, uuid(c.req.param("id"))),
      p = await s.requireProject(row.project_id, true),
      g = guard(s, row.project_id);
    const tree = `WITH RECURSIVE tree(id) AS (SELECT id FROM document_folders WHERE id=? UNION SELECT f.id FROM document_folders f JOIN tree t ON f.parent_id=t.id)`;
    await s.write(
      [
        s.statement(
          `${tree} UPDATE document_folders SET archived=1,updated_at=${now} WHERE id IN(SELECT id FROM tree) AND ${g.text}`,
          row.id,
          ...g.args,
        ),
        s.statement(
          `${tree} INSERT INTO document_mutation_actor(document_id,actor_id) SELECT id,? FROM documents WHERE folder_id IN(SELECT id FROM tree) AND ${g.text} ON CONFLICT(document_id) DO UPDATE SET actor_id=excluded.actor_id`,
          row.id,
          s.userId,
          ...g.args,
        ),
        s.statement(
          `${tree} UPDATE documents SET status='archived',updated_at=${now} WHERE folder_id IN(SELECT id FROM tree) AND ${g.text}`,
          row.id,
          ...g.args,
        ),
        s.statement(
          `UPDATE document_folders SET updated_at=${now} WHERE id=? AND ${g.text}`,
          row.id,
          ...g.args,
        ),
      ],
      p.organization_id,
      "folder.archived",
      row.id,
    );
    return c.json({ id: row.id });
  });
  app.get("/api/v1/projects/:project/documents", async (c) => {
    const s = c.get("store"),
      project = uuid(c.req.param("project"));
    await s.requireProject(project);
    const query = c.req.query(),
      page = Math.max(0, Math.min(10000, Number(query.page) || 0)) | 0;
    const where = ["d.project_id=?"],
      args: unknown[] = [project];
    if (query.folder_id !== "all") {
      where.push("d.folder_id IS ?");
      args.push(query.folder_id ? uuid(query.folder_id) : null);
    }
    if (query.status) {
      const status = parse(documentSchema.shape.status, query.status);
      where.push("d.status=?");
      args.push(status);
    } else where.push("d.status<>'archived'");
    if (query.q) {
      const q = `%${query.q.slice(0, 160).replace(/[\\%_]/g, "\\$&")}%`;
      where.push(
        "(d.name LIKE ? ESCAPE '\\' OR d.number LIKE ? ESCAPE '\\' OR r.extension LIKE ? ESCAPE '\\' OR f.name LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\')",
      );
      args.push(q, q, q, q, q);
    }
    if (query.extension) {
      where.push("r.extension=?");
      args.push(query.extension.toLowerCase().slice(0, 10));
    }
    if (query.revision) {
      where.push("r.label=?");
      args.push(query.revision.slice(0, 40));
    }
    if (query.after) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(query.after))
        throw new HttpError(400, "Invalid date");
      where.push("d.updated_at>=?");
      args.push(query.after);
    }
    const sorts: Record<string, string> = {
      name: "d.name COLLATE NOCASE",
      date: "d.updated_at",
      size: "r.size",
      type: "r.extension",
    };
    const sort = sorts[query.sort] ?? sorts.date,
      direction = query.direction === "asc" ? "ASC" : "DESC";
    const items = await s.all(
      `SELECT d.*,r.id AS revision_id,r.label,r.extension,r.size FROM documents d JOIN projects p ON p.id=d.project_id LEFT JOIN document_folders f ON f.id=d.folder_id JOIN document_revisions r ON r.document_id=d.id AND r.ordinal=(SELECT MAX(ordinal) FROM document_revisions WHERE document_id=d.id) WHERE ${where.join(" AND ")} ORDER BY ${sort} ${direction},d.id LIMIT 51 OFFSET ?`,
      ...args,
      page * 50,
    );
    return c.json({
      items: items.slice(0, 50),
      hasMore: items.length > 50,
      page,
    });
  });
  app.get("/api/v1/documents/:id", async (c) => {
    const s = c.get("store"),
      d = await documentRow(s, uuid(c.req.param("id")));
    const page =
      Math.max(0, Math.min(10000, Number(c.req.query("revision_page")) || 0)) |
      0;
    const historyPage =
      Math.max(0, Math.min(10000, Number(c.req.query("history_page")) || 0)) |
      0;
    const revisions = await s.all(
      "SELECT id,document_id,ordinal,label,change_description,filename,extension,content_type,size,sha256,created_at FROM document_revisions WHERE document_id=? ORDER BY ordinal DESC LIMIT 51 OFFSET ?",
      d.id,
      page * 50,
    );
    const history = await s.all(
      "SELECT id,from_status,to_status,created_at FROM document_status_history WHERE document_id=? ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET ?",
      d.id,
      historyPage * 50,
    );
    return c.json({
      document: d,
      revisions: revisions.slice(0, 50),
      history: history.slice(0, 50),
      hasMoreRevisions: revisions.length > 50,
      hasMoreHistory: history.length > 50,
    });
  });
  app.patch("/api/v1/documents/:id", async (c) => {
    const s = c.get("store"),
      d = await documentRow(s, uuid(c.req.param("id")), true),
      p = await s.requireProject(d.project_id, true),
      v = parse(documentSchema, await c.req.json().catch(() => null)),
      g = guard(s, d.project_id);
    await destination(s, d.project_id, v.folder_id);
    await s.write(
      [
        s.statement(
          `INSERT INTO document_mutation_actor(document_id,actor_id) SELECT ?,? WHERE ${g.text} ON CONFLICT(document_id) DO UPDATE SET actor_id=excluded.actor_id`,
          d.id,
          s.userId,
          ...g.args,
        ),
        s.statement(
          `UPDATE documents SET name=?,number=?,description=?,folder_id=?,status=?,updated_at=${now} WHERE id=? AND ${g.text}`,
          v.name,
          v.number,
          v.description,
          v.folder_id,
          v.status,
          d.id,
          ...g.args,
        ),
      ],
      p.organization_id,
      "document.updated",
      d.id,
    );
    return c.json({ id: d.id });
  });
  app.post("/api/v1/projects/:project/uploads", async (c) => {
    bucket(c.env);
    const s = c.get("store"),
      project = uuid(c.req.param("project")),
      p = await s.requireProject(project, true),
      v = parse(uploadSchema, await c.req.json().catch(() => null));
    if (v.status === "archived")
      throw new HttpError(400, "Upload a document before archiving it");
    const extension = v.filename.split(".").pop()!.toLowerCase();
    if (!Object.hasOwn(fileTypes, extension))
      throw new HttpError(400, "Unsupported file extension");
    await destination(s, project, v.folder_id);
    if (v.document_id) {
      const d = await documentRow(s, v.document_id, true);
      if (d.project_id !== project)
        throw new HttpError(403, "Project mismatch");
      if (d.status === "archived")
        throw new HttpError(
          409,
          "Restore the document before adding a revision",
        );
    }
    const abandoned = await s.all<Upload>(
      "SELECT * FROM document_uploads WHERE project_id=? AND actor_id=? AND state='pending' AND expires_at<? LIMIT 10",
      project,
      s.userId,
      new Date().toISOString(),
    );
    for (const old of abandoned) {
      const cleanupGuard = guard(s, project);
      await s.write(
        [
          s.statement(
            `UPDATE document_uploads SET state='cancelled' WHERE id=? AND state='pending' AND expires_at<? AND ${cleanupGuard.text} AND NOT EXISTS(SELECT 1 FROM document_revisions WHERE id=document_uploads.revision_id)`,
            old.id,
            new Date().toISOString(),
            ...cleanupGuard.args,
          ),
        ],
        p.organization_id,
        "upload.expired",
        old.id,
      );
      await bucket(c.env).delete(old.object_key);
    }
    const pending = await s
      .statement(
        "SELECT count(*) AS n FROM document_uploads WHERE project_id=? AND actor_id=? AND state='pending' AND expires_at>?",
        project,
        s.userId,
        new Date().toISOString(),
      )
      .first<{ n: number }>();
    if ((pending?.n ?? 0) >= 20)
      throw new HttpError(
        429,
        "Too many unfinished transfers; cancel or finish them first",
      );
    const duplicate =
      v.document_id &&
      (await s
        .statement(
          "SELECT id FROM document_revisions WHERE document_id=? AND label=?",
          v.document_id,
          v.label,
        )
        .first());
    if (duplicate) throw new HttpError(409, "Revision label already exists");
    const id = crypto.randomUUID(),
      document = v.document_id ?? crypto.randomUUID(),
      revision = crypto.randomUUID(),
      key = assetKey(
        {
          organizationId: p.organization_id,
          projectId: project,
          documentId: document,
        },
        revision,
      ),
      g = guard(s, project);
    const metadata = JSON.stringify({
      ...v,
      extension,
      content_type: fileTypes[extension],
    });
    await s.write(
      [
        s.statement(
          `INSERT INTO document_uploads(id,project_id,document_id,revision_id,actor_id,object_key,metadata,expires_at) SELECT ?,?,?,?,?,?,?,? WHERE ${g.text}`,
          id,
          project,
          document,
          revision,
          s.userId,
          key,
          metadata,
          new Date(Date.now() + 86400000).toISOString(),
          ...g.args,
        ),
      ],
      p.organization_id,
      "upload.reserved",
      id,
    );
    return c.json({ id, document_id: document }, 201);
  });
  async function upload(s: Store, id: string) {
    const row = await s
      .statement(
        "SELECT * FROM document_uploads WHERE id=? AND actor_id=?",
        id,
        s.userId,
      )
      .first<Upload>();
    if (!row) throw new HttpError(404, "Upload not found");
    await s.requireProject(row.project_id, true);
    if (
      row.state === "cancelled" ||
      (row.state === "pending" && row.expires_at < new Date().toISOString())
    )
      throw new HttpError(409, "Transfer expired or cancelled");
    return row;
  }
  app.put("/api/v1/uploads/:id/content", async (c) => {
    const s = c.get("store"),
      u = await upload(s, uuid(c.req.param("id"))),
      b = bucket(c.env),
      v = JSON.parse(u.metadata) as z.infer<typeof uploadSchema> & {
        content_type: string;
      };
    if (u.state !== "pending")
      throw new HttpError(409, "Transfer already finalized");
    if (Number(c.req.header("Content-Length")) !== v.size || !c.req.raw.body)
      throw new HttpError(400, "File size mismatch");
    const existing = await b.head(u.object_key);
    if (existing) {
      if (
        existing.size === v.size &&
        existing.checksums.sha256 &&
        hex(existing.checksums.sha256) === v.sha256
      )
        return c.json({ uploaded: true });
      throw new HttpError(409, "Immutable object conflict");
    }
    const stream = new FixedLengthStream(v.size);
    const pump = c.req.raw.body.pipeTo(stream.writable);
    const write = b.put(u.object_key, stream.readable, {
      sha256: v.sha256,
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: v.content_type },
      customMetadata: { upload: u.id },
    });
    try {
      const [, object] = await Promise.all([pump, write]);
      if (!object) throw new HttpError(409, "Object already exists");
    } catch (error) {
      await Promise.allSettled([pump, write]);
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "File transfer or SHA-256 verification failed");
    }
    const current = await s
      .statement("SELECT state FROM document_uploads WHERE id=?", u.id)
      .first<{ state: string }>();
    if (current?.state === "cancelled") {
      await b.delete(u.object_key);
      throw new HttpError(409, "Transfer cancelled");
    }
    return c.json({ uploaded: true });
  });
  app.post("/api/v1/uploads/:id/complete", async (c) => {
    const s = c.get("store"),
      u = await upload(s, uuid(c.req.param("id"))),
      b = bucket(c.env);
    if (u.state === "completed")
      return c.json({ id: u.document_id, revision_id: u.revision_id });
    const p = await s.requireProject(u.project_id, true),
      g = guard(s, u.project_id),
      v = JSON.parse(u.metadata) as z.infer<typeof uploadSchema> & {
        extension: string;
        content_type: string;
      };
    await destination(s, u.project_id, v.folder_id);
    const object = await b.head(u.object_key);
    if (
      !object ||
      object.size !== v.size ||
      !object.checksums.sha256 ||
      hex(object.checksums.sha256) !== v.sha256
    )
      throw new HttpError(
        409,
        "Verified file content required before finalization",
      );
    const statements: D1PreparedStatement[] = [];
    // Every mutation rechecks project rights in the same transactional batch.
    if (!v.document_id)
      statements.push(
        s.statement(
          `INSERT INTO documents(id,project_id,folder_id,name,number,description,status) SELECT ?,?,?,?,?,?,? WHERE ${g.text} AND EXISTS(SELECT 1 FROM document_uploads WHERE id=? AND state='pending')`,
          u.document_id,
          u.project_id,
          v.folder_id,
          v.name,
          v.number,
          v.description,
          v.status,
          ...g.args,
          u.id,
        ),
      );
    statements.push(
      s.statement(
        `INSERT INTO document_revisions(id,document_id,ordinal,label,change_description,filename,extension,content_type,size,sha256,object_key,created_by) SELECT ?,?,COALESCE((SELECT MAX(ordinal) FROM document_revisions WHERE document_id=?),0)+1,?,?,?,?,?,?,?,?,? WHERE ${g.text} AND EXISTS(SELECT 1 FROM document_uploads WHERE id=? AND state='pending') AND EXISTS(SELECT 1 FROM documents WHERE id=? AND project_id=? AND status<>'archived')`,
        u.revision_id,
        u.document_id,
        u.document_id,
        v.label,
        v.change_description,
        v.filename,
        v.extension,
        v.content_type,
        v.size,
        v.sha256,
        u.object_key,
        s.userId,
        ...g.args,
        u.id,
        u.document_id,
        u.project_id,
      ),
    );
    statements.push(
      s.statement(
        `UPDATE documents SET updated_at=${now} WHERE id=? AND ${g.text} AND EXISTS(SELECT 1 FROM document_revisions WHERE id=?)`,
        u.document_id,
        ...g.args,
        u.revision_id,
      ),
    );
    statements.push(
      s.statement(
        `UPDATE document_uploads SET state='completed' WHERE id=? AND state='pending' AND ${g.text} AND EXISTS(SELECT 1 FROM document_revisions WHERE id=?)`,
        u.id,
        ...g.args,
        u.revision_id,
      ),
    );
    await s.write(
      statements,
      p.organization_id,
      "document.revision.created",
      u.document_id,
    );
    return c.json({ id: u.document_id, revision_id: u.revision_id }, 201);
  });
  app.delete("/api/v1/uploads/:id", async (c) => {
    const s = c.get("store"),
      u = await upload(s, uuid(c.req.param("id")));
    if (u.state === "completed")
      throw new HttpError(409, "Finalized revisions cannot be deleted");
    const p = await s.requireProject(u.project_id, true),
      g = guard(s, u.project_id);
    await s.write(
      [
        s.statement(
          `UPDATE document_uploads SET state='cancelled' WHERE id=? AND state='pending' AND ${g.text}`,
          u.id,
          ...g.args,
        ),
      ],
      p.organization_id,
      "upload.cancelled",
      u.id,
    );
    await bucket(c.env).delete(u.object_key);
    return c.json({ cancelled: true });
  });
  app.get("/api/v1/revisions/:id/content", async (c) => {
    const s = c.get("store"),
      id = uuid(c.req.param("id")),
      r = await s
        .statement("SELECT * FROM document_revisions WHERE id=?", id)
        .first<{
          document_id: string;
          object_key: string;
          size: number;
          filename: string;
          content_type: string;
          extension: string;
        }>();
    if (!r) throw new HttpError(404, "Revision not found");
    await documentRow(s, r.document_id);
    const b = bucket(c.env),
      range = c.req.header("Range");
    // PDF.js can request byte ranges; authenticate every request and never redirect to R2.
    let options: R2GetOptions | undefined;
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${r.size}` },
        });
      const start = Number(m[1]),
        end = m[2] ? Math.min(Number(m[2]), r.size - 1) : r.size - 1;
      if (start > end || start >= r.size)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${r.size}` },
        });
      options = { range: { offset: start, length: end - start + 1 } };
    }
    const object = await b.get(r.object_key, options);
    if (!object) throw new HttpError(404, "File not found in storage");
    const headers = new Headers({
      "Content-Type": r.content_type,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    headers.set(
      "Content-Disposition",
      `${c.req.query("download") === "1" || !["pdf", "png", "jpg", "jpeg", "webp"].includes(r.extension) ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(r.filename)}`,
    );
    if (object.range && "offset" in object.range) {
      const offset = object.range.offset ?? 0,
        length = object.range.length ?? r.size;
      headers.set(
        "Content-Range",
        `bytes ${offset}-${offset + length - 1}/${r.size}`,
      );
      headers.set("Content-Length", String(length));
    } else headers.set("Content-Length", String(r.size));
    return new Response(object.body, { status: options ? 206 : 200, headers });
  });
  return app;
}
function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
