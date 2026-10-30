import { Hono } from "hono";
import { z } from "zod";
import { Store, projectScope } from "./database";
import { HttpError, type Bindings, type Principal } from "./types";
import {
  reviewCreate,
  reviewPatch,
  reviewStatuses,
  validGeometry,
  type ReviewItem,
} from "../../../packages/shared/src/review";
type Vars = { store: Store; principal: Principal; requestId: string };
const time = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
function id(s: string | undefined) {
  const v = z.uuid().safeParse(s);
  if (!v.success) throw new HttpError(400, "Invalid review identifier");
  return v.data;
}
function parse<T>(schema: z.ZodType<T>, v: unknown) {
  const r = schema.safeParse(v);
  if (!r.success) throw new HttpError(400, "Invalid review data");
  return r.data;
}
function page(s: string | undefined) {
  return Math.max(0, Math.min(10000, Number(s) || 0)) | 0;
}
const select = `SELECT i.*,p.name AS author,r.label AS revision_label FROM review_items i JOIN profiles p ON p.id=i.created_by JOIN document_revisions r ON r.id=i.revision_id`;
function hydrate(row: Record<string, unknown>) {
  return {
    ...row,
    geometry: JSON.parse(row.geometry as string),
  } as unknown as ReviewItem;
}
async function revision(s: Store, revisionId: string, write = false) {
  const r = await s
    .statement(
      "SELECT r.id,r.document_id,r.extension,d.project_id FROM document_revisions r JOIN documents d ON d.id=r.document_id WHERE r.id=?",
      revisionId,
    )
    .first<{
      id: string;
      document_id: string;
      project_id: string;
      extension: string;
    }>();
  if (!r) throw new HttpError(404, "Revision not found");
  const project = await s.requireProject(r.project_id, write);
  if (r.extension !== "pdf")
    throw new HttpError(400, "Review is available for PDF revisions only");
  return { ...r, organization_id: project.organization_id };
}
async function item(s: Store, itemId: string, write = false) {
  const row = await s
    .statement(`${select} WHERE i.id=?`, itemId)
    .first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, "Technical point not found");
  const r = await revision(s, row.revision_id as string, write);
  return { item: hydrate(row), scope: r };
}
function guard(s: Store, project: string) {
  const g = projectScope("p", s.userId, true);
  return {
    text: `EXISTS(SELECT 1 FROM projects p WHERE p.id=? AND ${g.text})`,
    args: [project, ...g.args],
  };
}
function event(
  s: Store,
  itemId: string,
  action: string,
  payload: unknown,
  condition = "1",
  args: unknown[] = [],
) {
  return s.statement(
    `INSERT INTO review_events(id,item_id,actor_id,action,payload) SELECT ?,?,?,?,? WHERE ${condition}`,
    crypto.randomUUID(),
    itemId,
    s.userId,
    action,
    JSON.stringify(payload),
    ...args,
  );
}
export function reviewRoutes() {
  const app = new Hono<{ Bindings: Bindings; Variables: Vars }>();
  app.get("/api/v1/revisions/:revision/annotations", async (c) => {
    const s = c.get("store"),
      r = await revision(s, id(c.req.param("revision"))),
      pageNumber = parse(
        z.coerce.number().int().min(1).max(10000),
        c.req.query("page_number"),
      ),
      offset = page(c.req.query("page"));
    const rows = await s.all<Record<string, unknown>>(
      `${select} WHERE i.revision_id=? AND i.page=? AND i.type<>'discussion' AND i.annotation_deleted_at IS NULL ORDER BY i.number LIMIT 101 OFFSET ?`,
      r.id,
      pageNumber,
      offset * 100,
    );
    return c.json({
      items: rows.slice(0, 100).map(hydrate),
      hasMore: rows.length > 100,
      page: offset,
    });
  });
  app.get("/api/v1/documents/:document/review-items", async (c) => {
    const s = c.get("store"),
      doc = id(c.req.param("document")),
      d = await s
        .statement("SELECT project_id FROM documents WHERE id=?", doc)
        .first<{ project_id: string }>();
    if (!d) throw new HttpError(404, "Document not found");
    await s.requireProject(d.project_id);
    const where = ["i.document_id=?"],
      args: unknown[] = [doc],
      q = c.req.query(),
      offset = page(q.page);
    if (q.revision_id) {
      where.push("i.revision_id=?");
      args.push(id(q.revision_id));
    }
    if (q.status) {
      where.push("i.status=?");
      args.push(parse(z.enum(reviewStatuses), q.status));
    } else if (q.hide_resolved === "1") where.push("i.status<>'resolved'");
    if (q.page_number) {
      where.push("i.page=?");
      args.push(
        parse(z.coerce.number().int().min(1).max(10000), q.page_number),
      );
    }
    const rows = await s.all<Record<string, unknown>>(
      `${select} WHERE ${where.join(" AND ")} ORDER BY i.number LIMIT 51 OFFSET ?`,
      ...args,
      offset * 50,
    );
    return c.json({
      items: rows.slice(0, 50).map(hydrate),
      hasMore: rows.length > 50,
      page: offset,
    });
  });
  app.post("/api/v1/revisions/:revision/review-items", async (c) => {
    const s = c.get("store"),
      r = await revision(s, id(c.req.param("revision")), true),
      v = parse(reviewCreate, await c.req.json().catch(() => null));
    const existing = await s
      .statement(
        "SELECT id,revision_id,created_by FROM review_items WHERE id=?",
        v.id,
      )
      .first<{ id: string; revision_id: string; created_by: string }>();
    if (existing) {
      if (existing.revision_id !== r.id || existing.created_by !== s.userId)
        throw new HttpError(409, "Review identifier already used");
      return c.json((await item(s, v.id)).item);
    }
    const g = guard(s, r.project_id);
    await s.write(
      [
        s.statement(
          `UPDATE documents SET review_counter=review_counter+1 WHERE id=? AND ${g.text}`,
          r.document_id,
          ...g.args,
        ),
        s.statement(
          `INSERT INTO review_items(id,document_id,revision_id,number,page,type,color,geometry,content,summary,status,responsible,created_by) SELECT ?,id,?,review_counter,?,?,?,?,?,?,?,?,? FROM documents WHERE id=? AND ${g.text}`,
          v.id,
          r.id,
          v.page,
          v.type,
          v.color,
          JSON.stringify(v.geometry),
          v.content,
          v.summary,
          v.status,
          v.responsible,
          s.userId,
          r.document_id,
          ...g.args,
        ),
        event(s, v.id, "point.created", v, "changes()>0"),
      ],
      r.organization_id,
      "review.created",
      v.id,
    );
    return c.json((await item(s, v.id)).item, 201);
  });
  app.patch("/api/v1/review-items/:id", async (c) => {
    const s = c.get("store"),
      { item: old, scope } = await item(s, id(c.req.param("id")), true),
      v = parse(reviewPatch, await c.req.json().catch(() => null));
    if (v.version !== old.version) {
      const fields = Object.entries(v).filter(([name]) => name !== "version");
      const alreadyApplied =
        v.version + 1 === old.version &&
        fields.every(([name, value]) =>
          name === "annotation_deleted"
            ? !!old.annotation_deleted_at
            : JSON.stringify(old[name as keyof ReviewItem]) ===
              JSON.stringify(value),
        );
      if (alreadyApplied) return c.json(old);
      throw new HttpError(409, "This point changed; refresh before saving");
    }
    if (
      old.created_by !== s.userId &&
      [v.geometry, v.summary, v.content, v.color, v.annotation_deleted].some(
        (x) => x !== undefined,
      )
    )
      throw new HttpError(
        403,
        "Only the author can edit this annotation or comment",
      );
    const next = { ...old, ...v };
    if (!validGeometry(old.type, next.geometry))
      throw new HttpError(400, "Invalid annotation geometry");
    if (
      old.annotation_deleted_at &&
      (v.geometry || v.content || v.color || v.annotation_deleted)
    )
      throw new HttpError(
        409,
        "The annotation was removed; its discussion is preserved",
      );
    if (old.type === "discussion" && v.annotation_deleted)
      throw new HttpError(400, "This point has no annotation");
    const g = guard(s, scope.project_id);
    await s.write(
      [
        s.statement(
          `UPDATE review_items SET geometry=?,color=?,content=?,summary=?,status=?,responsible=?,annotation_deleted_at=CASE WHEN ? THEN ${time} ELSE annotation_deleted_at END,version=version+1,updated_at=${time} WHERE id=? AND version=? AND ${g.text}`,
          JSON.stringify(next.geometry),
          next.color,
          next.content,
          next.summary,
          next.status,
          next.responsible,
          !!v.annotation_deleted,
          old.id,
          v.version,
          ...g.args,
        ),
        event(
          s,
          old.id,
          v.annotation_deleted ? "annotation.removed" : "point.updated",
          { before: old, after: v },
          "changes()>0",
        ),
      ],
      scope.organization_id,
      "review.updated",
      old.id,
      true,
    );
    return c.json((await item(s, old.id)).item);
  });
  app.get("/api/v1/review-items/:id", async (c) => {
    const s = c.get("store"),
      { item: point } = await item(s, id(c.req.param("id"))),
      offset = page(c.req.query("page")),
      historyOffset = page(c.req.query("history_page"));
    const messages = await s.all(
      `SELECT m.*,p.name AS author FROM review_messages m JOIN profiles p ON p.id=m.author_id WHERE m.item_id=? ORDER BY m.created_at,m.id LIMIT 51 OFFSET ?`,
      point.id,
      offset * 50,
    );
    const history = await s.all(
      `SELECT e.*,p.name AS actor FROM review_events e JOIN profiles p ON p.id=e.actor_id WHERE e.item_id=? ORDER BY e.created_at DESC,e.id DESC LIMIT 51 OFFSET ?`,
      point.id,
      historyOffset * 50,
    );
    return c.json({
      item: point,
      messages: messages.slice(0, 50),
      history: history.slice(0, 50),
      hasMoreMessages: messages.length > 50,
      hasMoreHistory: history.length > 50,
    });
  });
  app.post("/api/v1/review-items/:id/messages", async (c) => {
    const s = c.get("store"),
      { item: point, scope } = await item(s, id(c.req.param("id")), true),
      v = parse(
        z.object({ id: z.uuid(), body: z.string().trim().min(1).max(4000) }),
        await c.req.json().catch(() => null),
      );
    const existing = await s
      .statement("SELECT * FROM review_messages WHERE id=?", v.id)
      .first<{ author_id: string; item_id: string }>();
    if (existing) {
      if (existing.author_id !== s.userId || existing.item_id !== point.id)
        throw new HttpError(409, "Message identifier already used");
      return c.json(existing);
    }
    const g = guard(s, scope.project_id);
    await s.write(
      [
        s.statement(
          `INSERT INTO review_messages(id,item_id,body,author_id) SELECT ?,?,?,? WHERE ${g.text}`,
          v.id,
          point.id,
          v.body,
          s.userId,
          ...g.args,
        ),
        event(
          s,
          point.id,
          "reply.created",
          { id: v.id, body: v.body },
          "changes()>0",
        ),
      ],
      scope.organization_id,
      "review.reply.created",
      v.id,
    );
    return c.json({ id: v.id }, 201);
  });
  app.patch("/api/v1/review-messages/:id", async (c) => {
    const s = c.get("store"),
      messageId = id(c.req.param("id")),
      old = await s
        .statement("SELECT * FROM review_messages WHERE id=?", messageId)
        .first<{
          item_id: string;
          author_id: string;
          body: string;
          version: number;
        }>();
    if (!old) throw new HttpError(404, "Reply not found");
    const { scope } = await item(s, old.item_id, true);
    if (old.author_id !== s.userId)
      throw new HttpError(403, "Only the author can edit this reply");
    const v = parse(
      z.object({
        version: z.number().int().min(1),
        body: z.string().trim().min(1).max(4000),
      }),
      await c.req.json().catch(() => null),
    );
    if (v.version !== old.version) {
      if (v.version + 1 === old.version && v.body === old.body)
        return c.json({ id: messageId });
      throw new HttpError(409, "This reply changed; refresh before saving");
    }
    const g = guard(s, scope.project_id);
    await s.write(
      [
        s.statement(
          `UPDATE review_messages SET body=?,version=version+1,updated_at=${time} WHERE id=? AND version=? AND author_id=? AND ${g.text}`,
          v.body,
          messageId,
          v.version,
          s.userId,
          ...g.args,
        ),
        event(
          s,
          old.item_id,
          "reply.updated",
          { id: messageId, before: old.body, after: v.body },
          "changes()>0",
        ),
      ],
      scope.organization_id,
      "review.reply.updated",
      messageId,
      true,
    );
    return c.json({ id: messageId });
  });
  return app;
}
