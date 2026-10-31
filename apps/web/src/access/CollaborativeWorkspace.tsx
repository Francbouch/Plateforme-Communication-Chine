import { ProjectMembers } from "./ProjectMembers";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../client";
import { qc } from "../query";
import { DocumentViewer } from "../components/DocumentViewer";
import {
  TranslatedText,
  TranslationPermissions,
} from "../translations/TranslatedText";
import type { Revision } from "../../../../packages/shared/src/documents";
import type { ProjectAccess } from "../../../../packages/shared/src/access";
export async function logout() {
  await api("access/logout", {});
  qc.clear();
  window.location.assign("/cdn-cgi/access/logout");
}
export function AcceptInvitation({ token }: { token: string }) {
  const { t } = useTranslation(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="access-entry panel">
      <h1>{t("access_accept")}</h1>
      <p>{t("access_accept_notice")}</p>
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void api("access/invitations/accept", { token })
            .then(() => {
              window.location.assign("/");
            })
            .catch(() => {
              setError(t("access_invalid_invitation"));
              setBusy(false);
            });
        }}
      >
        {t("access_accept")}
      </button>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
export function CollaborativeWorkspace({
  actor,
}: {
  actor: { id: string; name: string; language: string; timezone: string };
}) {
  const { t, i18n } = useTranslation(),
    [project, setProject] = useState(""),
    [error, setError] = useState("");
  const projects = useQuery({
    queryKey: ["collaboration", "projects"],
    queryFn: () => api<ProjectAccess[]>("collaboration/projects"),
    staleTime: 0,
    refetchInterval: 30000,
  });
  const current =
    projects.data?.find((p) => p.id === project) ?? projects.data?.[0];
  return (
    <div className="collaborative-shell">
      <header>
        <strong>ForgeBridge</strong>
        <span>{actor.name}</span>
        <select
          aria-label={t("language")}
          value={i18n.language}
          onChange={(e) => {
            const language = e.target.value;
            void api(
              "me",
              { name: actor.name, timezone: actor.timezone, language },
              "PATCH",
            )
              .then(() => i18n.changeLanguage(language))
              .catch(() => setError(t("access_failed")));
          }}
        >
          <option value="fr-CA">Français</option>
          <option value="en">English</option>
          <option value="zh-CN">简体中文</option>
        </select>
        <button
          onClick={() => {
            void logout().catch(() => setError(t("access_failed")));
          }}
        >
          {t("logout")}
        </button>
      </header>
      <main>
        <h1>{t("access_my_workspace")}</h1>
        <label>
          {t("project")}
          <select
            aria-label={t("project")}
            value={current?.id ?? ""}
            onChange={(e) => setProject(e.target.value)}
          >
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} — {p.name}
              </option>
            ))}
          </select>
        </label>
        {(projects.isError || error) && (
          <p role="alert">{error || t("access_unavailable")}</p>
        )}
        {projects.data?.length === 0 && <p>{t("access_no_projects")}</p>}
        {current && (
          <ProjectSpace key={current.id} project={current} actor={actor.id} />
        )}
      </main>
    </div>
  );
}
function ProjectSpace({
  project: p,
  actor,
}: {
  project: ProjectAccess;
  actor: string;
}) {
  const { t } = useTranslation(),
    [tab, setTab] = useState("documents");
  const summary = useQuery({
    queryKey: ["collaboration", "summary", p.id],
    queryFn: () =>
      api<{ documents: number; conversations: number }>(
        `collaboration/projects/${p.id}/summary`,
      ),
  });
  const tabs = [
    ...(p.permissions.view_documents ? ["documents"] : []),
    ...(p.permissions.view_conversations ? ["messages", "requests"] : []),
    ...(p.permissions.view_approvals ? ["approvals"] : []),
    ...(p.permissions.manage_members ? ["access_members"] : []),
  ];
  return (
    <TranslationPermissions.Provider
      value={{
        translate: p.permissions.translate,
        correct: p.permissions.correct_translations,
      }}
    >
      <p>
        {summary.data?.documents ?? 0} {t("documents")} ·{" "}
        {summary.data?.conversations ?? 0} {t("conversations")}
      </p>
      <nav className="toolbar" aria-label={t("access_workspace_sections")}>
        {tabs.map((k) => (
          <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>
            {t(k)}
          </button>
        ))}
      </nav>
      {tab === "access_members" && p.permissions.manage_members && (
        <ProjectMembers project={p.id} actor={actor} />
      )}
      {tab === "documents" && p.permissions.view_documents && (
        <Documents project={p} actor={actor} />
      )}
      {tab === "messages" && p.permissions.view_conversations && (
        <Conversations project={p} actor={actor} />
      )}
      {tab === "requests" && p.permissions.view_conversations && (
        <Requests project={p} />
      )}
      {tab === "approvals" && p.permissions.view_approvals && (
        <Approvals project={p} />
      )}
    </TranslationPermissions.Provider>
  );
}
function Pager({
  page,
  setPage,
  more,
}: {
  page: number;
  setPage: (n: number) => void;
  more?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="toolbar">
      <button disabled={!page} onClick={() => setPage(page - 1)}>
        {t("previous")}
      </button>
      <button disabled={!more} onClick={() => setPage(page + 1)}>
        {t("next")}
      </button>
    </div>
  );
}
function Documents({
  project: p,
  actor,
}: {
  project: ProjectAccess;
  actor: string;
}) {
  const { t } = useTranslation(),
    [q, setQ] = useState(""),
    [page, setPage] = useState(0),
    [document, setDocument] = useState(""),
    [revision, setRevision] = useState(""),
    [point, setPoint] = useState("");
  const list = useQuery({
      queryKey: ["collaboration", "documents", p.id, q, page],
      queryFn: () =>
        api<{
          items: {
            id: string;
            name: string;
            revision_id: string;
            label: string;
          }[];
          hasMore: boolean;
        }>(
          `collaboration/projects/${p.id}/documents?${new URLSearchParams({ q, page: String(page) })}`,
        ),
    }),
    detail = useQuery({
      queryKey: ["collaboration", "document", document],
      queryFn: () =>
        api<{ document: { name: string }; revisions: Revision[] }>(
          `collaboration/documents/${document}`,
        ),
      enabled: !!document,
    });
  const current =
    detail.data?.revisions.find((r) => r.id === revision) ??
    detail.data?.revisions[0];
  const points = useQuery({
    queryKey: ["collaboration", "points", current?.id],
    queryFn: () =>
      api<{
        items: {
          id: string;
          title: string;
          summary: string;
          status: string;
          page: number;
        }[];
      }>(`collaboration/revisions/${current!.id}/points`),
    enabled: !!current,
  });
  return (
    <section className="panel">
      <h2>{t("documents")}</h2>
      <label>
        {t("search")}
        <input
          type="search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(0);
          }}
        />
      </label>
      {list.isError && <p role="alert">{t("access_unavailable")}</p>}
      <ul>
        {list.data?.items.map((d) => (
          <li key={d.id}>
            <button
              onClick={() => {
                setDocument(d.id);
                setRevision(d.revision_id);
                setPoint("");
              }}
            >
              {d.name} · {t("revision")} {d.label}
            </button>
          </li>
        ))}
      </ul>
      <Pager page={page} setPage={setPage} more={list.data?.hasMore} />
      {p.permissions.add_documents && <Upload project={p.id} />}
      {detail.isError && <p role="alert">{t("access_unavailable")}</p>}
      {current && (
        <>
          <h3>{detail.data?.document.name}</h3>
          <label>
            {t("revision")}
            <select
              aria-label={t("revision")}
              value={current.id}
              onChange={(e) => {
                setRevision(e.target.value);
                setPoint("");
              }}
            >
              {detail.data?.revisions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          {p.permissions.download_documents && (
            <DocumentViewer
              revision={current}
              readOnly
              contentUrl={`/api/v1/collaboration/revisions/${current.id}/content`}
              collaboration={{
                pointId: point || undefined,
                canAnnotate: p.permissions.annotate && (!p.external || !!point),
                actorId: actor,
              }}
            />
          )}
          {p.permissions.add_revisions && (
            <Upload project={p.id} document={current.document_id} />
          )}
          <h3>{t("technicalPoints")}</h3>
          {points.data?.items.map((i) => (
            <article className="review-message" key={i.id}>
              <button onClick={() => setPoint(point === i.id ? "" : i.id)}>
                {i.title} · {t("page")} {i.page} · {t(`review_${i.status}`)}
              </button>
              <TranslatedText
                source={{ kind: "review_item", id: i.id, field: "summary" }}
                text={i.summary}
              />
              {point === i.id && (
                <PointThread id={i.id} canReply={p.permissions.reply_points} />
              )}
            </article>
          ))}
          {p.permissions.annotate && p.external && (
            <p>{t("access_annotation_point")}</p>
          )}
          {p.permissions.create_points && (
            <TextForm
              label={t("access_create_point")}
              submit={async (body) => {
                await api(`revisions/${current.id}/review-items`, {
                  id: crypto.randomUUID(),
                  title: body.slice(0, 200),
                  summary: body,
                  page: 1,
                  type: "discussion",
                  geometry: { points: [] },
                });
                await points.refetch();
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
function TextForm({
  label,
  submit,
}: {
  label: string;
  submit: (body: string) => Promise<void>;
}) {
  const { t } = useTranslation(),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="access-text-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        void submit(text)
          .then(() => setText(""))
          .catch(() => setError(t("access_failed")))
          .finally(() => setBusy(false));
      }}
    >
      <label>
        {label}
        <textarea
          aria-label={label}
          required
          maxLength={4000}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <button disabled={busy || !text.trim()}>{t("send")}</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
function PointThread({ id, canReply }: { id: string; canReply: boolean }) {
  const { t } = useTranslation(),
    [page, setPage] = useState(0);
  const data = useQuery({
    queryKey: ["collaboration", "point-messages", id, page],
    queryFn: () =>
      api<{
        items: { id: string; body: string; author: string }[];
        hasMore: boolean;
      }>(`collaboration/review-items/${id}/messages?page=${page}`),
  });
  return (
    <>
      <div>
        {data.data?.items.map((m) => (
          <article key={m.id}>
            <strong>{m.author}</strong>
            <TranslatedText
              source={{ kind: "review_message", id: m.id, field: "body" }}
              text={m.body}
            />
          </article>
        ))}
      </div>
      <Pager page={page} setPage={setPage} more={data.data?.hasMore} />
      {canReply && (
        <TextForm
          label={t("reply")}
          submit={async (body) => {
            await api(`review-items/${id}/messages`, {
              id: crypto.randomUUID(),
              body,
            });
            await data.refetch();
          }}
        />
      )}
    </>
  );
}
function Upload({ project, document }: { project: string; document?: string }) {
  const { t } = useTranslation(),
    [label, setLabel] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState("");
  return (
    <details>
      <summary>{t(document ? "newRevision" : "uploadDocuments")}</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!file) return;
          setBusy(true);
          setStatus("");
          void (async () => {
            const bytes = await file.arrayBuffer();
            const sha256 = [
              ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            ]
              .map((x) => x.toString(16).padStart(2, "0"))
              .join("");
            const u = await api<{ id: string }>(`projects/${project}/uploads`, {
              name: file.name,
              filename: file.name,
              size: file.size,
              sha256,
              label,
              document_id: document ?? null,
            });
            const response = await fetch(`/api/v1/uploads/${u.id}/content`, {
              method: "PUT",
              credentials: "same-origin",
              body: file,
            });
            if (!response.ok) throw new Error("Upload failed");
            await api(`uploads/${u.id}/complete`, {});
            setStatus(t("access_submission_received"));
            setFile(null);
            await qc.invalidateQueries({ queryKey: ["collaboration"] });
          })()
            .catch(() => setStatus(t("access_failed")))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          {t("revision")}
          <input
            required
            maxLength={40}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label>
          {t("file")}
          <input
            type="file"
            required
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <button disabled={busy || !file}>{t("uploadDocuments")}</button>
        <p role="status">{status}</p>
      </form>
    </details>
  );
}
function Conversations({
  project: p,
  actor,
}: {
  project: ProjectAccess;
  actor: string;
}) {
  const { t } = useTranslation(),
    [conversation, setConversation] = useState(""),
    [page, setPage] = useState(0),
    [q, setQ] = useState("");
  const list = useQuery({
      queryKey: ["collaboration", "conversations", p.id],
      queryFn: () =>
        api<{ items: { id: string; title: string }[] }>(
          `collaboration/projects/${p.id}/conversations`,
        ),
    }),
    messages = useQuery({
      queryKey: ["collaboration", "messages", conversation, page, q],
      queryFn: () =>
        api<{
          items: {
            id: string;
            body: string;
            author: string;
            author_id: string;
            attachments: { id: string; filename: string }[];
            references: {
              document_id: string;
              revision_id: string;
              page: number;
            }[];
          }[];
          hasMore: boolean;
        }>(
          `collaboration/conversations/${conversation}/messages?${new URLSearchParams({ page: String(page), q })}`,
        ),
      enabled: !!conversation,
    });
  return (
    <section className="panel">
      <h2>{t("messages")}</h2>
      <label>
        {t("conversations")}
        <select
          aria-label={t("conversations")}
          value={conversation}
          onChange={(e) => {
            setConversation(e.target.value);
            setPage(0);
          }}
        >
          <option value="">{t("select")}</option>
          {list.data?.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </label>
      {conversation && (
        <>
          <label>
            {t("search")}
            <input
              type="search"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(0);
              }}
            />
          </label>
          {messages.isError && <p role="alert">{t("access_unavailable")}</p>}
          {messages.data?.items.map((m) => (
            <article
              className="message-card"
              data-testid={`member-message-${m.id}`}
              key={m.id}
            >
              <strong>{m.author}</strong>
              <TranslatedText
                source={{ kind: "message", id: m.id, field: "body" }}
                text={m.body}
              />
              {p.permissions.download_documents &&
                m.attachments.map((a) => (
                  <a
                    key={a.id}
                    href={`/api/v1/collaboration/attachments/${a.id}/content`}
                  >
                    {a.filename}
                  </a>
                ))}
              {p.permissions.download_documents &&
                m.references.map((r, i) => (
                  <a
                    key={i}
                    href={`/api/v1/collaboration/revisions/${r.revision_id}/content`}
                  >
                    {t("document")} · {t("page")} {r.page}
                  </a>
                ))}
              {p.permissions.create_requests && (
                <TextForm
                  label={t("createRequest")}
                  submit={async (title) => {
                    await api(`messages/${m.id}/requests`, {
                      title,
                      description: title,
                    });
                  }}
                />
              )}
              {m.author_id === actor && (
                <small>{t("access_your_message")}</small>
              )}
            </article>
          ))}
          <Pager page={page} setPage={setPage} more={messages.data?.hasMore} />
          {p.permissions.participate_conversations && (
            <TextForm
              label={t("writeMessage")}
              submit={async (body) => {
                await api(`conversations/${conversation}/messages`, {
                  id: crypto.randomUUID(),
                  body,
                  shared: true,
                });
                setPage(0);
                setQ("");
                await messages.refetch();
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
function Requests({ project: p }: { project: ProjectAccess }) {
  const { t } = useTranslation(),
    [page, setPage] = useState(0);
  const data = useQuery({
    queryKey: ["collaboration", "requests", p.id, page],
    queryFn: () =>
      api<{
        items: {
          id: string;
          title: string;
          description: string;
          status: string;
        }[];
        hasMore: boolean;
      }>(`collaboration/projects/${p.id}/requests?page=${page}`),
  });
  return (
    <section className="panel">
      <h2>{t("requests")}</h2>
      {data.data?.items.map((r) => (
        <article key={r.id}>
          <h3>{r.title}</h3>
          <p>{t(`request_${r.status}`)}</p>
          <TranslatedText
            source={{ kind: "request", id: r.id, field: "description" }}
            text={r.description}
          />
        </article>
      ))}
      <Pager page={page} setPage={setPage} more={data.data?.hasMore} />
    </section>
  );
}
function Approvals({ project: p }: { project: ProjectAccess }) {
  const { t } = useTranslation(),
    [page, setPage] = useState(0),
    [selected, setSelected] = useState(""),
    [action, setAction] = useState("approve"),
    [comment, setComment] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState("");
  const data = useQuery({
    queryKey: ["collaboration", "approvals", p.id, page],
    queryFn: () =>
      api<{
        items: {
          id: string;
          title: string;
          description: string;
          status: string;
          revision_label: string;
          version: number;
          decision_comment: string;
          decision_identity: string | null;
        }[];
        hasMore: boolean;
      }>(`collaboration/projects/${p.id}/approvals?page=${page}`),
  });
  return (
    <section className="panel">
      <h2>{t("approvals")}</h2>
      {data.data?.items.map((a) => (
        <article className="approval-detail" key={a.id}>
          <h3>
            {a.title} · {t("revision")} {a.revision_label}
          </h3>
          <p>{t(`approval_${a.status}`)}</p>
          <TranslatedText
            source={{ kind: "approval", id: a.id, field: "description" }}
            text={a.description}
            official
          />
          <TranslatedText
            source={{ kind: "approval", id: a.id, field: "decision_comment" }}
            text={a.decision_comment}
            official
          />
          {(a.decision_identity || a.decision_comment) && (
            <p>
              {t(
                a.decision_identity
                  ? "access_authenticated_decision"
                  : "access_legacy_decision",
              )}
            </p>
          )}
          {p.permissions.approve && a.status === "pending" && (
            <button
              onClick={() => {
                setSelected(a.id);
                setConfirmed(false);
                setComment("");
              }}
            >
              {t("access_decide")}
            </button>
          )}
          {selected === a.id && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setError("");
                void api(`approvals/${a.id}/actions`, {
                  action,
                  version: a.version,
                  comment,
                  confirmed,
                })
                  .then(() => {
                    setSelected("");
                    void data.refetch();
                  })
                  .catch(() => setError(t("access_failed")));
              }}
            >
              <label>
                {t("approvalDecision")}
                <select
                  aria-label={t("approvalDecision")}
                  value={action}
                  onChange={(e) => setAction(e.target.value)}
                >
                  {["approve", "reject", "request_changes"].map((k) => (
                    <option key={k} value={k}>
                      {t(`approvalAction_${k}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("approvalJustification")}
                <textarea
                  required={action !== "approve"}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  maxLength={4000}
                />
              </label>
              <label className="inline-check">
                <input
                  type="checkbox"
                  required
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                {t("access_confirm_decision")}
              </label>
              <button disabled={!confirmed}>{t("confirm")}</button>
              {error && <p role="alert">{error}</p>}
            </form>
          )}
        </article>
      ))}
      <Pager page={page} setPage={setPage} more={data.data?.hasMore} />
    </section>
  );
}
