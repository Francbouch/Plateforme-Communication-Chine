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
const select = `SELECT i.*,p.name AS author,r.label AS revision_label,
(SELECT COUNT(*) FROM graphical_annotations a WHERE a.point_id=i.id AND a.annotation_deleted_at IS NULL) AS annotation_count,
(SELECT COUNT(*) FROM review_messages m WHERE m.item_id=i.id) AS comment_count,
(SELECT group_concat(page) FROM (SELECT DISTINCT a.page FROM graphical_annotations a WHERE a.point_id=i.id AND a.annotation_deleted_at IS NULL ORDER BY a.page)) AS pages
FROM review_items i JOIN profiles p ON p.id=i.created_by JOIN document_revisions r ON r.id=i.revision_id`;
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
  const project = await s.requireProject(r.project_id, true);
  void write;
  if (r.extension !== "pdf")
    throw new HttpError(400, "Review is available for PDF revisions only");
  return { ...r, organization_id: project.organization_id };
}
async function item(s: Store, itemId: string, write = false) {
  const row = await s
    .statement(`${select} WHERE i.id=? AND i.is_point=1`, itemId)
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
  const annotationSelect = `SELECT a.*,0 AS number,'' AS summary,'open' AS status,'' AS responsible,p.name AS author,r.label AS revision_label FROM graphical_annotations a JOIN profiles p ON p.id=a.created_by JOIN document_revisions r ON r.id=a.revision_id`;
  app.get("/api/v1/revisions/:revision/annotations", async (c) => {
    const s = c.get("store"),
      r = await revision(s, id(c.req.param("revision")));
    const n = parse(
        z.coerce.number().int().min(1).max(10000),
        c.req.query("page_number"),
      ),
      offset = page(c.req.query("page"));
    const rows = await s.all<Record<string, unknown>>(
      `${annotationSelect} WHERE a.revision_id=? AND a.page=? AND a.annotation_deleted_at IS NULL ORDER BY a.created_at,a.id LIMIT 101 OFFSET ?`,
      r.id,
      n,
      offset * 100,
    );
    return c.json({
      items: rows.slice(0, 100).map(hydrate),
      hasMore: rows.length > 100,
      page: offset,
    });
  });
  app.post("/api/v1/revisions/:revision/annotations", async (c) => {
    const s = c.get("store"),
      r = await revision(s, id(c.req.param("revision")), true),
      v = parse(reviewCreate, await c.req.json().catch(() => null));
    if (v.type === "discussion")
      throw new HttpError(400, "A drawing is required");
    const existing = await s
      .statement("SELECT * FROM graphical_annotations WHERE id=?", v.id)
      .first<{ revision_id: string; created_by: string }>();
    if (
      existing &&
      (existing.revision_id !== r.id || existing.created_by !== s.userId)
    )
      throw new HttpError(409, "Annotation identifier already used");
    if (!existing) {
      const g = guard(s, r.project_id);
      await s.write(
        [
          s.statement(
            `INSERT INTO graphical_annotations(id,document_id,revision_id,page,type,color,geometry,content,created_by) SELECT ?,?,?,?,?,?,?,?,? WHERE ${g.text}`,
            v.id,
            r.document_id,
            r.id,
            v.page,
            v.type,
            v.color,
            JSON.stringify(v.geometry),
            v.content,
            s.userId,
            ...g.args,
          ),
        ],
        r.organization_id,
        "annotation.created",
        v.id,
      );
    }
    return c.json(
      hydrate(
        (await s
          .statement(`${annotationSelect} WHERE a.id=?`, v.id)
          .first<Record<string, unknown>>())!,
      ),
      existing ? 200 : 201,
    );
  });
  app.patch("/api/v1/annotations/:id", async (c) => {
    const s = c.get("store"),
      aid = id(c.req.param("id")),
      old = await s
        .statement(`${annotationSelect} WHERE a.id=?`, aid)
        .first<Record<string, unknown>>();
    if (!old) throw new HttpError(404, "Annotation not found");
    const r = await revision(s, old.revision_id as string, true),
      v = parse(reviewPatch, await c.req.json().catch(() => null)),
      previous = hydrate(old);
    if (old.created_by !== s.userId)
      throw new HttpError(403, "Only the author can edit this annotation");
    if (v.version !== old.version) {
      const applied =
        v.version + 1 === old.version &&
        Object.entries(v)
          .filter(([key]) => key !== "version")
          .every(([key, value]) =>
            key === "annotation_deleted"
              ? !!old.annotation_deleted_at
              : JSON.stringify(previous[key as keyof ReviewItem]) ===
                JSON.stringify(value),
          );
      if (applied) return c.json(previous);
      throw new HttpError(409, "Annotation changed; refresh before saving");
    }
    if (old.annotation_deleted_at)
      throw new HttpError(409, "Annotation removed");
    const next = { ...previous, ...v };
    if (!validGeometry(next.type, next.geometry))
      throw new HttpError(400, "Invalid annotation geometry");
    const g = guard(s, r.project_id);
    await s.write(
      [
        s.statement(
          `UPDATE graphical_annotations SET geometry=?,color=?,content=?,annotation_deleted_at=CASE WHEN ? THEN ${time} ELSE NULL END,point_id=CASE WHEN ? THEN NULL ELSE point_id END,version=version+1,updated_at=${time} WHERE id=? AND version=? AND ${g.text}`,
          JSON.stringify(next.geometry),
          next.color,
          next.content,
          !!v.annotation_deleted,
          !!v.annotation_deleted,
          aid,
          v.version,
          ...g.args,
        ),
        ...(v.annotation_deleted && previous.point_id
          ? [
              event(
                s,
                previous.point_id,
                "annotation.removed",
                { id: aid },
                "changes()>0",
              ),
            ]
          : []),
      ],
      r.organization_id,
      "annotation.updated",
      aid,
      true,
    );
    return c.json(
      hydrate(
        (await s
          .statement(`${annotationSelect} WHERE a.id=?`, aid)
          .first<Record<string, unknown>>())!,
      ),
    );
  });
  app.post("/api/v1/revisions/:revision/annotation-links", async (c) => {
    const s = c.get("store"),
      r = await revision(s, id(c.req.param("revision")), true),
      v = parse(
        z.object({
          point_id: z.uuid().nullable(),
          annotations: z
            .array(z.object({ id: z.uuid(), version: z.number().int().min(1) }))
            .min(1)
            .max(100),
        }),
        await c.req.json().catch(() => null),
      );
    if (new Set(v.annotations.map((a) => a.id)).size !== v.annotations.length)
      throw new HttpError(400, "Duplicate annotation");
    if (v.point_id) {
      const p = await item(s, v.point_id, true);
      if (p.item.revision_id !== r.id || p.item.point_deleted_at)
        throw new HttpError(409, "Point revision mismatch");
    }
    // Validate the whole selection before an atomic batch. A failed optimistic update rolls back every link.
    const g = guard(s, r.project_id);
    const checks = `EXISTS(SELECT 1 FROM json_each(?) j WHERE json_extract(j.value,'$.id')=graphical_annotations.id AND json_extract(j.value,'$.version')=graphical_annotations.version)`;
    const selection = JSON.stringify(v.annotations);
    const match = `(SELECT COUNT(*) FROM graphical_annotations WHERE revision_id=? AND annotation_deleted_at IS NULL AND (${checks}))=?`;
    const checkArgs = [r.id, selection, v.annotations.length];
    const matched = await s
      .statement(`SELECT ${match} AS ok`, ...checkArgs)
      .first<{ ok: number }>();
    if (!matched?.ok)
      throw new HttpError(409, "Selection changed; refresh before linking");
    const oldLinks = await s.all<{ point_id: string }>(
      `SELECT DISTINCT point_id FROM graphical_annotations WHERE revision_id=? AND (${checks}) AND point_id IS NOT NULL`,
      r.id,
      selection,
    );
    await s.write(
      [
        s.statement(
          `UPDATE graphical_annotations SET point_id=?,version=version+1,updated_at=${time} WHERE revision_id=? AND annotation_deleted_at IS NULL AND (${checks}) AND ${match} AND ${g.text}`,
          v.point_id,
          r.id,
          selection,
          ...checkArgs,
          ...g.args,
        ),
        ...(v.point_id
          ? [event(s, v.point_id, "annotations.linked", v, "changes()>0")]
          : []),
        ...(oldLinks.some((p) => p.point_id !== v.point_id)
          ? [
              s.statement(
                `INSERT INTO review_events(id,item_id,actor_id,action,payload) SELECT lower(hex(randomblob(16))),j.value,?,'annotations.detached',? FROM json_each(?) j WHERE changes()>0`,
                s.userId,
                JSON.stringify(v),
                JSON.stringify(
                  oldLinks
                    .filter((p) => p.point_id !== v.point_id)
                    .map((p) => p.point_id),
                ),
              ),
            ]
          : []),
      ],
      r.organization_id,
      "annotation.links",
      v.point_id ?? r.id,
      true,
    );
    return c.json({ ok: true });
  });
  app.get("/api/v1/documents/:document/review-items", async (c) => {
    const s = c.get("store"),
      doc = id(c.req.param("document")),
      d = await s
        .statement("SELECT project_id FROM documents WHERE id=?", doc)
        .first<{ project_id: string }>();
    if (!d) throw new HttpError(404, "Document not found");
    await s.requireProject(d.project_id, true);
    const where = [
        "i.document_id=?",
        "i.is_point=1",
        "i.point_deleted_at IS NULL",
      ],
      args: unknown[] = [doc],
      q = c.req.query(),
      offset = page(q.page);
    if (q.revision_id) {
      where.push("i.revision_id=?");
      args.push(id(q.revision_id));
    }
    if (q.publication) {
      where.push("i.publication=?");
      args.push(parse(z.enum(["draft", "published"]), q.publication));
    }
    if (q.status === "cancelled") {
      where.push("i.cancelled_at IS NOT NULL");
    } else if (q.status) {
      where.push("i.status=? AND i.cancelled_at IS NULL");
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
      v = parse(
        reviewCreate.and(
          z.object({
            title: z.string().trim().min(1).max(200),
            annotation_ids: z.array(z.uuid()).max(100).default([]),
          }),
        ),
        await c.req.json().catch(() => null),
      );
    if (v.type !== "discussion")
      throw new HttpError(
        400,
        "Create drawings through the annotations endpoint",
      );
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
    if (v.annotation_ids.length) {
      const count = await s
        .statement(
          `SELECT COUNT(*) AS n FROM graphical_annotations WHERE revision_id=? AND annotation_deleted_at IS NULL AND point_id IS NULL AND id IN (SELECT value FROM json_each(?))`,
          r.id,
          JSON.stringify(v.annotation_ids),
        )
        .first<{ n: number }>();
      if (
        count?.n !== v.annotation_ids.length ||
        new Set(v.annotation_ids).size !== v.annotation_ids.length
      )
        throw new HttpError(409, "Invalid annotation selection");
    }
    const g = guard(s, r.project_id);
    const available = v.annotation_ids.length
      ? ` AND (SELECT COUNT(*) FROM graphical_annotations WHERE revision_id=? AND point_id IS NULL AND annotation_deleted_at IS NULL AND id IN (SELECT value FROM json_each(?)))=?`
      : "";
    const availableArgs = v.annotation_ids.length
      ? [r.id, JSON.stringify(v.annotation_ids), v.annotation_ids.length]
      : [];
    await s.write(
      [
        s.statement(
          `UPDATE documents SET review_counter=review_counter+1 WHERE id=? AND ${g.text}${available}`,
          r.document_id,
          ...g.args,
          ...availableArgs,
        ),
        s.statement(
          `INSERT INTO review_items(id,document_id,revision_id,number,page,type,color,geometry,content,summary,status,responsible,created_by,is_point,title,legacy_review) SELECT ?,id,?,review_counter,?,?,?,?,?,?,?,?,?,1,?,0 FROM documents WHERE id=? AND ${g.text} AND changes()>0`,
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
          v.title,
          r.document_id,
          ...g.args,
        ),
        event(s, v.id, "point.created", v, "changes()>0"),
        ...(v.annotation_ids.length
          ? [
              s.statement(
                `UPDATE graphical_annotations SET point_id=?,version=version+1 WHERE EXISTS(SELECT 1 FROM review_items WHERE id=? AND is_point=1) AND revision_id=? AND point_id IS NULL AND annotation_deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))`,
                v.id,
                v.id,
                r.id,
                JSON.stringify(v.annotation_ids),
              ),
            ]
          : []),
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
      v = parse(
        reviewPatch.and(
          z.object({
            title: z.string().trim().min(1).max(200).optional(),
            publication: z.literal("published").optional(),
            cancelled: z.literal(true).optional(),
            point_deleted: z.literal(true).optional(),
          }),
        ),
        await c.req.json().catch(() => null),
      );
    if (old.point_deleted_at) throw new HttpError(409, "Point removed");
    if (v.cancelled && old.publication !== "published")
      throw new HttpError(409, "Only published points can be cancelled");
    if (v.point_deleted && old.publication === "published")
      throw new HttpError(409, "Published points must be cancelled");
    if (v.annotation_deleted || v.geometry || v.color || v.content)
      throw new HttpError(
        400,
        "Edit drawings through the annotations endpoint",
      );
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
          `UPDATE review_items SET geometry=?,color=?,content=?,summary=?,status=?,responsible=?,annotation_deleted_at=CASE WHEN ? THEN ${time} ELSE annotation_deleted_at END,title=?,publication=?,point_deleted_at=CASE WHEN ? THEN ${time} ELSE point_deleted_at END,cancelled_at=CASE WHEN ? THEN ${time} ELSE cancelled_at END,version=version+1,updated_at=${time} WHERE id=? AND version=? AND ${g.text}`,
          JSON.stringify(next.geometry),
          next.color,
          next.content,
          next.summary,
          next.status,
          next.responsible,
          !!v.annotation_deleted,
          next.title ?? "",
          next.publication ?? "draft",
          !!v.point_deleted,
          !!v.cancelled,
          old.id,
          v.version,
          ...g.args,
        ),
        event(
          s,
          old.id,
          v.point_deleted
            ? "point.deleted"
            : v.cancelled
              ? "point.cancelled"
              : v.publication
                ? "point.published"
                : "point.updated",
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
    const linked = await s.all<Record<string, unknown>>(
      `${annotationSelect} WHERE a.point_id=? AND a.annotation_deleted_at IS NULL ORDER BY a.page,a.created_at`,
      point.id,
    );
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
      annotations: linked.map(hydrate),
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
    if (point.point_deleted_at) throw new HttpError(409, "Point removed");
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
