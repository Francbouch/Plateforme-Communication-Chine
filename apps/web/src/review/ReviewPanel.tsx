import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../client";
import type { Account } from "../types";
import { qc } from "../query";
import type { Revision, Page } from "../../../../packages/shared/src/documents";
import {
  reviewStatuses,
  reviewColors,
  type ReviewItem,
  type ReviewMessage,
  type ReviewTarget,
  type ReviewEvent,
} from "../../../../packages/shared/src/review";
import type { ReviewSession, ReviewDetail } from "./useReview";
export function ReviewPanel({
  session,
  revision,
  currentPage,
  pageCount,
  onNavigate,
}: {
  session: ReviewSession;
  revision: Revision;
  currentPage: number;
  pageCount: number;
  onNavigate: (target: ReviewTarget) => void;
}) {
  const { t } = useTranslation(),
    [hideResolved, setHideResolved] = useState(true),
    [status, setStatus] = useState(""),
    [pageFilter, setPageFilter] = useState(""),
    [allRevisions, setAllRevisions] = useState(false),
    [listPage, setListPage] = useState(0),
    [replyPage, setReplyPage] = useState(0),
    [historyPage, setHistoryPage] = useState(0),
    [newComment, setNewComment] = useState(""),
    [commentPage, setCommentPage] = useState(currentPage),
    [reply, setReply] = useState("");
  const actor = qc.getQueryData<Account>(["me"])?.profile.id;
  const createId = useRef(crypto.randomUUID()),
    replyId = useRef(crypto.randomUUID());
  useEffect(() => {
    setListPage(0);
  }, [hideResolved, status, pageFilter, allRevisions, revision.id]);
  useEffect(() => {
    setCommentPage(currentPage);
  }, [currentPage]);
  useEffect(() => {
    setReplyPage(0);
    setHistoryPage(0);
    setReply("");
    replyId.current = crypto.randomUUID();
  }, [session.selected]);
  const params = new URLSearchParams({
    revision_id: allRevisions ? "" : revision.id,
    hide_resolved: hideResolved ? "1" : "0",
    status,
    page_number: pageFilter,
    page: String(listPage),
  });
  const list = useQuery({
    queryKey: ["review", "points", revision.document_id, params.toString()],
    queryFn: () =>
      api<Page<ReviewItem>>(
        `documents/${revision.document_id}/review-items?${params}`,
      ),
    enabled: session.panel,
    staleTime: 30000,
  });
  const detail = useQuery({
    queryKey: ["review", "point", session.selected, replyPage, historyPage],
    queryFn: () =>
      api<ReviewDetail>(
        `review-items/${session.selected}?page=${replyPage}&history_page=${historyPage}`,
      ),
    enabled: session.panel && !!session.selected,
    staleTime: 30000,
  });
  async function startDiscussion() {
    if (!newComment.trim()) return;
    try {
      await session.create({
        id: createId.current,
        page: commentPage,
        type: "discussion",
        color: "blue",
        geometry: { points: [] },
        summary: newComment,
      });
      setNewComment("");
      createId.current = crypto.randomUUID();
    } catch {
      /* State and retry ID are preserved. */
    }
  }
  async function replyToPoint() {
    if (!session.selected || !reply.trim()) return;
    try {
      await session.mutation(() =>
        api(`review-items/${session.selected}/messages`, {
          id: replyId.current,
          body: reply,
        }),
      );
      setReply("");
      replyId.current = crypto.randomUUID();
    } catch {
      /* Input remains retryable. */
    }
  }
  return (
    <section className="review-panel" aria-label={t("technicalPoints")}>
      <h3>{t("technicalPoints")}</h3>
      <div className="review-filters">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={hideResolved}
            onChange={(e) => setHideResolved(e.target.checked)}
          />
          {t("hideResolved")}
        </label>
        <label>
          {t("discussionStatus")}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t("allStatuses")}</option>
            {reviewStatuses.map((s) => (
              <option key={s} value={s}>
                {t(`review_${s}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("page")}
          <input
            type="number"
            min={1}
            aria-label={t("filterPage")}
            value={pageFilter}
            onChange={(e) => setPageFilter(e.target.value)}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={allRevisions}
            onChange={(e) => setAllRevisions(e.target.checked)}
          />
          {t("allRevisions")}
        </label>
      </div>
      {list.isPending && <p>{t("loading")}</p>}
      {list.isError && <p role="alert">{t("reviewLoadError")}</p>}
      <ol className="review-list">
        {list.data?.items.map((i) => (
          <li key={i.id} data-testid={`point-${i.id}`}>
            <button
              className={session.selected === i.id ? "selected" : ""}
              onClick={() => {
                session.setSelected(i.id);
                onNavigate({
                  id: i.id,
                  page: i.page,
                  revision_id: i.revision_id,
                });
              }}
            >
              <strong>
                #{String(i.number).padStart(3, "0")} ·{" "}
                {i.summary || i.content || t(`tool_${i.type}`)}
              </strong>
              <span>
                {t("page")} {i.page} · {t("revision")} {i.revision_label} ·{" "}
                {t(`review_${i.status}`)}
              </span>
              <small>
                {i.author} · {new Date(i.updated_at).toLocaleString()}
                {i.responsible ? ` · ${i.responsible}` : ""}
                {i.annotation_deleted_at ? ` · ${t("annotationRemoved")}` : ""}
              </small>
            </button>
          </li>
        ))}
      </ol>
      <div className="toolbar">
        <button
          disabled={listPage === 0}
          onClick={() => setListPage(listPage - 1)}
        >
          {t("previous")}
        </button>
        <span>{listPage + 1}</span>
        <button
          disabled={!list.data?.hasMore}
          onClick={() => setListPage(listPage + 1)}
        >
          {t("next")}
        </button>
      </div>
      <details>
        <summary>{t("newDiscussion")}</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void startDiscussion();
          }}
        >
          <label>
            {t("comment")}
            <textarea
              value={newComment}
              maxLength={4000}
              required
              onChange={(e) => {
                setNewComment(e.target.value);
                createId.current = crypto.randomUUID();
              }}
            />
          </label>
          <label>
            {t("page")}
            <input
              type="number"
              min={1}
              max={pageCount}
              aria-label={t("commentPage")}
              value={commentPage}
              onChange={(e) => setCommentPage(Number(e.target.value) || 1)}
            />
          </label>
          <button disabled={session.saving}>{t("addComment")}</button>
        </form>
      </details>
      {detail.isPending && session.selected && <p>{t("loading")}</p>}
      {detail.isError && <p role="alert">{t("reviewLoadError")}</p>}
      {detail.data && (
        <article className="review-thread" aria-label={t("discussionThread")}>
          <h3>#{String(detail.data.item.number).padStart(3, "0")}</h3>
          <p>
            {detail.data.item.author} · {t("page")} {detail.data.item.page}
          </p>
          <button
            onClick={() =>
              onNavigate({
                id: detail.data!.item.id,
                page: detail.data!.item.page,
                revision_id: detail.data!.item.revision_id,
              })
            }
          >
            {t("goToAnnotation")}
          </button>
          <PointEditor
            key={`${detail.data.item.id}-${detail.data.item.version}`}
            item={detail.data.item}
            actor={actor}
            session={session}
          />
          <h4>{t("replies")}</h4>
          {detail.data.messages.map((m) => (
            <Message
              key={`${m.id}-${m.version}`}
              message={m}
              actor={actor}
              session={session}
            />
          ))}
          <div className="toolbar">
            <button
              disabled={replyPage === 0}
              onClick={() => setReplyPage(replyPage - 1)}
            >
              {t("previous")}
            </button>
            <span>{replyPage + 1}</span>
            <button
              disabled={!detail.data.hasMoreMessages}
              onClick={() => setReplyPage(replyPage + 1)}
            >
              {t("next")}
            </button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void replyToPoint();
            }}
          >
            <label>
              {t("reply")}
              <textarea
                required
                value={reply}
                maxLength={4000}
                onChange={(e) => {
                  setReply(e.target.value);
                  replyId.current = crypto.randomUUID();
                }}
              />
            </label>
            <button disabled={session.saving || !reply.trim()}>
              {t("sendReply")}
            </button>
          </form>
          <details>
            <summary>{t("reviewHistory")}</summary>
            {detail.data.history.map((h) => (
              <div key={h.id} className="review-event">
                <strong>{t(h.action.replaceAll(".", "_"))}</strong>
                <small>
                  {h.actor} · {new Date(h.created_at).toLocaleString()}
                </small>
                <HistoryText event={h} />
              </div>
            ))}
            <div className="toolbar">
              <button
                disabled={historyPage === 0}
                onClick={() => setHistoryPage(historyPage - 1)}
              >
                {t("previous")}
              </button>
              <span>{historyPage + 1}</span>
              <button
                disabled={!detail.data.hasMoreHistory}
                onClick={() => setHistoryPage(historyPage + 1)}
              >
                {t("next")}
              </button>
            </div>
          </details>
        </article>
      )}
    </section>
  );
}
function PointEditor({
  item,
  actor,
  session,
}: {
  item: ReviewItem;
  actor?: string;
  session: ReviewSession;
}) {
  const { t } = useTranslation(),
    [summary, setSummary] = useState(item.summary),
    [content, setContent] = useState(item.content),
    [color, setColor] = useState(item.color),
    [status, setStatus] = useState(item.status),
    [responsible, setResponsible] = useState(item.responsible),
    own = actor === item.created_by;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void session
          .update(item.id, {
            version: item.version,
            status,
            responsible,
            ...(own
              ? {
                  summary,
                  ...(!item.annotation_deleted_at ? { content, color } : {}),
                }
              : {}),
          })
          .catch(() => {});
      }}
    >
      <label>
        {t("comment")}
        <textarea
          aria-label={t("pointComment")}
          maxLength={4000}
          value={summary}
          readOnly={!own}
          onChange={(e) => setSummary(e.target.value)}
        />
      </label>
      {item.type === "text" && !item.annotation_deleted_at && (
        <label>
          {t("textNote")}
          <textarea
            maxLength={2000}
            value={content}
            readOnly={!own}
            onChange={(e) => setContent(e.target.value)}
          />
        </label>
      )}
      {!item.annotation_deleted_at && item.type !== "discussion" && (
        <label>
          {t("color")}
          <select
            value={color}
            disabled={!own}
            onChange={(e) => setColor(e.target.value as typeof color)}
          >
            {reviewColors.map((c) => (
              <option key={c} value={c}>
                {t(`color_${c}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {t("discussionStatus")}
        <select
          aria-label={t("pointStatus")}
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
        >
          {reviewStatuses.map((s) => (
            <option key={s} value={s}>
              {t(`review_${s}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("responsible")}
        <input
          maxLength={120}
          value={responsible}
          onChange={(e) => setResponsible(e.target.value)}
        />
      </label>
      <div className="toolbar">
        <button disabled={session.saving}>{t("savePoint")}</button>
        {own && !item.annotation_deleted_at && item.type !== "discussion" && (
          <button
            type="button"
            disabled={session.saving}
            onClick={() => {
              if (confirm(t("removeAnnotationConfirm")))
                void session
                  .update(item.id, {
                    version: item.version,
                    annotation_deleted: true,
                  })
                  .catch(() => {});
            }}
          >
            {t("removeAnnotation")}
          </button>
        )}
      </div>
    </form>
  );
}
function Message({
  message,
  actor,
  session,
}: {
  message: ReviewMessage;
  actor?: string;
  session: ReviewSession;
}) {
  const { t } = useTranslation(),
    [editing, setEditing] = useState(false),
    [body, setBody] = useState(message.body);
  return (
    <article className="review-message">
      <small>
        {message.author} · {new Date(message.created_at).toLocaleString()}
        {message.version > 1 ? ` · ${t("edited")}` : ""}
      </small>
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void session
              .mutation(() =>
                api(
                  `review-messages/${message.id}`,
                  { body, version: message.version },
                  "PATCH",
                ),
              )
              .then(() => setEditing(false))
              .catch(() => {});
          }}
        >
          <label>
            {t("reply")}
            <textarea
              value={body}
              required
              maxLength={4000}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <button disabled={session.saving}>{t("save")}</button>
          <button type="button" onClick={() => setEditing(false)}>
            {t("cancel")}
          </button>
        </form>
      ) : (
        <>
          <p>{message.body}</p>
          {actor === message.author_id && (
            <button onClick={() => setEditing(true)}>{t("editReply")}</button>
          )}
        </>
      )}
    </article>
  );
}
function HistoryText({ event }: { event: ReviewEvent }) {
  const { t } = useTranslation();
  const p = JSON.parse(event.payload) as {
    before?: string | ReviewItem;
    after?: string | Partial<ReviewItem>;
    body?: string;
    summary?: string;
  };
  if (typeof p.before === "string")
    return (
      <p>
        {p.before} → {String(p.after ?? "")}
      </p>
    );
  const before = typeof p.before === "object" ? p.before : undefined,
    after = typeof p.after === "object" ? p.after : undefined;
  if (after)
    return (
      <>
        {after.summary !== undefined && after.summary !== before?.summary && (
          <p>
            {before?.summary ?? ""} → {after.summary}
          </p>
        )}
        {after.content !== undefined && after.content !== before?.content && (
          <p>
            {before?.content ?? ""} → {after.content}
          </p>
        )}
        {after.status && after.status !== before?.status && (
          <p>
            {t(`review_${before?.status ?? "open"}`)} →{" "}
            {t(`review_${after.status}`)}
          </p>
        )}
        {after.color && after.color !== before?.color && (
          <p>
            {t("color")}: {t(`color_${before?.color ?? "red"}`)} →{" "}
            {t(`color_${after.color}`)}
          </p>
        )}
        {after.responsible !== undefined &&
          after.responsible !== before?.responsible && (
            <p>
              {t("responsible")}: {before?.responsible ?? ""} →{" "}
              {after.responsible}
            </p>
          )}
        {after.geometry &&
          JSON.stringify(after.geometry) !==
            JSON.stringify(before?.geometry) && <p>{t("geometryUpdated")}</p>}
      </>
    );
  return p.body || p.summary ? <p>{p.body ?? p.summary}</p> : null;
}
