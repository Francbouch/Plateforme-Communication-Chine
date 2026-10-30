import { Hono, type Context } from "hono";
import { Store } from "./database";
import { HttpError, type Bindings, type Principal } from "./types";
import {
  membership,
  visibleProjects,
  documentAccess,
  revisionAccess,
  pointAccess,
  conversationAccess,
  messageAccess,
  approvalAccess,
  unavailable,
} from "./access-control";
import type { Permission } from "../../../packages/shared/src/access";
import { valid } from "./access-routes";
import { z } from "zod";
type Vars = { store: Store; principal: Principal; requestId: string };
type C = Context<{ Bindings: Bindings; Variables: Vars }>;
const page = (c: C) =>
  valid(z.coerce.number().int().min(0).max(10000), c.req.query("page") ?? 0);
const docsVisible = `(?=0 OR (d.externally_shared=1 AND EXISTS(SELECT 1 FROM revision_shares rs WHERE rs.revision_id=r.id)))`;
const revisionColumns =
  "r.id,r.document_id,r.ordinal,r.label,r.change_description,r.filename,r.extension,r.content_type,r.size,r.sha256,r.created_at";
async function list(c: C, sql: string, args: unknown[]) {
  const rows = await c.get("store").all(sql, ...args, page(c) * 30);
  return c.json({
    items: rows.slice(0, 30),
    hasMore: rows.length > 30,
    page: page(c),
  });
}
export function collaborationRoutes() {
  const app = new Hono<{ Bindings: Bindings; Variables: Vars }>();
  app.get("/projects", async (c) =>
    c.json(await visibleProjects(c.get("store"))),
  );
  app.get("/projects/:project/documents", async (c) => {
    const s = c.get("store"),
      a = await membership(s, c.req.param("project"), "view_documents"),
      q = (c.req.query("q") ?? "").slice(0, 160);
    return list(
      c,
      `SELECT d.id,d.name,d.number,d.description,${revisionColumns},r.id AS revision_id,d.id AS id FROM documents d JOIN document_revisions r ON r.document_id=d.id WHERE d.project_id=? AND ${docsVisible} AND d.status<>'archived' AND (?='' OR instr(lower(d.name||' '||d.number),lower(?))>0) AND r.ordinal=(SELECT MAX(x.ordinal) FROM document_revisions x WHERE x.document_id=d.id AND (?=0 OR EXISTS(SELECT 1 FROM revision_shares rs WHERE rs.revision_id=x.id))) ORDER BY d.updated_at DESC,d.id LIMIT 31 OFFSET ?`,
      [a.id, Number(a.external), q, q, Number(a.external)],
    );
  });
  app.get("/documents/:id", async (c) => {
    const s = c.get("store"),
      d = await documentAccess(s, c.req.param("id"));
    const revisions = await s.all(
      `SELECT ${revisionColumns} FROM document_revisions r WHERE document_id=? AND (?=0 OR EXISTS(SELECT 1 FROM revision_shares WHERE revision_id=r.id)) ORDER BY ordinal DESC LIMIT 31 OFFSET ?`,
      d.document.id,
      Number(d.access.external),
      page(c) * 30,
    );
    const { externally_shared, ...document } = d.document;
    void externally_shared;
    return c.json({
      document,
      revisions: revisions.slice(0, 30),
      hasMore: revisions.length > 30,
    });
  });
  app.get("/revisions/:id", async (c) => {
    const r = await revisionAccess(c.get("store"), c.req.param("id"));
    const { object_key, created_by, ...revision } =
      r.revision as typeof r.revision & {
        object_key?: string;
        created_by?: string;
      };
    void object_key;
    void created_by;
    return c.json(revision);
  });
  app.get("/revisions/:id/content", async (c) => {
    const r = await revisionAccess(
      c.get("store"),
      c.req.param("id"),
      "download_documents",
    );
    const revision = r.revision as typeof r.revision & {
      object_key: string;
      filename: string;
      content_type: string;
      extension: string;
    };
    if (!c.env.DOCUMENTS) throw new HttpError(503, "R2 unavailable");
    const object = await c.env.DOCUMENTS.get(revision.object_key);
    if (!object) throw unavailable();
    return new Response(object.body, {
      headers: {
        "Content-Type": revision.content_type,
        "Content-Disposition": `${c.req.query("download") === "1" || !["pdf", "png", "jpg", "jpeg", "webp"].includes(revision.extension) ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(revision.filename)}`,
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  app.get("/revisions/:id/points", async (c) => {
    const s = c.get("store"),
      r = await revisionAccess(s, c.req.param("id"));
    return list(
      c,
      `SELECT i.id,i.title,i.summary,i.status,i.page,i.number,i.publication,i.version,i.revision_id,i.document_id,p.name AS author FROM review_items i JOIN profiles p ON p.id=i.created_by WHERE i.revision_id=? AND i.is_point=1 AND i.point_deleted_at IS NULL AND (?=0 OR i.publication='published') ORDER BY i.number LIMIT 31 OFFSET ?`,
      [r.revision.id, Number(r.access.external)],
    );
  });
  app.get("/review-items/:id/messages", async (c) => {
    const s = c.get("store"),
      r = await pointAccess(s, c.req.param("id"));
    return list(
      c,
      "SELECT m.id,m.body,m.author_id,m.created_at,m.version,p.name AS author FROM review_messages m JOIN profiles p ON p.id=m.author_id WHERE item_id=? ORDER BY m.created_at,m.id LIMIT 31 OFFSET ?",
      [r.point.id],
    );
  });
  app.get("/revisions/:id/annotations", async (c) => {
    const s = c.get("store"),
      r = await revisionAccess(s, c.req.param("id"));
    const rows = await s.all<{ geometry: string }>(
      `SELECT a.id,a.type,a.color,a.geometry,a.content,a.page,a.version,a.point_id,a.revision_id,a.document_id,a.created_by FROM graphical_annotations a LEFT JOIN review_items i ON i.id=a.point_id WHERE a.revision_id=? AND a.annotation_deleted_at IS NULL AND (?=0 OR (i.publication='published' AND i.point_deleted_at IS NULL)) AND a.page=? ORDER BY a.created_at,a.id LIMIT 31 OFFSET ?`,
      r.revision.id,
      Number(r.access.external),
      Number(c.req.query("page_number")) || 1,
      page(c) * 30,
    );
    return c.json({
      items: rows
        .slice(0, 30)
        .map((a) => ({ ...a, geometry: JSON.parse(a.geometry) })),
      hasMore: rows.length > 30,
      page: page(c),
    });
  });
  app.get("/projects/:project/conversations", async (c) => {
    const a = await membership(
      c.get("store"),
      c.req.param("project"),
      "view_conversations",
    );
    return list(
      c,
      "SELECT id,title,archived,externally_shared FROM project_conversations WHERE project_id=? AND (?=0 OR externally_shared=1) ORDER BY updated_at DESC,id LIMIT 31 OFFSET ?",
      [a.id, Number(a.external)],
    );
  });
  app.get("/conversations/:id/messages", async (c) => {
    const s = c.get("store"),
      r = await conversationAccess(s, c.req.param("id")),
      q = (c.req.query("q") ?? "").slice(0, 160);
    const rows = await s.all<{ id: string }>(
      `SELECT m.id,m.body,m.author_id,m.parent_id,m.created_at,m.version,m.shared,p.name AS author FROM conversation_messages m JOIN profiles p ON p.id=m.author_id WHERE conversation_id=? AND deleted_at IS NULL AND (shared=1 OR (author_id=? AND ?=0)) AND (?='' OR instr(lower(body),lower(?))>0) ORDER BY m.created_at DESC,m.id DESC LIMIT 31 OFFSET ?`,
      r.conversation.id,
      s.userId,
      Number(r.access.external),
      q,
      q,
      page(c) * 30,
    );
    const items = [];
    for (const m of rows.slice(0, 30)) {
      const files = await s.all(
        "SELECT id,filename,size,extension FROM message_attachments WHERE message_id=? AND state='attached'",
        m.id,
      );
      const refs = await s.all<{
        document_id: string | null;
        revision_id: string | null;
        point_id: string | null;
        page: number | null;
      }>(
        "SELECT document_id,revision_id,point_id,page FROM message_references WHERE message_id=?",
        m.id,
      );
      const references = [];
      for (const ref of refs) {
        try {
          if (ref.point_id) await pointAccess(s, ref.point_id);
          else if (ref.revision_id) await revisionAccess(s, ref.revision_id);
          else if (ref.document_id) await documentAccess(s, ref.document_id);
          references.push(ref);
        } catch {
          /* No label, title, ID or URL for an inaccessible reference. */
        }
      }
      items.push({ ...m, attachments: files, references });
    }
    return c.json({ items, hasMore: rows.length > 30, page: page(c) });
  });
  app.get("/attachments/:id/content", async (c) => {
    const s = c.get("store"),
      file = await s
        .statement(
          "SELECT id,message_id,object_key,filename,content_type FROM message_attachments WHERE id=? AND state='attached'",
          c.req.param("id"),
        )
        .first<{
          message_id: string;
          object_key: string;
          filename: string;
          content_type: string;
        }>();
    if (!file) throw unavailable();
    const r = await messageAccess(s, file.message_id);
    await membership(s, r.access.id, "download_documents");
    if (!c.env.DOCUMENTS) throw new HttpError(503, "R2 unavailable");
    const o = await c.env.DOCUMENTS.get(file.object_key);
    if (!o) throw unavailable();
    return new Response(o.body, {
      headers: {
        "Content-Type": file.content_type,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  });
  app.get("/projects/:project/requests", async (c) => {
    const s = c.get("store"),
      a = await membership(s, c.req.param("project"), "view_conversations");
    const rows = await s.all<{ message_id: string }>(
      "SELECT id,title,description,status,priority,due_date,message_id,created_by,assignee_id FROM technical_requests WHERE project_id=? AND (?=0 OR assignee_id=? OR created_by=?) ORDER BY updated_at DESC LIMIT 31 OFFSET ?",
      a.id,
      Number(a.external),
      s.userId,
      s.userId,
      page(c) * 30,
    );
    const items = [];
    for (const row of rows.slice(0, 30)) {
      try {
        await messageAccess(s, row.message_id);
        items.push(row);
      } catch {
        /* Source visibility is mandatory. */
      }
    }
    return c.json({ items, hasMore: rows.length > 30, page: page(c) });
  });
  app.get("/projects/:project/approvals", async (c) => {
    const s = c.get("store"),
      a = await membership(s, c.req.param("project"), "view_approvals");
    return list(
      c,
      `SELECT a.id,a.title,a.description,a.status,a.revision_id,a.document_id,a.version,a.decision_comment,a.decision_identity,a.approver_id,r.label AS revision_label,d.name AS document_name FROM approval_requests a JOIN document_revisions r ON r.id=a.revision_id JOIN documents d ON d.id=a.document_id WHERE a.project_id=? AND a.deleted_at IS NULL AND a.status<>'draft' AND (?=0 OR (a.externally_shared=1 AND a.approver_id=? AND ${docsVisible})) ORDER BY a.number DESC LIMIT 31 OFFSET ?`,
      [a.id, Number(a.external), s.userId, Number(a.external)],
    );
  });
  app.get("/projects/:project/summary", async (c) => {
    const s = c.get("store"),
      a = await membership(s, c.req.param("project"));
    const documents = a.permissions.view_documents
      ? await s
          .statement(
            `SELECT count(DISTINCT d.id) AS n FROM documents d JOIN document_revisions r ON r.document_id=d.id WHERE d.project_id=? AND d.status<>'archived' AND ${docsVisible}`,
            a.id,
            Number(a.external),
          )
          .first<number>("n")
      : 0;
    const conversations = a.permissions.view_conversations
      ? await s
          .statement(
            "SELECT count(*) n FROM project_conversations WHERE project_id=? AND (?=0 OR externally_shared=1)",
            a.id,
            Number(a.external),
          )
          .first<number>("n")
      : 0;
    return c.json({ documents, conversations });
  });
  return app;
}
/** Fail-closed allowlist for non-primary users. Legacy owner routes are never exposed wholesale. */
export async function authorizeMemberRequest(c: C): Promise<void> {
  const s = c.get("store"),
    path = c.req.path.replace("/api/v1/", ""),
    method = c.req.method;
  if (["me", "health", "translations/config"].includes(path)) return;
  if (path.startsWith("access/") || path.startsWith("collaboration/")) return; // Each handler authorizes its own organization/resource.
  if (
    path === "translations" ||
    /^translations\/[a-f0-9-]+$/.test(path) ||
    (method === "GET" && /^organizations\/[a-f0-9-]+\/glossary$/.test(path))
  )
    return;
  let project: string | undefined, permission: Permission | undefined;
  const body = async () =>
    c.req.json().catch(() => {
      throw new HttpError(400, "Invalid data");
    });
  let m: RegExpMatchArray | null;
  if (method === "PATCH" && (m = path.match(/^annotations\/([^/]+)$/))) {
    const row = await s
      .statement(
        "SELECT created_by,revision_id,point_id FROM graphical_annotations WHERE id=? AND annotation_deleted_at IS NULL",
        m[1],
      )
      .first<{
        created_by: string;
        revision_id: string;
        point_id: string | null;
      }>();
    if (!row || row.created_by !== s.userId) throw unavailable();
    const r = await revisionAccess(s, row.revision_id, "annotate");
    if (r.access.external) {
      if (!row.point_id) throw unavailable();
      await pointAccess(s, row.point_id, "annotate");
    }
    project = r.access.id;
    permission = "annotate";
  } else if (
    method === "PATCH" &&
    (m = path.match(/^review-messages\/([^/]+)$/))
  ) {
    const row = await s
      .statement(
        "SELECT author_id,item_id FROM review_messages WHERE id=?",
        m[1],
      )
      .first<{ author_id: string; item_id: string }>();
    if (!row || row.author_id !== s.userId) throw unavailable();
    project = (await pointAccess(s, row.item_id, "reply_points")).access.id;
    permission = "reply_points";
  } else if (method === "PATCH" && (m = path.match(/^messages\/([^/]+)$/))) {
    const row = await messageAccess(s, m[1], "participate_conversations");
    if (row.message.author_id !== s.userId) throw unavailable();
    project = row.access.id;
    permission = "participate_conversations";
  } else if (
    method === "POST" &&
    (m = path.match(/^projects\/([^/]+)\/uploads$/))
  ) {
    const v = await body();
    const a = await membership(
      s,
      m[1],
      v.document_id ? "add_revisions" : "add_documents",
    );
    if (v.document_id) await documentAccess(s, v.document_id, "add_revisions");
    if (v.folder_id || (a.external && v.status && v.status !== "draft"))
      throw unavailable();
    project = a.id;
    permission = v.document_id ? "add_revisions" : "add_documents";
  } else if (
    ["PUT", "POST", "DELETE"].includes(method) &&
    (m = path.match(/^uploads\/([^/]+)(?:\/(?:content|complete))?$/))
  ) {
    const u = await s
      .statement(
        "SELECT project_id,json_extract(metadata,'$.document_id') AS document_id,actor_id FROM document_uploads WHERE id=?",
        m[1],
      )
      .first<{
        project_id: string;
        document_id: string | null;
        actor_id: string;
      }>();
    if (!u || u.actor_id !== s.userId) throw unavailable();
    permission = u.document_id ? "add_revisions" : "add_documents";
    project = (await membership(s, u.project_id, permission)).id;
    if (u.document_id) await documentAccess(s, u.document_id, permission);
  } else if (
    method === "POST" &&
    (m = path.match(/^review-items\/([^/]+)\/messages$/))
  ) {
    const r = await pointAccess(s, m[1], "reply_points");
    project = r.access.id;
    permission = "reply_points";
  } else if (
    method === "POST" &&
    (m = path.match(/^revisions\/([^/]+)\/(annotations|review-items)$/))
  ) {
    permission = m[2] === "annotations" ? "annotate" : "create_points";
    const r = await revisionAccess(s, m[1], permission);
    const v = await body();
    if (r.access.external) {
      const id = valid(z.uuid(), v.id);
      if (m[2] === "review-items") {
        if (v.annotation_ids?.length) throw unavailable();
        if (
          await s.statement("SELECT 1 FROM review_items WHERE id=?", id).first()
        )
          await pointAccess(s, id, permission);
      } else {
        const old = await s
          .statement(
            "SELECT point_id FROM graphical_annotations WHERE id=?",
            id,
          )
          .first<{ point_id: string | null }>();
        if (old) {
          if (!old.point_id) throw unavailable();
          await pointAccess(s, old.point_id, permission);
        }
      }
    }
    if (m[2] === "annotations" && r.access.external && !v.point_id)
      throw new HttpError(
        400,
        "External annotations must reference a published point",
      );
    if (v.point_id) {
      const p = await pointAccess(s, v.point_id, permission);
      if (p.revision.id !== r.revision.id) throw unavailable();
    }
    project = r.access.id;
  } else if (
    method === "POST" &&
    (m = path.match(/^conversations\/([^/]+)\/messages$/))
  ) {
    const r = await conversationAccess(s, m[1], "participate_conversations"),
      v = await body();
    if (
      await s
        .statement(
          "SELECT 1 FROM conversation_messages WHERE id=?",
          valid(z.uuid(), v.id),
        )
        .first()
    )
      await messageAccess(s, v.id, "participate_conversations");
    if (r.access.external && !v.shared)
      throw new HttpError(400, "Supplier messages must be shared");
    for (const ref of v.references ?? []) {
      if (ref.point_id) await pointAccess(s, ref.point_id);
      if (ref.revision_id) await revisionAccess(s, ref.revision_id);
      if (ref.document_id) await documentAccess(s, ref.document_id);
    }
    if (v.parent_id) await messageAccess(s, v.parent_id);
    project = r.access.id;
    permission = "participate_conversations";
  } else if (
    method === "POST" &&
    (m = path.match(/^messages\/([^/]+)\/requests$/))
  ) {
    const r = await messageAccess(s, m[1], "create_requests"),
      v = await body();
    if (r.access.external) {
      const old = await s
        .statement(
          "SELECT assignee_id,created_by FROM technical_requests WHERE message_id=?",
          r.message.id,
        )
        .first<{ assignee_id: string | null; created_by: string }>();
      if (old && old.assignee_id !== s.userId && old.created_by !== s.userId)
        throw unavailable();
    }
    if (v.document_id) await documentAccess(s, v.document_id);
    if (v.revision_id) await revisionAccess(s, v.revision_id);
    if (v.point_id) await pointAccess(s, v.point_id);
    project = r.access.id;
    permission = "create_requests";
  } else if (
    method === "POST" &&
    (m = path.match(/^approvals\/([^/]+)\/actions$/))
  ) {
    const r = await approvalAccess(s, m[1], "approve"),
      v = await body();
    if (
      r.approval.approver_id !== s.userId ||
      v.confirmed !== true ||
      !["approve", "reject", "request_changes"].includes(v.action)
    )
      throw unavailable();
    for (const id of v.point_ids ?? []) await pointAccess(s, id);
    project = r.access.id;
    permission = "approve";
  }
  if (!project || !permission) throw unavailable();
  await membership(s, project, permission);
  s.delegated = { project, permission };
}
