import { Hono } from "hono";
import { z } from "zod";
import { Store } from "./database";
import { HttpError, type Bindings, type Principal } from "./types";
import {
  accessInvite,
  accessRoles,
  rolePermissions,
  permissionsSchema,
  type Permissions,
} from "../../../packages/shared/src/access";
import {
  membership,
  documentAccess,
  conversationAccess,
  approvalAccess,
  messageAccess,
  pointAccess,
  unavailable,
} from "./access-control";
type Vars = { store: Store; principal: Principal; requestId: string };
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
export function valid<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new HttpError(400, "Invalid access data");
  return r.data;
}
export async function digest(s: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
function security(
  s: Store,
  org: string | null,
  action: string,
  key: string,
  payload: unknown = {},
) {
  return s.statement(
    "INSERT INTO security_events(id,organization_id,actor_id,action,resource_id,payload) VALUES(?,?,?,?,?,?)",
    crypto.randomUUID(),
    org,
    s.userId,
    action,
    key,
    JSON.stringify(payload),
  );
}
export function accessRoutes(fetcher: typeof fetch = fetch) {
  const app = new Hono<{ Bindings: Bindings; Variables: Vars }>();
  app.post("/logout", async (c) => {
    if (c.env.MULTIUSER_ENABLED !== "true")
      return c.json({ logout_url: "/cdn-cgi/access/logout" });
    const s = c.get("store"),
      i = c.get("principal").identity;
    if (!i.sessionHash || !i.expiresAt)
      throw new HttpError(401, "Verified session required");
    await s.db.batch([
      s.statement(
        "INSERT OR IGNORE INTO revoked_sessions(session_hash,expires_at,user_id) VALUES(?,?,?)",
        i.sessionHash,
        i.expiresAt,
        s.userId,
      ),
      security(s, null, "session.logout", s.userId),
    ]);
    return c.json({ logout_url: "/cdn-cgi/access/logout" });
  });
  app.get("/projects/:project/members", async (c) => {
    const s = c.get("store"),
      a = await membership(s, c.req.param("project"), "manage_members");
    if (a.external) throw unavailable();
    const rows = await s.all(
      "SELECT pm.user_id,p.name,p.email,p.status,pm.role,pm.active,pm.access_enabled,pm.permissions,pm.access_version AS version,pm.added_at FROM project_memberships pm JOIN profiles p ON p.id=pm.user_id WHERE pm.project_id=? ORDER BY p.name LIMIT 201",
      a.id,
    );
    return c.json({ items: rows.slice(0, 200), hasMore: rows.length > 200 });
  });
  app.patch("/projects/:project/members/:user", async (c) => {
    const s = c.get("store"),
      a = await membership(s, c.req.param("project"), "manage_members");
    if (a.external || c.req.param("user") === s.userId) throw unavailable();
    const v = valid(
      z.object({
        role: z.enum(accessRoles),
        active: z.boolean(),
        version: z.number().int().positive(),
        permissions: permissionsSchema,
      }),
      await c.req.json().catch(() => null),
    );
    const target = await s
      .statement(
        "SELECT pm.*,om.role AS org_role FROM project_memberships pm JOIN organization_memberships om ON om.user_id=pm.user_id AND om.organization_id=pm.organization_id WHERE pm.project_id=? AND pm.user_id=?",
        a.id,
        c.req.param("user"),
      )
      .first<{ supplier_id: string | null; org_role: string; role: string }>();
    if (
      !target ||
      target.org_role === "owner" ||
      v.role.startsWith("supplier_") !== !!target.supplier_id
    )
      throw unavailable();
    if (
      a.role !== "owner" &&
      (target.role === "project_admin" ||
        v.role === "project_admin" ||
        v.permissions.manage_members)
    )
      throw unavailable();
    const permissions: Permissions = { ...v.permissions };
    if (v.role === "reviewer")
      for (const k of [
        "add_documents",
        "add_revisions",
        "annotate",
        "create_points",
        "reply_points",
        "participate_conversations",
        "create_requests",
        "approve",
        "manage_members",
        "correct_translations",
      ] as const)
        permissions[k] = false;
    if (target.supplier_id) permissions.manage_members = false;
    const operation = crypto.randomUUID();
    await s.write(
      [
        s.statement(
          "UPDATE project_memberships SET role=?,active=?,permissions=?,access_enabled=1,access_version=access_version+1 WHERE project_id=? AND user_id=? AND access_version=?",
          v.role,
          Number(v.active),
          JSON.stringify(permissions),
          a.id,
          c.req.param("user"),
          v.version,
        ),
        s.statement(
          `INSERT INTO security_events(id,organization_id,actor_id,action,resource_id,payload) SELECT ?,?,?,'membership.changed',?,? WHERE changes()>0`,
          operation,
          a.organization_id,
          s.userId,
          c.req.param("user"),
          JSON.stringify({
            project: a.id,
            role: v.role,
            active: v.active,
            permissions,
          }),
        ),
        s.statement(
          `UPDATE access_invitations SET revoked_at=${now} WHERE accepted_at IS NULL AND revoked_at IS NULL AND email=(SELECT email FROM profiles WHERE id=?) AND id IN(SELECT invitation_id FROM access_invitation_projects WHERE project_id=?) AND EXISTS(SELECT 1 FROM security_events WHERE id=?)`,
          c.req.param("user"),
          a.id,
          operation,
        ),
        s.statement(
          "UPDATE project_memberships SET active=active WHERE project_id=? AND user_id=? AND EXISTS(SELECT 1 FROM security_events WHERE id=?)",
          a.id,
          c.req.param("user"),
          operation,
        ),
      ],
      a.organization_id,
      "membership.changed",
      c.req.param("user"),
      true,
    );
    return c.json({ ok: true });
  });
  app.post("/organizations/:org/revoke-sessions/:user", async (c) => {
    const s = c.get("store"),
      org = valid(z.uuid(), c.req.param("org")),
      user = valid(z.uuid(), c.req.param("user"));
    await s.requireOrg(org, true);
    if (user === s.userId)
      throw new HttpError(409, "Use logout for your current session");
    const target = await s
      .statement(
        "SELECT role FROM organization_memberships WHERE organization_id=? AND user_id=?",
        org,
        user,
      )
      .first<{ role: string }>();
    if (!target || target.role === "owner") throw unavailable();
    await s.db.batch([
      s.statement(
        "UPDATE profiles SET auth_not_before=unixepoch() WHERE id=?",
        user,
      ),
      security(s, org, "sessions.revoked", user),
    ]);
    return c.json({ ok: true });
  });
  app.get("/organizations/:org/events", async (c) => {
    const s = c.get("store"),
      org = valid(z.uuid(), c.req.param("org"));
    await s.requireOrg(org, true);
    const page = valid(
      z.coerce.number().int().min(0).max(10000),
      c.req.query("page") ?? 0,
    );
    const rows = await s.all(
      "SELECT e.id,e.action,e.resource_id,e.payload,e.created_at,p.name AS actor FROM security_events e LEFT JOIN profiles p ON p.id=e.actor_id WHERE (e.organization_id=? OR (e.organization_id IS NULL AND e.actor_id=?)) ORDER BY sequence DESC LIMIT 31 OFFSET ?",
      org,
      s.userId,
      page * 30,
    );
    return c.json({ items: rows.slice(0, 30), hasMore: rows.length > 30 });
  });
  app.get("/organizations/:org/invitations", async (c) => {
    const s = c.get("store"),
      org = valid(z.uuid(), c.req.param("org"));
    await s.requireOrg(org, true);
    return c.json(
      await s.all(
        `SELECT id,email,role,supplier_id,message,expires_at,delivery,created_at,CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN accepted_at IS NOT NULL THEN 'accepted' WHEN expires_at<=${now} THEN 'expired' ELSE 'pending' END AS status FROM access_invitations WHERE organization_id=? ORDER BY created_at DESC LIMIT 200`,
        org,
      ),
    );
  });
  app.post("/organizations/:org/invitations", async (c) => {
    const s = c.get("store"),
      org = valid(z.uuid(), c.req.param("org"));
    await s.requireOrg(org, true);
    const v = valid(accessInvite, await c.req.json().catch(() => null));
    if (new Set(v.project_ids).size !== v.project_ids.length)
      throw new HttpError(400, "Duplicate project");
    for (const key of v.project_ids) {
      const a = await membership(s, key, "manage_members");
      if (a.organization_id !== org || a.external) throw unavailable();
      if (
        v.supplier_id &&
        !(await s
          .statement(
            "SELECT 1 FROM project_suppliers ps JOIN suppliers sp ON sp.id=ps.supplier_id WHERE ps.project_id=? AND ps.supplier_id=? AND sp.status='active'",
            key,
            v.supplier_id,
          )
          .first())
      )
        throw unavailable();
    }
    const id = crypto.randomUUID(),
      token = crypto.randomUUID() + crypto.randomUUID(),
      hash = await digest(token),
      expires = new Date(Date.now() + v.expires_days * 86400000).toISOString();
    await s.db.batch([
      s.statement(
        "INSERT INTO access_invitations(id,organization_id,email,role,supplier_id,token_hash,message,created_by,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
        id,
        org,
        v.email,
        v.role,
        v.supplier_id,
        hash,
        v.message,
        s.userId,
        expires,
      ),
      ...v.project_ids.map((p) =>
        s.statement(
          "INSERT INTO access_invitation_projects(invitation_id,project_id) VALUES(?,?)",
          id,
          p,
        ),
      ),
      security(s, org, "invitation.created", id, {
        email: v.email,
        role: v.role,
        project_ids: v.project_ids,
      }),
    ]);
    let delivery = "not_configured";
    const link = `${c.env.APP_ORIGIN}/#invitation=${token}`;
    if (
      c.env.MULTIUSER_ENABLED === "true" &&
      c.env.RESEND_API_KEY &&
      c.env.INVITATION_FROM
    ) {
      delivery = "failed";
      try {
        const r = await fetcher("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": id,
          },
          body: JSON.stringify({
            from: c.env.INVITATION_FROM,
            to: [v.email],
            subject: "ForgeBridge — invitation",
            text: `${v.message}\n\nForgeBridge: ${link}\nExpires: ${expires}\nSign in with ${v.email}.`,
          }),
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        });
        if (r.ok) delivery = "sent";
      } catch {
        /* Stored invitation is not represented as sent. */
      }
    }
    await s.db.batch([
      s.statement(
        "UPDATE access_invitations SET delivery=? WHERE id=?",
        delivery,
        id,
      ),
      security(s, org, "invitation.delivery", id, { delivery }),
    ]);
    return c.json(
      {
        id,
        delivery,
        expires_at: expires,
        ...(delivery !== "sent" ? { invitation_url: link } : {}),
      },
      201,
    );
  });
  app.post("/invitations/:id/resend", async (c) => {
    const s = c.get("store"),
      id = valid(z.uuid(), c.req.param("id"));
    const invite = await s
      .statement(
        "SELECT * FROM access_invitations WHERE id=? AND accepted_at IS NULL AND revoked_at IS NULL",
        id,
      )
      .first<{ organization_id: string; email: string; message: string }>();
    if (!invite) throw unavailable();
    await s.requireOrg(invite.organization_id, true);
    const token = crypto.randomUUID() + crypto.randomUUID(),
      expires = new Date(Date.now() + 7 * 86400000).toISOString(),
      link = `${c.env.APP_ORIGIN}/#invitation=${token}`;
    await s.db.batch([
      s.statement(
        "UPDATE access_invitations SET token_hash=?,expires_at=?,delivery='not_configured' WHERE id=? AND accepted_at IS NULL AND revoked_at IS NULL",
        await digest(token),
        expires,
        id,
      ),
      security(s, invite.organization_id, "invitation.resent", id),
    ]);
    let delivery = "not_configured";
    if (
      c.env.MULTIUSER_ENABLED === "true" &&
      c.env.RESEND_API_KEY &&
      c.env.INVITATION_FROM
    ) {
      delivery = "failed";
      try {
        const r = await fetcher("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            from: c.env.INVITATION_FROM,
            to: [invite.email],
            subject: "ForgeBridge — invitation",
            text: `${invite.message}\n\n${link}\nExpires: ${expires}`,
          }),
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        });
        if (r.ok) delivery = "sent";
      } catch {}
    }
    await s
      .statement(
        "UPDATE access_invitations SET delivery=? WHERE id=?",
        delivery,
        id,
      )
      .run();
    return c.json({
      id,
      delivery,
      ...(delivery !== "sent" ? { invitation_url: link } : {}),
    });
  });
  app.delete("/invitations/:id", async (c) => {
    const s = c.get("store"),
      r = await s
        .statement(
          "SELECT organization_id FROM access_invitations WHERE id=? AND accepted_at IS NULL",
          valid(z.uuid(), c.req.param("id")),
        )
        .first<{ organization_id: string }>();
    if (!r) throw unavailable();
    await s.requireOrg(r.organization_id, true);
    await s.db.batch([
      s.statement(
        `UPDATE access_invitations SET revoked_at=${now} WHERE id=? AND revoked_at IS NULL`,
        c.req.param("id"),
      ),
      security(s, r.organization_id, "invitation.revoked", c.req.param("id")),
    ]);
    return c.json({ ok: true });
  });
  app.post("/invitations/accept", async (c) => {
    if (c.env.MULTIUSER_ENABLED !== "true")
      throw new HttpError(409, "Collaboration is not enabled");
    const s = c.get("store"),
      v = valid(
        z.object({ token: z.string().min(64).max(200) }),
        await c.req.json().catch(() => null),
      ),
      hash = await digest(v.token);
    const i = await s
      .statement(
        `SELECT * FROM access_invitations WHERE token_hash=? AND email=? AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>${now}`,
        hash,
        c.get("principal").identity.email,
      )
      .first<{
        id: string;
        organization_id: string;
        role: string;
        supplier_id: string | null;
      }>();
    if (!i) throw unavailable();
    const permissions = JSON.stringify(rolePermissions(i.role));
    const claim = crypto.randomUUID();
    // Claim first. Every derived write is gated by that exact claim/user in the same D1 transaction.
    const condition =
      "EXISTS(SELECT 1 FROM access_invitations WHERE id=? AND accepted_by=? AND accepted_at IS NOT NULL AND acceptance_key=?)";
    const result = await s.db.batch([
      s.statement(
        `UPDATE access_invitations SET accepted_at=${now},accepted_by=?,acceptance_key=? WHERE id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>${now} AND email=?`,
        s.userId,
        claim,
        i.id,
        c.get("principal").identity.email,
      ),
      s.statement(
        `INSERT INTO organization_memberships(organization_id,user_id,role) SELECT ?,?,? WHERE changes()>0 ON CONFLICT(organization_id,user_id) DO NOTHING`,
        i.organization_id,
        s.userId,
        i.role,
      ),
      ...(i.supplier_id
        ? [
            s.statement(
              `INSERT INTO supplier_memberships(organization_id,supplier_id,user_id) SELECT ?,?,? WHERE ${condition} ON CONFLICT(supplier_id,user_id) DO UPDATE SET active=1`,
              i.organization_id,
              i.supplier_id,
              s.userId,
              i.id,
              s.userId,
              claim,
            ),
          ]
        : []),
      s.statement(
        `INSERT INTO project_memberships(organization_id,project_id,user_id,role,supplier_id,permissions,access_enabled,added_at) SELECT ?,p.project_id,?,?,?,?,1,${now} FROM access_invitation_projects p JOIN projects project ON project.id=p.project_id AND project.organization_id=? WHERE p.invitation_id=? AND ${condition} ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role,supplier_id=excluded.supplier_id,permissions=excluded.permissions,access_enabled=1,active=1,access_version=project_memberships.access_version+1`,
        i.organization_id,
        s.userId,
        i.role,
        i.supplier_id,
        permissions,
        i.organization_id,
        i.id,
        i.id,
        s.userId,
        claim,
      ),
      s.statement(
        `INSERT INTO security_events(id,organization_id,actor_id,action,resource_id) SELECT ?,?,?,'invitation.accepted',? WHERE ${condition}`,
        crypto.randomUUID(),
        i.organization_id,
        s.userId,
        i.id,
        i.id,
        s.userId,
        claim,
      ),
    ]);
    if (!result[0].meta.changes) throw unavailable();
    return c.json({ ok: true });
  });
  app.get("/documents/:id/sharing", async (c) => {
    const s = c.get("store"),
      r = await documentAccess(s, c.req.param("id"));
    if (r.access.external || !r.access.permissions.manage_members)
      throw unavailable();
    const revisions = await s.all(
      "SELECT r.id,r.label,EXISTS(SELECT 1 FROM revision_shares rs WHERE rs.revision_id=r.id) AS shared FROM document_revisions r WHERE r.document_id=? ORDER BY ordinal DESC LIMIT 200",
      r.document.id,
    );
    return c.json({ shared: !!r.document.externally_shared, revisions });
  });
  app.patch("/documents/:id/sharing", async (c) => {
    const s = c.get("store"),
      d = await documentAccess(s, c.req.param("id"));
    if (
      (d.access.role !== "owner" && !d.access.permissions.manage_members) ||
      d.access.external
    )
      throw unavailable();
    const v = valid(
      z.object({
        shared: z.boolean(),
        revision_ids: z.array(z.uuid()).max(100),
      }),
      await c.req.json().catch(() => null),
    );
    for (const r of v.revision_ids)
      if (
        !(await s
          .statement(
            "SELECT 1 FROM document_revisions WHERE id=? AND document_id=?",
            r,
            c.req.param("id"),
          )
          .first())
      )
        throw unavailable();
    await s.db.batch([
      s.statement(
        "UPDATE documents SET externally_shared=? WHERE id=?",
        Number(v.shared),
        c.req.param("id"),
      ),
      s.statement(
        "DELETE FROM revision_shares WHERE revision_id IN(SELECT id FROM document_revisions WHERE document_id=?)",
        c.req.param("id"),
      ),
      ...(v.shared
        ? v.revision_ids.map((r) =>
            s.statement(
              "INSERT INTO revision_shares(revision_id,shared_by) VALUES(?,?)",
              r,
              s.userId,
            ),
          )
        : []),
      security(
        s,
        d.access.organization_id,
        "document.sharing",
        c.req.param("id"),
        v,
      ),
    ]);
    return c.json({ ok: true });
  });
  app.patch("/conversations/:id/sharing", async (c) => {
    const s = c.get("store"),
      r = await conversationAccess(s, c.req.param("id"));
    if (r.access.external || !r.access.permissions.manage_members)
      throw unavailable();
    const v = valid(
      z.object({ shared: z.boolean() }),
      await c.req.json().catch(() => null),
    );
    await s.db.batch([
      s.statement(
        "UPDATE project_conversations SET externally_shared=? WHERE id=?",
        Number(v.shared),
        c.req.param("id"),
      ),
      security(
        s,
        r.access.organization_id,
        "conversation.sharing",
        c.req.param("id"),
        v,
      ),
    ]);
    return c.json({ ok: true });
  });
  app.patch("/requests/:id/assignee", async (c) => {
    const s = c.get("store"),
      id = valid(z.uuid(), c.req.param("id"));
    const r = await s
      .statement(
        "SELECT message_id,project_id,point_id FROM technical_requests WHERE id=?",
        id,
      )
      .first<{
        message_id: string;
        project_id: string;
        point_id: string | null;
      }>();
    if (!r) throw unavailable();
    const a = await membership(s, r.project_id, "manage_members");
    if (a.external) throw unavailable();
    const v = valid(
      z.object({ assignee_id: z.uuid().nullable() }),
      await c.req.json().catch(() => null),
    );
    if (v.assignee_id) {
      const target = new Store(s.db, v.assignee_id);
      await messageAccess(target, r.message_id);
      if (r.point_id) await pointAccess(target, r.point_id);
    }
    await s.db.batch([
      s.statement(
        "UPDATE technical_requests SET assignee_id=?,version=version+1 WHERE id=?",
        v.assignee_id,
        id,
      ),
      security(s, a.organization_id, "request.assigned", id, v),
    ]);
    return c.json({ ok: true });
  });
  app.patch("/approvals/:id/sharing", async (c) => {
    const s = c.get("store"),
      r = await approvalAccess(s, c.req.param("id"));
    if (r.access.external || !r.access.permissions.manage_members)
      throw unavailable();
    const v = valid(
      z.object({ shared: z.boolean(), approver_id: z.uuid().nullable() }),
      await c.req.json().catch(() => null),
    );
    if (
      r.approval.status !== "draft" &&
      v.approver_id !== r.approval.approver_id
    )
      throw new HttpError(
        409,
        "Submitted approver is frozen; create a new cycle",
      );
    if (v.approver_id) {
      const other = new Store(s.db, v.approver_id);
      await membership(other, r.access.id, "approve");
    }
    if (v.shared && !v.approver_id)
      throw new HttpError(400, "Explicit approver required");
    await s.db.batch([
      r.approval.status === "draft"
        ? s.statement(
            "UPDATE approval_requests SET externally_shared=?,approver_id=? WHERE id=? AND status='draft'",
            Number(v.shared),
            v.approver_id,
            c.req.param("id"),
          )
        : s.statement(
            "UPDATE approval_requests SET externally_shared=? WHERE id=?",
            Number(v.shared),
            c.req.param("id"),
          ),
      security(
        s,
        r.access.organization_id,
        "approval.sharing",
        c.req.param("id"),
        v,
      ),
    ]);
    return c.json({ ok: true });
  });
  return app;
}
