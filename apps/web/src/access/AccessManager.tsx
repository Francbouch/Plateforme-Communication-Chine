import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../client";
import { qc } from "../query";
import { isDemo } from "../demo";
import type { Project, Supplier } from "../types";
import {
  permissionNames,
  rolePermissions,
  accessRoles,
  type Permissions,
} from "../../../../packages/shared/src/access";
type Member = {
  user_id: string;
  name: string;
  email: string;
  role: string;
  active: number;
  access_enabled: number;
  version: number;
  permissions: string;
  added_at: string;
};
type Invite = {
  id: string;
  email: string;
  role: string;
  status: string;
  delivery: string;
  expires_at: string;
};
export function AccessManager({
  org,
  projects,
}: {
  org: string;
  projects: Project[];
}) {
  const { t } = useTranslation(),
    [open, setOpen] = useState(false);
  if (isDemo) return null;
  return (
    <section className="panel access-manager" aria-label={t("access_title")}>
      <h2>{t("access_title")}</h2>
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>{t("access_manage")}</summary>
        {open && <Manager key={org} org={org} projects={projects} />}
      </details>
    </section>
  );
}
function Manager({ org, projects }: { org: string; projects: Project[] }) {
  const { t } = useTranslation(),
    [project, setProject] = useState(projects[0]?.id ?? ""),
    [email, setEmail] = useState(""),
    [role, setRole] = useState("supplier_engineer"),
    [supplier, setSupplier] = useState(""),
    [selected, setSelected] = useState<string[]>(
      projects[0] ? [projects[0].id] : [],
    ),
    [message, setMessage] = useState(""),
    [days, setDays] = useState(7),
    [notice, setNotice] = useState(""),
    [link, setLink] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<Member | null>(null),
    [memberRole, setMemberRole] = useState("reviewer"),
    [permissions, setPermissions] = useState<Permissions>(
      rolePermissions("reviewer"),
    ),
    [eventPage, setEventPage] = useState(0);
  const suppliers = useQuery({
      queryKey: ["suppliers", org],
      queryFn: () => api<Supplier[]>(`suppliers?organization_id=${org}`),
    }),
    invites = useQuery({
      queryKey: ["access", "invitations", org],
      queryFn: () => api<Invite[]>(`access/organizations/${org}/invitations`),
    }),
    members = useQuery({
      queryKey: ["access", "members", project],
      queryFn: () =>
        api<{ items: Member[] }>(`access/projects/${project}/members`),
      enabled: !!project,
    }),
    events = useQuery({
      queryKey: ["access", "events", org, eventPage],
      queryFn: () =>
        api<{
          items: {
            id: string;
            action: string;
            actor: string;
            created_at: string;
          }[];
          hasMore: boolean;
        }>(`access/organizations/${org}/events?page=${eventPage}`),
    });
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setNotice("");
    try {
      const r = (await fn()) as { invitation_url?: string; delivery?: string };
      if (r?.invitation_url) setLink(r.invitation_url);
      if (r?.delivery)
        setNotice(
          t(
            r.delivery === "sent"
              ? "access_email_sent"
              : "access_email_not_sent",
          ),
        );
      else setNotice(t("success"));
      await qc.invalidateQueries({ queryKey: ["access"] });
    } catch {
      setNotice(t("access_failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p>{t("access_activation_notice")}</p>
      <p role="status">{notice}</p>
      {link && (
        <label>
          {t("access_invitation_link")}
          <input
            aria-label={t("access_invitation_link")}
            readOnly
            value={link}
          />
          <button
            onClick={() => {
              void navigator.clipboard
                .writeText(link)
                .catch(() => setNotice(t("translation_copy_failed")));
            }}
          >
            {t("copy")}
          </button>
        </label>
      )}
      <form
        className="access-invite-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() =>
            api(`access/organizations/${org}/invitations`, {
              email,
              role,
              supplier_id: role === "supplier_engineer" ? supplier : null,
              project_ids: selected,
              message,
              expires_days: days,
            }),
          );
        }}
      >
        <h3>{t("access_invite")}</h3>
        <label>
          {t("email")}
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          {t("role")}
          <select
            aria-label={t("role")}
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            {accessRoles.map((r) => (
              <option key={r} value={r}>
                {t(`access_role_${r}`)}
              </option>
            ))}
          </select>
        </label>
        {role === "supplier_engineer" && (
          <label>
            {t("supplier")}
            <select
              aria-label={t("supplier")}
              required
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
            >
              <option value="">{t("selectSupplier")}</option>
              {suppliers.data
                ?.filter((s) => s.status === "active")
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <fieldset>
          <legend>{t("access_authorized_projects")}</legend>
          {projects.map((p) => (
            <label className="inline-check" key={p.id}>
              <input
                type="checkbox"
                checked={selected.includes(p.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, p.id]
                      : selected.filter((id) => id !== p.id),
                  )
                }
              />
              {p.code} — {p.name}
            </label>
          ))}
        </fieldset>
        <label>
          {t("access_invite_message")}
          <textarea
            maxLength={1000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        <label>
          {t("access_expiry_days")}
          <input
            type="number"
            min={1}
            max={14}
            required
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          />
        </label>
        <button disabled={busy || !selected.length}>
          {t("access_create_invitation")}
        </button>
      </form>
      <h3>{t("access_invitations")}</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("email")}</th>
              <th>{t("status")}</th>
              <th>{t("access_delivery")}</th>
              <th>{t("access_expiry")}</th>
              <th>{t("edit")}</th>
            </tr>
          </thead>
          <tbody>
            {invites.data?.map((i) => (
              <tr key={i.id}>
                <td>{i.email}</td>
                <td>{t(`access_${i.status}`)}</td>
                <td>{t(`access_delivery_${i.delivery}`)}</td>
                <td>{new Date(i.expires_at).toLocaleString()}</td>
                <td>
                  {["pending", "expired"].includes(i.status) && (
                    <>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            api(`access/invitations/${i.id}/resend`, {}),
                          )
                        }
                      >
                        {t("access_resend")}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            api(`access/invitations/${i.id}`, {}, "DELETE"),
                          )
                        }
                      >
                        {t("access_revoke")}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>{t("access_members")}</h3>
      <label>
        {t("project")}
        <select
          aria-label={t("access_members_project")}
          value={project}
          onChange={(e) => {
            setProject(e.target.value);
            setEditing(null);
          }}
        >
          <option value="">{t("selectProject")}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code} — {p.name}
            </option>
          ))}
        </select>
      </label>
      {members.isError && <p role="alert">{t("access_failed")}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {["name", "email", "role", "status", "access_added", "edit"].map(
                (k) => (
                  <th key={k}>{t(k)}</th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {members.data?.items.map((m) => (
              <tr key={m.user_id}>
                <td>{m.name}</td>
                <td>{m.email}</td>
                <td>{t(`access_role_${m.role}`)}</td>
                <td>
                  {t(
                    m.active && m.access_enabled ? "active" : "access_revoked",
                  )}
                </td>
                <td>
                  {m.added_at ? new Date(m.added_at).toLocaleDateString() : "—"}
                </td>
                <td>
                  <button
                    onClick={() => {
                      setEditing(m);
                      setMemberRole(m.role);
                      setPermissions({
                        ...rolePermissions(m.role),
                        ...JSON.parse(m.permissions),
                      });
                    }}
                  >
                    {t("access_edit_permissions")}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        api(
                          `access/projects/${project}/members/${m.user_id}`,
                          {
                            role: m.role,
                            active: false,
                            version: m.version,
                            permissions: {
                              ...rolePermissions(m.role),
                              ...JSON.parse(m.permissions),
                            },
                          },
                          "PATCH",
                        ),
                      )
                    }
                  >
                    {t("access_revoke")}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        api(
                          `access/organizations/${org}/revoke-sessions/${m.user_id}`,
                          {},
                        ),
                      )
                    }
                  >
                    {t("access_revoke_sessions")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <form
          className="access-permissions"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              api(
                `access/projects/${project}/members/${editing.user_id}`,
                {
                  role: memberRole,
                  active: true,
                  version: editing.version,
                  permissions,
                },
                "PATCH",
              ),
            ).then(() => setEditing(null));
          }}
        >
          <h4>{editing.email}</h4>
          <label>
            {t("role")}
            <select
              aria-label={t("access_member_role")}
              value={memberRole}
              onChange={(e) => {
                setMemberRole(e.target.value);
                setPermissions(rolePermissions(e.target.value));
              }}
            >
              {accessRoles
                .filter(
                  (r) =>
                    r.startsWith("supplier_") ===
                    editing.role.startsWith("supplier_"),
                )
                .map((r) => (
                  <option key={r} value={r}>
                    {t(`access_role_${r}`)}
                  </option>
                ))}
            </select>
          </label>
          <fieldset>
            <legend>{t("access_permissions")}</legend>
            {permissionNames.map((k) => (
              <label className="inline-check" key={k}>
                <input
                  type="checkbox"
                  checked={permissions[k]}
                  disabled={
                    (memberRole === "reviewer" &&
                      ![
                        "view_project",
                        "view_documents",
                        "download_documents",
                        "view_conversations",
                        "translate",
                      ].includes(k)) ||
                    (memberRole.startsWith("supplier_") &&
                      k === "manage_members")
                  }
                  onChange={(e) =>
                    setPermissions({ ...permissions, [k]: e.target.checked })
                  }
                />
                {t(`access_permission_${k}`)}
              </label>
            ))}
          </fieldset>
          <button disabled={busy}>{t("access_save_permissions")}</button>
          <button type="button" onClick={() => setEditing(null)}>
            {t("cancel")}
          </button>
        </form>
      )}
      {project && (
        <Sharing
          key={project}
          project={project}
          busy={busy}
          run={run}
          members={members.data?.items ?? []}
        />
      )}
      <h3>{t("access_events")}</h3>
      <ol>
        {events.data?.items.map((e) => (
          <li key={e.id}>
            <strong>{e.action}</strong> · {e.actor} ·{" "}
            {new Date(e.created_at).toLocaleString()}
          </li>
        ))}
      </ol>
      <button disabled={!eventPage} onClick={() => setEventPage(eventPage - 1)}>
        {t("previous")}
      </button>
      <button
        disabled={!events.data?.hasMore}
        onClick={() => setEventPage(eventPage + 1)}
      >
        {t("next")}
      </button>
    </>
  );
}
function Sharing({
  project,
  busy,
  run,
  members,
}: {
  project: string;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  members: Member[];
}) {
  const { t } = useTranslation(),
    [document, setDocument] = useState(""),
    [revisions, setRevisions] = useState<string[]>([]),
    [shared, setShared] = useState(false),
    [approver, setApprover] = useState(""),
    [requestAssignee, setRequestAssignee] = useState("");
  const docs = useQuery({
      queryKey: ["access", "share-docs", project],
      queryFn: () =>
        api<{ items: { id: string; name: string }[] }>(
          `projects/${project}/documents?folder_id=all`,
        ),
    }),
    detail = useQuery({
      queryKey: ["access", "sharing", document],
      queryFn: () =>
        api<{
          shared: boolean;
          revisions: { id: string; label: string; shared: number }[];
        }>(`access/documents/${document}/sharing`),
      enabled: !!document,
    }),
    convs = useQuery({
      queryKey: ["access", "share-convs", project],
      queryFn: () =>
        api<{
          items: { id: string; title: string; externally_shared: number }[];
        }>(`projects/${project}/conversations`),
    }),
    approvals = useQuery({
      queryKey: ["access", "share-approvals", project],
      queryFn: () =>
        api<{
          items: {
            id: string;
            title: string;
            status: string;
            approver_id: string | null;
            externally_shared: number;
          }[];
        }>(`projects/${project}/approvals`),
    });
  const requests = useQuery({
    queryKey: ["access", "share-requests", project],
    queryFn: () =>
      api<{
        items: { id: string; title: string; assignee_id: string | null }[];
      }>(`projects/${project}/requests`),
  });
  useEffect(() => {
    if (detail.data) {
      setShared(detail.data.shared);
      setRevisions(
        detail.data.revisions.filter((r) => r.shared).map((r) => r.id),
      );
    }
  }, [detail.data]);
  return (
    <section className="access-sharing">
      <h3>{t("access_sharing")}</h3>
      <p>{t("access_sharing_notice")}</p>
      <label>
        {t("document")}
        <select
          aria-label={t("access_share_document")}
          value={document}
          onChange={(e) => {
            setDocument(e.target.value);
            setRevisions([]);
            setShared(false);
          }}
        >
          <option value="">{t("selectDocument")}</option>
          {docs.data?.items.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      {detail.data && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              api(
                `access/documents/${document}/sharing`,
                { shared, revision_ids: revisions },
                "PATCH",
              ),
            );
          }}
        >
          <p>
            {t(
              detail.data.shared
                ? "access_currently_shared"
                : "access_currently_internal",
            )}
          </p>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={shared}
              onChange={(e) => setShared(e.target.checked)}
            />
            {t("access_share_selected_revisions")}
          </label>
          {detail.data.revisions.map((r) => (
            <label key={r.id} className="inline-check">
              <input
                type="checkbox"
                checked={revisions.includes(r.id)}
                onChange={(e) =>
                  setRevisions(
                    e.target.checked
                      ? [...revisions, r.id]
                      : revisions.filter((id) => id !== r.id),
                  )
                }
              />
              {t("revision")} {r.label} ·{" "}
              {t(
                r.shared
                  ? "access_currently_shared"
                  : "access_currently_internal",
              )}
            </label>
          ))}
          <button disabled={busy}>{t("access_save_sharing")}</button>
        </form>
      )}
      <h4>{t("messages")}</h4>
      {convs.data?.items.map((c) => (
        <p key={c.id}>
          {c.title} ·{" "}
          {t(
            c.externally_shared
              ? "access_currently_shared"
              : "access_currently_internal",
          )}{" "}
          <button
            disabled={busy}
            onClick={() =>
              void run(() =>
                api(
                  `access/conversations/${c.id}/sharing`,
                  { shared: !c.externally_shared },
                  "PATCH",
                ),
              )
            }
          >
            {t(c.externally_shared ? "access_unshare" : "access_share")}
          </button>
        </p>
      ))}
      <h4>{t("requests")}</h4>
      <label>
        {t("responsible")}
        <select
          aria-label={t("access_request_assignee")}
          value={requestAssignee}
          onChange={(e) => setRequestAssignee(e.target.value)}
        >
          <option value="">{t("select")}</option>
          {members
            .filter((m) => m.active)
            .map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.email}
              </option>
            ))}
        </select>
      </label>
      {requests.data?.items.map((r) => (
        <p key={r.id}>
          {r.title}
          <button
            disabled={busy || !requestAssignee}
            onClick={() =>
              void run(() =>
                api(
                  `access/requests/${r.id}/assignee`,
                  { assignee_id: requestAssignee },
                  "PATCH",
                ),
              )
            }
          >
            {t("access_assign_request")}
          </button>
        </p>
      ))}
      <h4>{t("approvals")}</h4>
      <p>{t("access_approver_frozen")}</p>
      <label>
        {t("access_approver")}
        <select
          aria-label={t("access_approver")}
          value={approver}
          onChange={(e) => setApprover(e.target.value)}
        >
          <option value="">{t("select")}</option>
          {members
            .filter((m) => m.active && JSON.parse(m.permissions).approve)
            .map((m) => (
              <option value={m.user_id} key={m.user_id}>
                {m.email}
              </option>
            ))}
        </select>
      </label>
      {approvals.data?.items.map((a) => (
        <p key={a.id}>
          {a.title} · {t(`approval_${a.status}`)}{" "}
          <button
            disabled={
              busy || (a.status === "draft" ? !approver : !a.approver_id)
            }
            onClick={() =>
              void run(() =>
                api(
                  `access/approvals/${a.id}/sharing`,
                  {
                    shared: !a.externally_shared,
                    approver_id:
                      a.status === "draft" ? approver : a.approver_id,
                  },
                  "PATCH",
                ),
              )
            }
          >
            {t(a.externally_shared ? "access_unshare" : "access_share")}
          </button>
        </p>
      ))}
    </section>
  );
}
