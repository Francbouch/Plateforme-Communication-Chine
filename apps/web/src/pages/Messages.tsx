import { userError } from "../errors";
import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, useNavigate, useParams, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { api } from "../client";
import { isDemo } from "../demo";
import type { Project } from "../types";
import type {
  Conversation,
  Message,
  MessagePage,
} from "../../../../packages/shared/src/messages";
import { MessageCard } from "../messages/MessageCard";
import { MessageComposer } from "../messages/MessageComposer";
export function Messages({
  projects,
  actor,
}: {
  projects: Project[];
  actor: string;
}) {
  const { project: routeProject } = useParams(),
    [params] = useSearchParams(),
    navigate = useNavigate(),
    { t } = useTranslation();
  const project = routeProject ?? params.get("project") ?? "";
  return (
    <>
      <div className="page-title">
        <div>
          <span className="eyebrow">ForgeBridge</span>
          <h1>{t("messages")}</h1>
          <p>{t("messagesHelp")}</p>
        </div>
        <NavLink to={project ? `/projects/${project}/requests` : "/requests"}>
          {t("requests")}
        </NavLink>
      </div>
      <label>
        {t("project")}
        <select
          value={project}
          onChange={(e) =>
            navigate(
              e.target.value
                ? `/projects/${e.target.value}/messages`
                : "/messages",
            )
          }
        >
          <option value="">{t("selectProject")}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code} — {p.name}
            </option>
          ))}
        </select>
      </label>
      {isDemo ? (
        <p className="notice">{t("realLibraryOnly")}</p>
      ) : project ? (
        <ProjectMessages
          key={project}
          project={project}
          actor={actor}
          conversationId={params.get("conversation") ?? ""}
          anchorId={params.get("message") ?? ""}
        />
      ) : (
        <p>{t("selectProject")}</p>
      )}
    </>
  );
}
function ProjectMessages({
  project,
  actor,
  conversationId,
  anchorId,
}: {
  project: string;
  actor: string;
  conversationId: string;
  anchorId: string;
}) {
  const { t } = useTranslation(),
    navigate = useNavigate(),
    client = useQueryClient(),
    [archived, setArchived] = useState(false),
    [listPage, setListPage] = useState(0),
    [creating, setCreating] = useState(false),
    [title, setTitle] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [q, setQ] = useState(""),
    [query, setQuery] = useState(""),
    [searchPage, setSearchPage] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(q.trim());
      setSearchPage(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);
  const list = useQuery({
    queryKey: ["conversations", project, archived, listPage],
    queryFn: () =>
      api<{ items: Conversation[]; hasMore: boolean }>(
        `projects/${project}/conversations?archived=${archived ? 1 : 0}&page=${listPage}`,
      ),
  });
  const uploads = useQuery({
    queryKey: ["message-uploads", project],
    queryFn: () =>
      api<{ id: string; filename: string; conversation_title: string }[]>(
        `projects/${project}/message-uploads`,
      ),
  });
  async function cancelUpload(key: string) {
    setBusy(true);
    setError("");
    try {
      await api(`message-attachments/${key}`, undefined, "DELETE");
      await uploads.refetch();
    } catch (e) {
      setError(userError(e, t));
    } finally {
      setBusy(false);
    }
  }
  const search = useQuery({
    queryKey: ["message-search", project, query, searchPage],
    queryFn: () =>
      api<{
        items: {
          id: string;
          parent_id: string | null;
          conversation_id: string;
          body: string;
          author: string;
          created_at: string;
          conversation_title: string;
        }[];
        hasMore: boolean;
      }>(
        `projects/${project}/message-search?q=${encodeURIComponent(query)}&page=${searchPage}`,
      ),
    enabled: !!query,
  });
  function open(key: string, message?: string) {
    navigate(
      `/projects/${project}/messages?${new URLSearchParams({ conversation: key, ...(message ? { message } : {}) })}`,
    );
  }
  async function create() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ id: string }>(
        `projects/${project}/conversations`,
        { title },
      );
      setTitle("");
      setCreating(false);
      await client.invalidateQueries({ queryKey: ["conversations", project] });
      open(result.id);
    } catch (e) {
      setError(userError(e, t));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="toolbar">
        <label>
          {t("searchMessages")}
          <input
            type="search"
            value={q}
            maxLength={200}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <button
          onClick={() =>
            void client.invalidateQueries({
              queryKey: ["conversations", project],
            })
          }
        >
          {t("refreshMessages")}
        </button>
      </div>
      {query && (
        <section
          className="panel message-search"
          aria-label={t("searchResults")}
        >
          <h2>{t("searchResults")}</h2>
          {search.isError && <p role="alert">{t("error")}</p>}
          {search.isPending && <p>{t("loading")}</p>}
          {search.data?.items.map((m) => (
            <button
              key={m.id}
              onClick={() => {
                open(m.conversation_id, m.id);
                setQ("");
                setQuery("");
              }}
            >
              <strong>{m.conversation_title}</strong>
              <span>{m.body}</span>
              <small>
                {m.author} · {new Date(m.created_at).toLocaleString()}
              </small>
            </button>
          ))}
          {search.data?.items.length === 0 && <p>{t("empty")}</p>}
          <div className="toolbar">
            <button
              disabled={!searchPage}
              onClick={() => setSearchPage(searchPage - 1)}
            >
              {t("previous")}
            </button>
            <button
              disabled={!search.data?.hasMore}
              onClick={() => setSearchPage(searchPage + 1)}
            >
              {t("next")}
            </button>
          </div>
        </section>
      )}
      {!!uploads.data?.length && (
        <details className="panel">
          <summary>
            {t("unfinishedAttachments")} ({uploads.data.length})
          </summary>
          {uploads.data.map((f) => (
            <div key={f.id} className="toolbar">
              <span>
                {f.conversation_title} · {f.filename}
              </span>
              <button disabled={busy} onClick={() => void cancelUpload(f.id)}>
                {t("cancelUpload")}
              </button>
            </div>
          ))}
        </details>
      )}
      <div className="messaging-layout">
        <section className="conversation-list" aria-label={t("conversations")}>
          <div className="toolbar">
            <h2>{t("conversations")}</h2>
            <button onClick={() => setCreating(true)}>
              {t("newConversation")}
            </button>
          </div>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => {
                setArchived(e.target.checked);
                setListPage(0);
              }}
            />
            {t("archivedConversations")}
          </label>
          {creating && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <label>
                {t("conversationTitle")}
                <input
                  required
                  maxLength={160}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <button disabled={busy}>{t("create")}</button>
              <button type="button" onClick={() => setCreating(false)}>
                {t("cancel")}
              </button>
            </form>
          )}
          {(error || list.isError) && <p role="alert">{error || t("error")}</p>}
          {list.isPending && <p>{t("loading")}</p>}
          {list.data?.items.map((c) => (
            <button
              className="conversation-row"
              aria-current={c.id === conversationId ? "true" : undefined}
              key={c.id}
              onClick={() => open(c.id)}
            >
              <strong>{c.title}</strong>
              <span>{c.last_message || t("noMessages")}</span>
              <small>
                {new Date(c.updated_at).toLocaleString()} ·{" "}
                {t(c.archived ? "archived" : "active")}
              </small>
            </button>
          ))}
          {list.data?.items.length === 0 && <p>{t("empty")}</p>}
          <div className="toolbar">
            <button
              disabled={!listPage}
              onClick={() => setListPage(listPage - 1)}
            >
              {t("previous")}
            </button>
            <button
              disabled={!list.data?.hasMore}
              onClick={() => setListPage(listPage + 1)}
            >
              {t("next")}
            </button>
          </div>
        </section>
        {conversationId ? (
          <ConversationPane
            key={conversationId}
            id={conversationId}
            project={project}
            actor={actor}
            anchorId={anchorId}
          />
        ) : (
          <section className="panel">
            <p>{t("chooseConversation")}</p>
          </section>
        )}
      </div>
    </>
  );
}
function ConversationPane({
  id,
  project,
  actor,
  anchorId,
}: {
  id: string;
  project: string;
  actor: string;
  anchorId: string;
}) {
  const { t } = useTranslation(),
    client = useQueryClient(),
    [before, setBefore] = useState<string[]>([]),
    [thread, setThread] = useState<Message | null>(null),
    [replyBefore, setReplyBefore] = useState<string[]>([]),
    [renaming, setRenaming] = useState(false),
    [title, setTitle] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [history, setHistory] = useState(false),
    [historyPage, setHistoryPage] = useState(0);
  const conv = useQuery({
    queryKey: ["conversation", id],
    queryFn: () => api<Conversation>(`conversations/${id}`),
  });
  const enabled = conv.data?.project_id === project;
  const messages = useQuery({
    queryKey: ["conversation-messages", id, before.at(-1) ?? ""],
    queryFn: () =>
      api<MessagePage<Message>>(
        `conversations/${id}/messages?before=${before.at(-1) ?? ""}`,
      ),
    enabled,
    gcTime: 0,
  });
  const anchor = useQuery({
    queryKey: ["message-anchor", anchorId],
    queryFn: () => api<Message>(`messages/${anchorId}`),
    enabled: enabled && !!anchorId,
  });
  const parent = useQuery({
    queryKey: ["message-anchor-parent", anchor.data?.parent_id],
    queryFn: () => api<Message>(`messages/${anchor.data!.parent_id}`),
    enabled:
      enabled && anchor.data?.conversation_id === id && !!anchor.data.parent_id,
  });
  useEffect(() => {
    if (anchor.data?.conversation_id !== id) return;
    const root = anchor.data.parent_id ? parent.data : anchor.data;
    if (root) setThread(root);
  }, [anchor.data, parent.data, id]);
  const threadDetail = useQuery({
    queryKey: ["thread-message", thread?.id],
    queryFn: () => api<Message>(`messages/${thread!.id}`),
    enabled: enabled && !!thread,
  });
  const replies = useQuery({
    queryKey: ["conversation-replies", thread?.id, replyBefore.at(-1) ?? ""],
    queryFn: () =>
      api<MessagePage<Message>>(
        `messages/${thread!.id}/replies?before=${replyBefore.at(-1) ?? ""}`,
      ),
    enabled: enabled && !!thread,
    gcTime: 0,
  });
  const events = useQuery({
    queryKey: ["communication-history", id, historyPage],
    queryFn: () =>
      api<{
        items: {
          id: string;
          created_at: string;
          action: string;
          author: string;
          payload: string;
        }[];
        hasMore: boolean;
      }>(`conversations/${id}/history?page=${historyPage}`),
    enabled: enabled && history,
  });
  const refresh = () => {
    void Promise.all([
      client.invalidateQueries({ queryKey: ["conversation-messages", id] }),
      client.invalidateQueries({ queryKey: ["conversation-replies"] }),
      client.invalidateQueries({ queryKey: ["thread-message"] }),
      client.invalidateQueries({ queryKey: ["message-uploads", project] }),
      client.invalidateQueries({ queryKey: ["conversation", id] }),
      client.invalidateQueries({ queryKey: ["conversations", project] }),
      client.invalidateQueries({ queryKey: ["message-anchor"] }),
      client.invalidateQueries({ queryKey: ["communication-history", id] }),
    ]);
  };
  function openThread(m: Message) {
    setThread(m);
    setReplyBefore([]);
  }
  async function update(archive: boolean) {
    if (!conv.data) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `conversations/${id}`,
        {
          title: renaming ? title : conv.data.title,
          archived: archive,
          version: conv.data.version,
        },
        "PATCH",
      );
      setRenaming(false);
      refresh();
    } catch (e) {
      setError(userError(e, t));
    } finally {
      setBusy(false);
    }
  }
  function card(m: Message, highlight = false) {
    return (
      <MessageCard
        key={`${m.id}-${m.version}`}
        message={m}
        project={project}
        actor={actor}
        archived={!!conv.data?.archived}
        busy={busy}
        onReply={openThread}
        onChange={refresh}
        highlight={highlight}
      />
    );
  }
  const root = thread
    ? (threadDetail.data ??
      messages.data?.items.find((m) => m.id === thread.id) ??
      (anchor.data?.id === thread.id
        ? anchor.data
        : parent.data?.id === thread.id
          ? parent.data
          : thread))
    : null;
  if (conv.isError) return <p role="alert">{t("error")}</p>;
  if (conv.isPending) return <p>{t("loading")}</p>;
  if (!enabled) return <p role="alert">{t("referenceUnavailable")}</p>;
  return (
    <section className="conversation-pane" aria-label={t("conversation")}>
      <div className="conversation-header">
        <h2>{conv.data?.title}</h2>
        <div className="toolbar">
          <button
            disabled={busy}
            onClick={() => {
              setTitle(conv.data!.title);
              setRenaming(true);
            }}
          >
            {t("renameConversation")}
          </button>
          <button
            disabled={busy}
            onClick={() => void update(!conv.data!.archived)}
          >
            {t(
              conv.data?.archived
                ? "restoreConversation"
                : "archiveConversation",
            )}
          </button>
          <button onClick={refresh}>{t("refreshMessages")}</button>
          <button onClick={() => setHistory(!history)}>
            {t("communicationHistory")}
          </button>
        </div>
      </div>
      {renaming && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void update(!!conv.data?.archived);
          }}
        >
          <label>
            {t("conversationTitle")}
            <input
              required
              maxLength={160}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <button disabled={busy}>{t("save")}</button>
          <button type="button" onClick={() => setRenaming(false)}>
            {t("cancel")}
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {history && (
        <section className="panel">
          <h3>{t("communicationHistory")}</h3>
          {events.isError && <p role="alert">{t("error")}</p>}
          {events.data?.items.map((e) => (
            <details key={e.id}>
              <summary>
                {new Date(e.created_at).toLocaleString()} · {e.author} ·{" "}
                {t(`event_${e.action.replaceAll(".", "_")}`)}
              </summary>
              <CommunicationChange payload={e.payload} />
            </details>
          ))}
          <div className="toolbar">
            <button
              disabled={!historyPage}
              onClick={() => setHistoryPage(historyPage - 1)}
            >
              {t("previous")}
            </button>
            <button
              disabled={!events.data?.hasMore}
              onClick={() => setHistoryPage(historyPage + 1)}
            >
              {t("next")}
            </button>
          </div>
        </section>
      )}
      <div className="message-timeline" aria-label={t("messageHistory")}>
        <div className="toolbar">
          <button
            disabled={!messages.data?.next}
            onClick={() => setBefore([...before, messages.data!.next!])}
          >
            {t("olderMessages")}
          </button>
          <button
            disabled={!before.length}
            onClick={() => setBefore(before.slice(0, -1))}
          >
            {t("newerMessages")}
          </button>
        </div>
        {messages.isError && <p role="alert">{t("error")}</p>}
        {messages.isPending && <p>{t("loading")}</p>}
        {messages.data?.items.length === 0 && <p>{t("noMessages")}</p>}
        {messages.data?.items
          .slice()
          .reverse()
          .map((m) => card(m, m.id === anchorId))}
      </div>
      {conv.data?.archived ? (
        <p className="notice">{t("archivedReadOnly")}</p>
      ) : (
        <MessageComposer
          key={id}
          project={project}
          conversation={id}
          onSent={() => {
            setBefore([]);
            refresh();
          }}
        />
      )}
      {(anchor.isError || parent.isError) && (
        <p role="alert">{t("referenceUnavailable")}</p>
      )}
      {root && (
        <section className="message-thread" aria-label={t("thread")}>
          <div className="toolbar">
            <h3>{t("thread")}</h3>
            <button onClick={() => setThread(null)}>{t("closeThread")}</button>
          </div>
          {card(root, true)}
          {anchor.data?.parent_id === root.id &&
            !replies.data?.items.some((m) => m.id === anchorId) &&
            card(anchor.data, true)}
          {replies.isError && <p role="alert">{t("error")}</p>}
          {replies.data?.items
            .slice()
            .reverse()
            .map((m) => card(m, m.id === anchorId))}
          <div className="toolbar">
            <button
              disabled={!replies.data?.next}
              onClick={() =>
                setReplyBefore([...replyBefore, replies.data!.next!])
              }
            >
              {t("olderMessages")}
            </button>
            <button
              disabled={!replyBefore.length}
              onClick={() => setReplyBefore(replyBefore.slice(0, -1))}
            >
              {t("newerMessages")}
            </button>
          </div>
          {!conv.data?.archived && !root.deleted_at && (
            <MessageComposer
              key={root.id}
              project={project}
              conversation={id}
              parent={root.id}
              onSent={() => {
                setReplyBefore([]);
                refresh();
              }}
            />
          )}
        </section>
      )}
    </section>
  );
}

function CommunicationChange({ payload }: { payload: string }) {
  const { t } = useTranslation();
  const value = JSON.parse(payload) as Record<string, unknown>;
  const fields: Record<string, string> = {
    body: "messageContent",
    title: "requestTitle",
    description: "description",
    status: "status",
    priority: "priority",
    responsible: "responsible",
    due_date: "dueDate",
    shared: "sharedMessage",
    archived: "archived",
  };
  function values(data: unknown) {
    if (!data || typeof data !== "object") return null;
    return (
      <dl>
        {Object.entries(data)
          .filter(([key]) => key in fields)
          .map(([key, val]) => (
            <div key={key}>
              <dt>{t(fields[key])}</dt>
              <dd className="message-body">
                {typeof val === "boolean" || typeof val === "number"
                  ? t(val ? "yesValue" : "noValue")
                  : key === "status"
                    ? t(`request_${val}`)
                    : key === "priority"
                      ? t(`priority_${val}`)
                      : String(val ?? "—")}
              </dd>
            </div>
          ))}
      </dl>
    );
  }
  return value.before || value.after ? (
    <>
      <h4>{t("beforeChange")}</h4>
      {values(value.before)}
      <h4>{t("afterChange")}</h4>
      {values(value.after)}
    </>
  ) : (
    values(value)
  );
}
