import { z } from "zod";
import {
  HttpError,
  type Bindings,
  type Identity,
  type Principal,
} from "./types";
import type { Role } from "../../../packages/shared/src/index";
interface Scope {
  text: string;
  args: unknown[];
}
// Only application-owned SQL identifiers are interpolated. All user values are bound.
export function orgScope(org: string, user: string, owner = false): Scope {
  return {
    text: `EXISTS(SELECT 1 FROM organization_memberships om JOIN profiles actor ON actor.id=om.user_id WHERE om.organization_id=${org} AND om.user_id=? AND om.active=1 AND actor.status='active' ${owner ? "AND om.role='owner'" : ""})`,
    args: [user],
  };
}
export function projectScope(
  alias: string,
  user: string,
  admin = false,
): Scope {
  return {
    text: `EXISTS(SELECT 1 FROM organization_memberships om JOIN profiles actor ON actor.id=om.user_id WHERE om.organization_id=${alias}.organization_id AND om.user_id=? AND om.active=1 AND actor.status='active' AND (om.role='owner' OR EXISTS(SELECT 1 FROM project_memberships pm WHERE pm.organization_id=om.organization_id AND pm.project_id=${alias}.id AND pm.user_id=om.user_id AND pm.active=1 ${admin ? "AND pm.role='project_admin'" : ""} AND (pm.supplier_id IS NULL OR EXISTS(SELECT 1 FROM supplier_memberships sm JOIN suppliers s ON s.id=sm.supplier_id AND s.organization_id=sm.organization_id JOIN project_suppliers ps ON ps.supplier_id=sm.supplier_id AND ps.project_id=pm.project_id AND ps.organization_id=sm.organization_id WHERE sm.user_id=om.user_id AND sm.supplier_id=pm.supplier_id AND sm.active=1 AND s.status='active')))))`,
    args: [user],
  };
}
export async function resolvePrincipal(
  db: D1Database,
  identity: Identity,
  env: Bindings,
): Promise<Principal> {
  if (!env.ADMIN_EMAIL || !z.uuid().safeParse(env.ADMIN_USER_ID).success)
    throw new HttpError(503, "Administrator configuration required");
  if (identity.email !== env.ADMIN_EMAIL.trim().toLowerCase())
    throw new HttpError(
      403,
      "This private workspace is restricted to its administrator",
    );
  const existing = await db
    .prepare(
      `SELECT l.user_id,p.status FROM identity_links l JOIN profiles p ON p.id=l.user_id WHERE l.provider=? AND l.issuer=? AND l.subject=?`,
    )
    .bind(identity.provider, identity.issuer, identity.subject)
    .first<{ user_id: string; status: string }>();
  if (existing) {
    if (existing.user_id !== env.ADMIN_USER_ID || existing.status !== "active")
      throw new HttpError(403, "Account unavailable");
    return { id: existing.user_id, identity };
  }
  await db.batch([
    db
      .prepare(`INSERT OR IGNORE INTO profiles(id,email,name) VALUES(?,?,?)`)
      .bind(
        env.ADMIN_USER_ID,
        identity.email,
        env.ADMIN_NAME?.trim().slice(0, 120) || identity.email.slice(0, 120),
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO identity_links(provider,issuer,subject,user_id) VALUES(?,?,?,?)`,
      )
      .bind(
        identity.provider,
        identity.issuer,
        identity.subject,
        env.ADMIN_USER_ID,
      ),
  ]);
  const linked = await db
    .prepare(
      `SELECT p.id,p.status,l.subject,l.issuer FROM profiles p JOIN identity_links l ON l.user_id=p.id WHERE p.id=?`,
    )
    .bind(env.ADMIN_USER_ID)
    .first<{ id: string; status: string; subject: string; issuer: string }>();
  if (
    !linked ||
    linked.subject !== identity.subject ||
    linked.issuer !== identity.issuer ||
    linked.status !== "active"
  )
    throw new HttpError(403, "Identity is not linked to this account");
  return { id: linked.id, identity };
}
export class Store {
  constructor(
    readonly db: D1Database,
    readonly userId: string,
  ) {}
  statement(text: string, ...args: unknown[]) {
    return this.db.prepare(text).bind(...args);
  }
  async all<T>(text: string, ...args: unknown[]): Promise<T[]> {
    return (await this.statement(text, ...args).all<T>()).results;
  }
  async requireOrg(org: string, owner = false) {
    const g = orgScope("o.id", this.userId, owner);
    const row = await this.statement(
      `SELECT o.id FROM organizations o WHERE o.id=? AND ${g.text}`,
      org,
      ...g.args,
    ).first();
    if (!row) throw new HttpError(403, "Organization access denied");
  }
  async requireProject(id: string, admin = false) {
    const g = projectScope("p", this.userId, admin);
    const row = await this.statement(
      `SELECT p.* FROM projects p WHERE p.id=? AND ${g.text}`,
      id,
      ...g.args,
    ).first<{ id: string; organization_id: string }>();
    if (!row) throw new HttpError(403, "Project access denied");
    return row;
  }
  async write(
    statements: D1PreparedStatement[],
    org: string,
    action: string,
    resource: string,
    conflict = false,
  ) {
    const auditId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const results = await this.db.batch([
      ...statements,
      this.statement(
        `INSERT INTO audit_events(id,organization_id,actor_id,action,resource_id) SELECT ?,?,?,?,? WHERE changes()>0`,
        auditId,
        org,
        this.userId,
        action,
        resource,
      ),
      this.statement(
        `INSERT INTO outbox(id,organization_id,event_type,payload,idempotency_key) SELECT ?,organization_id,action,json_object('resource_id',resource_id,'actor_id',actor_id),? FROM audit_events WHERE id=?`,
        eventId,
        eventId,
        auditId,
      ),
    ]);
    if (!results[0].meta.changes)
      throw new HttpError(
        conflict ? 409 : 403,
        conflict
          ? "Record changed; refresh before saving"
          : "Resource unavailable or permission denied",
      );
  }
  async me() {
    const profile = await this.statement(
      `SELECT id,email,name,language,timezone FROM profiles WHERE id=? AND status='active'`,
      this.userId,
    ).first();
    if (!profile) throw new HttpError(403, "Account unavailable");
    const organizations = await this.all(
      `SELECT o.id,o.name,m.role FROM organizations o JOIN organization_memberships m ON m.organization_id=o.id WHERE m.user_id=? AND m.active=1 ORDER BY o.created_at LIMIT 200`,
      this.userId,
    );
    return {
      profile,
      organizations,
      mode: "private-developer",
      supplier_accounts_enabled: false,
    };
  }
  async createOrganization(name: string) {
    const id = crypto.randomUUID();
    await this.write(
      [
        this.statement(
          `INSERT INTO organizations(id,name) SELECT ?,? WHERE EXISTS(SELECT 1 FROM profiles WHERE id=? AND status='active')`,
          id,
          name,
          this.userId,
        ),
        this.statement(
          `INSERT INTO organization_memberships(organization_id,user_id,role) SELECT ?,?,'owner' WHERE EXISTS(SELECT 1 FROM organizations WHERE id=?)`,
          id,
          this.userId,
          id,
        ),
      ],
      id,
      "organization.created",
      id,
    );
    return { id };
  }
  async preferences(v: { name: string; language: string; timezone: string }) {
    const r = await this.statement(
      `UPDATE profiles SET name=?,language=?,timezone=? WHERE id=? AND status='active'`,
      v.name,
      v.language,
      v.timezone,
      this.userId,
    ).run();
    if (!r.meta.changes) throw new HttpError(403, "Account unavailable");
    return { ok: true };
  }
  async projects(org: string) {
    await this.requireOrg(org);
    const g = projectScope("p", this.userId);
    return this.all(
      `SELECT p.*,COALESCE(p.lifecycle_status,p.status) AS status,(SELECT count(*) FROM documents d WHERE d.project_id=p.id AND d.status<>'archived') AS document_count,(SELECT group_concat(s.name,', ') FROM project_suppliers ps JOIN suppliers s ON s.id=ps.supplier_id WHERE ps.project_id=p.id) AS supplier_names FROM projects p WHERE p.organization_id=? AND ${g.text} ORDER BY p.updated_at DESC,p.id LIMIT 200`,
      org,
      ...g.args,
    );
  }
  async saveProject(v: {
    organization_id: string;
    id: string | null;
    code: string;
    name: string;
    description: string;
    status: string;
  }) {
    const id = v.id ?? crypto.randomUUID();
    const g = v.id
      ? projectScope("projects", this.userId, true)
      : orgScope("?", this.userId, true);
    const statement = v.id
      ? this.statement(
          `UPDATE projects SET code=?,name=?,description=?,status=?,lifecycle_status=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND organization_id=? AND ${g.text}`,
          v.code,
          v.name,
          v.description,
          v.status === "completed" ? "paused" : v.status,
          v.status,
          id,
          v.organization_id,
          ...g.args,
        )
      : this.statement(
          `INSERT INTO projects(id,organization_id,code,name,description,status,lifecycle_status) SELECT ?,?,?,?,?,?,? WHERE ${g.text}`,
          id,
          v.organization_id,
          v.code,
          v.name,
          v.description,
          v.status === "completed" ? "paused" : v.status,
          v.status,
          v.organization_id,
          ...g.args,
        );
    await this.write([statement], v.organization_id, "project.saved", id);
    return { id };
  }
  async suppliers(org: string) {
    await this.requireOrg(org);
    const owner = orgScope("s.organization_id", this.userId, true);
    return (
      await this.all<Record<string, unknown>>(
        `SELECT s.*,CASE WHEN ${owner.text} THEN n.internal_notes ELSE NULL END AS note FROM suppliers s LEFT JOIN supplier_notes n ON n.supplier_id=s.id WHERE s.organization_id=? AND EXISTS(SELECT 1 FROM organization_memberships om JOIN profiles a ON a.id=om.user_id WHERE om.organization_id=s.organization_id AND om.user_id=? AND om.active=1 AND a.status='active' AND (om.role NOT IN ('supplier_manager','supplier_engineer') OR EXISTS(SELECT 1 FROM supplier_memberships sm WHERE sm.supplier_id=s.id AND sm.user_id=om.user_id AND sm.active=1))) ORDER BY s.name LIMIT 200`,
        ...owner.args,
        org,
        this.userId,
      )
    ).map(({ note, ...s }) => ({
      ...s,
      supplier_notes: note === null ? null : { internal_notes: note },
    }));
  }
  async saveSupplier(v: {
    organization_id: string;
    id: string | null;
    name: string;
    country: string;
    language: string;
    contacts: string;
    internal_notes: string;
    status: string;
  }) {
    const id = v.id ?? crypto.randomUUID();
    const g = orgScope("?", this.userId, true);
    const statement = v.id
      ? this.statement(
          `UPDATE suppliers SET name=?,country=?,language=?,contacts=?,status=? WHERE id=? AND organization_id=? AND ${g.text}`,
          v.name,
          v.country,
          v.language,
          v.contacts,
          v.status,
          id,
          v.organization_id,
          v.organization_id,
          ...g.args,
        )
      : this.statement(
          `INSERT INTO suppliers(id,organization_id,name,country,language,contacts,status) SELECT ?,?,?,?,?,?,? WHERE ${g.text}`,
          id,
          v.organization_id,
          v.name,
          v.country,
          v.language,
          v.contacts,
          v.status,
          v.organization_id,
          ...g.args,
        );
    await this.write(
      [
        statement,
        this.statement(
          `INSERT INTO supplier_notes(organization_id,supplier_id,internal_notes) SELECT ?,?,? WHERE ${g.text} AND EXISTS(SELECT 1 FROM suppliers WHERE id=? AND organization_id=?) ON CONFLICT(supplier_id) DO UPDATE SET internal_notes=excluded.internal_notes`,
          v.organization_id,
          id,
          v.internal_notes,
          v.organization_id,
          ...g.args,
          id,
          v.organization_id,
        ),
      ],
      v.organization_id,
      "supplier.saved",
      id,
    );
    return { id };
  }
  async linkSupplier(project: string, supplier: string) {
    const p = await this.requireProject(project, true);
    const g = projectScope("p", this.userId, true);
    await this.write(
      [
        this.statement(
          `INSERT INTO project_suppliers(organization_id,project_id,supplier_id) SELECT p.organization_id,p.id,s.id FROM projects p JOIN suppliers s ON s.organization_id=p.organization_id WHERE p.id=? AND s.id=? AND ${g.text} ON CONFLICT(project_id,supplier_id) DO UPDATE SET supplier_id=excluded.supplier_id`,
          project,
          supplier,
          ...g.args,
        ),
      ],
      p.organization_id,
      "project.supplier.linked",
      supplier,
    );
    return { ok: true };
  }
  async collaborators(project: string) {
    await this.requireProject(project);
    const admin = projectScope("p", this.userId, true);
    const access = projectScope("p", this.userId);
    return (
      await this.all<Record<string, unknown>>(
        `SELECT pm.user_id,pm.role,pm.supplier_id,pm.active FROM project_memberships pm JOIN projects p ON p.id=pm.project_id WHERE p.id=? AND ${access.text} AND (${admin.text} OR pm.user_id=?) LIMIT 200`,
        project,
        ...access.args,
        ...admin.args,
        this.userId,
      )
    ).map((m) => ({ ...m, active: Boolean(m.active) }));
  }
  async members(org: string) {
    await this.requireOrg(org);
    const g = orgScope("m.organization_id", this.userId, true);
    const a = orgScope("m.organization_id", this.userId);
    return (
      await this.all<Record<string, unknown>>(
        `SELECT m.user_id,m.role,m.active FROM organization_memberships m WHERE m.organization_id=? AND ${a.text} AND (${g.text} OR m.user_id=?) LIMIT 200`,
        org,
        ...a.args,
        ...g.args,
        this.userId,
      )
    ).map((m) => ({ ...m, active: Boolean(m.active) }));
  }
  async setOrgMember(org: string, user: string, role: Role, active: boolean) {
    const g = orgScope(
      "organization_memberships.organization_id",
      this.userId,
      true,
    );
    await this.write(
      [
        this.statement(
          `UPDATE organization_memberships SET role=?,active=? WHERE organization_id=? AND user_id=? AND user_id<>? AND ${g.text}`,
          role,
          Number(active),
          org,
          user,
          this.userId,
          ...g.args,
        ),
      ],
      org,
      "organization.membership.changed",
      user,
    );
    return { ok: true };
  }
  async setProjectMember(
    project: string,
    user: string,
    role: Exclude<Role, "owner">,
    active: boolean,
  ) {
    const p = await this.requireProject(project, true);
    const g = projectScope("p", this.userId, true);
    await this.write(
      [
        this.statement(
          `UPDATE project_memberships SET role=?,active=? WHERE project_id=? AND user_id=? AND EXISTS(SELECT 1 FROM projects p WHERE p.id=project_memberships.project_id AND ${g.text})`,
          role,
          Number(active),
          project,
          user,
          ...g.args,
        ),
      ],
      p.organization_id,
      "project.membership.changed",
      user,
    );
    return { ok: true };
  }
  async audit(org: string) {
    await this.requireOrg(org, true);
    const g = orgScope("e.organization_id", this.userId, true);
    return this.all(
      `SELECT e.* FROM audit_events e WHERE e.organization_id=? AND ${g.text} ORDER BY e.created_at DESC,e.id DESC LIMIT 200`,
      org,
      ...g.args,
    );
  }
  async invitations(org: string) {
    await this.requireOrg(org);
    const g = projectScope("p", this.userId, true);
    return this.all(
      `SELECT i.id,i.project_id,i.supplier_id,i.email,i.role,i.expires_at,i.accepted_at,i.revoked_at FROM invitations i JOIN projects p ON p.id=i.project_id WHERE i.organization_id=? AND ${g.text} ORDER BY i.created_at DESC LIMIT 200`,
      org,
      ...g.args,
    );
  }
  async createInvitation(v: {
    project_id: string;
    supplier_id: string | null;
    email: string;
    role: string;
    expires_days: number;
  }) {
    const p = await this.requireProject(v.project_id, true);
    const id = crypto.randomUUID();
    const token = crypto.randomUUID() + crypto.randomUUID();
    const hash = [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
      ),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const g = projectScope("p", this.userId, true);
    await this.write(
      [
        this.statement(
          `INSERT INTO invitations(id,organization_id,project_id,supplier_id,email,role,token_hash,created_by,expires_at) SELECT ?,p.organization_id,p.id,?,?,?,?,?,? FROM projects p WHERE p.id=? AND ${g.text}`,
          id,
          v.supplier_id,
          v.email.toLowerCase(),
          v.role,
          hash,
          this.userId,
          new Date(Date.now() + v.expires_days * 86400000).toISOString(),
          v.project_id,
          ...g.args,
        ),
      ],
      p.organization_id,
      "invitation.created",
      id,
    );
    return { id, token, redeemable: false };
  }
  async revokeInvitation(id: string) {
    const g = projectScope("p", this.userId, true);
    const row = await this.statement(
      `SELECT i.organization_id FROM invitations i JOIN projects p ON p.id=i.project_id WHERE i.id=? AND ${g.text}`,
      id,
      ...g.args,
    ).first<{ organization_id: string }>();
    if (!row) throw new HttpError(403, "Invitation unavailable");
    await this.write(
      [
        this.statement(
          `UPDATE invitations SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND EXISTS(SELECT 1 FROM projects p WHERE p.id=invitations.project_id AND ${g.text})`,
          id,
          ...g.args,
        ),
      ],
      row.organization_id,
      "invitation.revoked",
      id,
    );
    return { ok: true };
  }
}
