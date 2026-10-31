import { Store } from "./database";
import { HttpError } from "./types";
import {
  rolePermissions,
  type Permission,
  type ProjectAccess,
  type Permissions,
} from "../../../packages/shared/src/access";
export const unavailable = () => new HttpError(404, "Resource unavailable");
interface MembershipRow {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  org_role: string;
  role: string;
  permissions: string | null;
  supplier_id: string | null;
}
const membershipQuery = `SELECT p.id,p.organization_id,p.code,p.name,om.role AS org_role,pm.role,pm.permissions,pm.supplier_id FROM projects p JOIN organization_memberships om ON om.organization_id=p.organization_id JOIN profiles u ON u.id=om.user_id LEFT JOIN project_memberships pm ON pm.project_id=p.id AND pm.user_id=u.id AND pm.active=1 AND pm.access_enabled=1 WHERE (? IS NULL OR p.id=?) AND om.user_id=? AND om.active=1 AND u.status='active' AND (om.role='owner' OR pm.user_id IS NOT NULL) AND (pm.supplier_id IS NULL OR EXISTS(SELECT 1 FROM supplier_memberships sm JOIN suppliers sp ON sp.id=sm.supplier_id JOIN project_suppliers ps ON ps.supplier_id=sp.id AND ps.project_id=p.id WHERE sm.user_id=u.id AND sm.supplier_id=pm.supplier_id AND sm.active=1 AND sp.status='active'))`;
function accessFromRow(
  r: MembershipRow | null,
  permission: Permission = "view_project",
): ProjectAccess {
  if (!r) throw unavailable();
  const owner = r.org_role === "owner",
    role = owner ? "owner" : r.role;
  const permissions = owner
    ? (Object.fromEntries(
        Object.keys(rolePermissions("reviewer")).map((k) => [k, true]),
      ) as Permissions)
    : { ...rolePermissions(role), ...JSON.parse(r.permissions ?? "{}") };
  if (role === "reviewer")
    for (const key of [
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
      permissions[key] = false;
  if (r.supplier_id && !owner) permissions.manage_members = false;
  if (!permissions.view_project || !permissions[permission])
    throw unavailable();
  return {
    id: r.id,
    organization_id: r.organization_id,
    code: r.code,
    name: r.name,
    role,
    external: !owner && (!!r.supplier_id || role === "reviewer"),
    permissions,
  };
}
export async function membership(
  s: Store,
  project: string,
  permission: Permission = "view_project",
): Promise<ProjectAccess> {
  return accessFromRow(
    await s
      .statement(membershipQuery, project, project, s.userId)
      .first<MembershipRow>(),
    permission,
  );
}
export async function visibleProjects(s: Store) {
  const rows = await s.all<MembershipRow>(
    membershipQuery + " ORDER BY p.updated_at DESC,p.id LIMIT 200",
    null,
    null,
    s.userId,
  );
  const result: ProjectAccess[] = [];
  for (const row of rows) {
    try {
      result.push(accessFromRow(row));
    } catch {
      /* A revoked view permission is not a visible project. */
    }
  }
  return result;
}

export async function documentAccess(
  s: Store,
  id: string,
  permission: Permission = "view_documents",
) {
  const d = await s
    .statement("SELECT * FROM documents WHERE id=?", id)
    .first<{ id: string; project_id: string; externally_shared: number }>();
  if (!d) throw unavailable();
  const access = await membership(s, d.project_id, permission);
  if (
    !access.permissions.view_documents ||
    (access.external && !d.externally_shared)
  )
    throw unavailable();
  return { document: d, access };
}
export async function revisionAccess(
  s: Store,
  id: string,
  permission: Permission = "view_documents",
) {
  const r = await s
    .statement("SELECT * FROM document_revisions WHERE id=?", id)
    .first<{ id: string; document_id: string }>();
  if (!r) throw unavailable();
  const d = await documentAccess(s, r.document_id, permission);
  if (
    d.access.external &&
    !(await s
      .statement("SELECT 1 FROM revision_shares WHERE revision_id=?", id)
      .first())
  )
    throw unavailable();
  return { ...d, revision: r };
}
export async function pointAccess(
  s: Store,
  id: string,
  permission: Permission = "view_documents",
) {
  const p = await s
    .statement(
      "SELECT * FROM review_items WHERE id=? AND is_point=1 AND point_deleted_at IS NULL",
      id,
    )
    .first<{ id: string; revision_id: string; publication: string }>();
  if (!p) throw unavailable();
  const r = await revisionAccess(s, p.revision_id, permission);
  if (r.access.external && p.publication !== "published") throw unavailable();
  return { ...r, point: p };
}
export async function conversationAccess(
  s: Store,
  id: string,
  permission: Permission = "view_conversations",
) {
  const conversation = await s
    .statement("SELECT * FROM project_conversations WHERE id=?", id)
    .first<{ id: string; project_id: string; externally_shared: number }>();
  if (!conversation) throw unavailable();
  const access = await membership(s, conversation.project_id, permission);
  if (
    !access.permissions.view_conversations ||
    (access.external && !conversation.externally_shared)
  )
    throw unavailable();
  return { conversation, access };
}
export async function messageAccess(
  s: Store,
  id: string,
  permission: Permission = "view_conversations",
) {
  const message = await s
    .statement(
      "SELECT * FROM conversation_messages WHERE id=? AND deleted_at IS NULL",
      id,
    )
    .first<{
      id: string;
      conversation_id: string;
      shared: number;
      author_id: string;
    }>();
  if (!message) throw unavailable();
  const r = await conversationAccess(s, message.conversation_id, permission);
  if (
    (!message.shared && message.author_id !== s.userId) ||
    (r.access.external && !message.shared)
  )
    throw unavailable();
  return { ...r, message };
}
export async function approvalAccess(
  s: Store,
  id: string,
  permission: Permission = "view_approvals",
) {
  const approval = await s
    .statement(
      "SELECT * FROM approval_requests WHERE id=? AND deleted_at IS NULL",
      id,
    )
    .first<{
      id: string;
      revision_id: string;
      status: string;
      externally_shared: number;
      approver_id: string | null;
      requester_id: string;
    }>();
  if (!approval) throw unavailable();
  const r = await revisionAccess(s, approval.revision_id, permission);
  if (
    (approval.status === "draft" && approval.requester_id !== s.userId) ||
    (r.access.external &&
      (!approval.externally_shared ||
        approval.status === "draft" ||
        approval.approver_id !== s.userId))
  )
    throw unavailable();
  return { ...r, approval };
}
export async function translationAccess(
  s: Store,
  ref: { kind: string; id: string; field: string },
  correction = false,
) {
  let project: string | undefined;
  if (ref.kind === "message")
    project = (await messageAccess(s, ref.id)).access.id;
  if (ref.kind === "review_item")
    project = (await pointAccess(s, ref.id)).access.id;
  if (ref.kind === "review_message") {
    const r = await s
      .statement("SELECT item_id FROM review_messages WHERE id=?", ref.id)
      .first<{ item_id: string }>();
    if (!r) throw unavailable();
    project = (await pointAccess(s, r.item_id)).access.id;
  }
  if (ref.kind === "approval")
    project = (await approvalAccess(s, ref.id)).access.id;
  if (ref.kind === "approval_event") {
    const r = await s
      .statement("SELECT approval_id FROM approval_events WHERE id=?", ref.id)
      .first<{ approval_id: string }>();
    if (!r) throw unavailable();
    project = (await approvalAccess(s, r.approval_id)).access.id;
  }
  if (ref.kind === "request") {
    const r = await s
      .statement(
        "SELECT project_id,message_id,assignee_id,created_by FROM technical_requests WHERE id=?",
        ref.id,
      )
      .first<{
        project_id: string;
        message_id: string;
        assignee_id: string | null;
        created_by: string;
      }>();
    if (!r) throw unavailable();
    const a = await messageAccess(s, r.message_id);
    if (
      a.access.external &&
      r.assignee_id !== s.userId &&
      r.created_by !== s.userId
    )
      throw unavailable();
    project = r.project_id;
  }
  if (!project) throw unavailable();
  return membership(
    s,
    project,
    correction ? "correct_translations" : "translate",
  );
}
