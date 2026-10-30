import { MessageBody } from "../components/MessageBody";
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
    [tab, setTab] = useState("points"),
    [status, setStatus] = useState(""),
    [publication, setPublication] = useState(""),
    [all, setAll] = useState(false),
    [listPage, setListPage] = useState(0),
    [title, setTitle] = useState(""),
    [description, setDescription] = useState(""),
    [reply, setReply] = useState(""),
    [target, setTarget] = useState(""),
    [replyPage, setReplyPage] = useState(0),
    [historyPage, setHistoryPage] = useState(0);
  const createId = useRef(crypto.randomUUID()),
    replyId = useRef(crypto.randomUUID());
  const actor = qc.getQueryData<Account>(["me"])?.profile.id;
  useEffect(() => {
    setListPage(0);
  }, [status, publication, all, revision.id]);
  useEffect(() => {
    setReply("");
    setReplyPage(0);
    setHistoryPage(0);
    replyId.current = crypto.randomUUID();
  }, [session.selected]);
  useEffect(() => {
    if (session.selected) setTab("points");
  }, [session.selected]);
  useEffect(() => {
    if (!session.selected && session.selectedAnnotations.length)
      setTab("annotations");
  }, [session.selected, session.selectedAnnotations]);
  const params = new URLSearchParams({
    revision_id: all ? "" : revision.id,
    status,
    publication,
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
  const selected = session.items.filter((i) =>
    session.selectedAnnotations.includes(i.id),
  );
  async function create() {
    try {
      await session.create({
        id: createId.current,
        page: currentPage,
        type: "discussion",
        color: "blue",
        geometry: { points: [] },
        title,
        summary: description,
        annotation_ids: selected.map((i) => i.id),
      });
      createId.current = crypto.randomUUID();
      setTitle("");
      setDescription("");
      setTab("points");
      await qc.invalidateQueries({
        queryKey: ["review", "annotations", revision.id],
      });
    } catch {
      /* Preserve input and ID for retry. */
    }
  }
  const navigate = (i: ReviewItem) => {
    session.setSelected(i.id);
    setTab("points");
    onNavigate({
      id: i.id,
      page: Number(i.pages?.split(",")[0]) || i.page,
      revision_id: i.revision_id,
    });
  };
  return (
    <section className="review-panel" aria-label={t("technicalPoints")}>
      <div className="toolbar">
        <button
          aria-pressed={tab === "points"}
          onClick={() => setTab("points")}
        >
          Points techniques
        </button>
        <button
          aria-pressed={tab === "annotations"}
          onClick={() => setTab("annotations")}
        >
          Annotations
        </button>
      </div>
      {tab === "annotations" && (
        <>
          <p>Les dessins sont indépendants des points techniques.</p>
          <div className="toolbar">
            <button
              onClick={() =>
                session.setSelectedAnnotations(session.items.map((i) => i.id))
              }
            >
              Sélectionner les dessins chargés de cette page
            </button>
            <button onClick={() => session.setSelectedAnnotations([])}>
              Désélectionner
            </button>
          </div>
          <p>
            {selected.length} annotation(s) sélectionnée(s) · page {currentPage}
            /{pageCount}
          </p>
          {session.items.map((i) => (
            <div key={i.id} className="review-message">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={session.selectedAnnotations.includes(i.id)}
                  onChange={() => session.selectAnnotation(i, true)}
                />
                {t(`tool_${i.type}`)}
                {i.point_id ? " · Associée" : ""}
              </label>
              {session.selectedAnnotations.length === 1 &&
                selected[0]?.id === i.id && (
                  <AnnotationEditor
                    key={`${i.id}-${i.version}`}
                    item={i}
                    session={session}
                  />
                )}
            </div>
          ))}
          <label>
            Point technique existant
            <select
              aria-label="Point technique existant"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">Choisir un point</option>
              {list.data?.items
                .filter((p) => p.revision_id === revision.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    #{String(p.number).padStart(3, "0")} — {p.title}
                  </option>
                ))}
            </select>
          </label>
          <button
            disabled={
              !target ||
              !selected.length ||
              selected.length > 100 ||
              session.saving
            }
            onClick={() => void session.link(target, selected).catch(() => {})}
          >
            Associer la sélection
          </button>
          <button
            disabled={
              !selected.length || selected.length > 100 || session.saving
            }
            onClick={() => void session.link(null, selected).catch(() => {})}
          >
            Détacher la sélection
          </button>
        </>
      )}
      {tab === "points" && (
        <>
          <div className="review-filters">
            <label>
              Publication
              <select
                value={publication}
                onChange={(e) => setPublication(e.target.value)}
              >
                <option value="">Tous</option>
                <option value="draft">Brouillons</option>
                <option value="published">Publiés</option>
              </select>
            </label>
            <label>
              Statut
              <select
                aria-label={t("discussionStatus")}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">Tous les statuts</option>
                {reviewStatuses.map((s) => (
                  <option key={s} value={s}>
                    {t(`review_${s}`)}
                  </option>
                ))}
                <option value="cancelled">Annulés</option>
              </select>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={all}
                onChange={(e) => setAll(e.target.checked)}
              />
              {t("allRevisions")}
            </label>
          </div>
          {list.isError && <p role="alert">{t("reviewLoadError")}</p>}
          <ol className="review-list">
            {list.data?.items.map((i) => (
              <li key={i.id} data-testid={`point-${i.id}`}>
                <button
                  className={session.selected === i.id ? "selected" : ""}
                  onClick={() => navigate(i)}
                >
                  <strong>
                    {i.publication === "published"
                      ? `#${String(i.number).padStart(3, "0")} · `
                      : ""}
                    {i.title || i.summary || "Ancien échange à examiner"}
                  </strong>
                  <span>
                    {i.publication === "published" ? "Publié" : "Brouillon"} ·{" "}
                    {i.cancelled_at ? "Annulé" : t(`review_${i.status}`)} ·{" "}
                    {t("revision")} {i.revision_label}
                  </span>
                  <small>
                    Pages {i.pages || i.page} · {i.annotation_count ?? 0}{" "}
                    annotations · {i.comment_count ?? 0} commentaires
                  </small>
                  <small>
                    {i.author} · {new Date(i.created_at).toLocaleString()}
                    {i.legacy_review ? " · Données historiques à examiner" : ""}
                  </small>
                </button>
              </li>
            ))}
          </ol>
          <div className="toolbar">
            <button
              disabled={!listPage}
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
        </>
      )}
      {selected.length > 100 && (
        <p role="alert">
          Sélectionnez au maximum 100 annotations par opération. Vous pouvez
          associer plusieurs sélections au même point.
        </p>
      )}
      <details>
        <summary>Créer un point technique</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label>
            Titre
            <input
              aria-label="Titre du point"
              required
              maxLength={200}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                createId.current = crypto.randomUUID();
              }}
            />
          </label>
          <label>
            Description
            <textarea
              maxLength={4000}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                createId.current = crypto.randomUUID();
              }}
            />
          </label>
          <p>
            {selected.length} annotation(s) sélectionnée(s). Un dessin déjà
            associé doit être détaché avant la création.
          </p>
          <button
            disabled={session.saving || !title.trim() || selected.length > 100}
          >
            Créer le brouillon
          </button>
        </form>
      </details>
      <small>
        « Brouillon » indique un état de préparation. Les permissions
        fournisseurs ne sont pas encore disponibles.
      </small>
      {detail.isError && session.selected && (
        <p role="alert">{t("reviewLoadError")}</p>
      )}
      {detail.data && !detail.data.item.point_deleted_at && (
        <article className="review-thread" aria-label={t("discussionThread")}>
          <h3>
            {detail.data.item.publication === "published"
              ? `#${String(detail.data.item.number).padStart(3, "0")} · `
              : ""}
            {detail.data.item.title || detail.data.item.summary}
          </h3>
          <PointEditor
            key={`${detail.data.item.id}-${detail.data.item.version}`}
            item={detail.data.item}
            session={session}
          />
          <h4>Annotations associées</h4>
          {detail.data.annotations.map((a) => (
            <div key={a.id}>
              <button
                onClick={() => {
                  session.setSelectedAnnotations([a.id]);
                  onNavigate({
                    id: detail.data!.item.id,
                    page: a.page,
                    revision_id: a.revision_id,
                  });
                }}
              >
                {t(`tool_${a.type}`)} · page {a.page}
              </button>
              <button
                disabled={session.saving}
                onClick={() => void session.link(null, [a]).catch(() => {})}
              >
                Détacher
              </button>
            </div>
          ))}
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
              disabled={!replyPage}
              onClick={() => setReplyPage(replyPage - 1)}
            >
              {t("previous")}
            </button>
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
              void session
                .mutation(() =>
                  api(`review-items/${detail.data!.item.id}/messages`, {
                    id: replyId.current,
                    body: reply,
                  }),
                )
                .then(() => {
                  setReply("");
                  replyId.current = crypto.randomUUID();
                })
                .catch(() => {});
            }}
          >
            <label>
              {t("reply")}
              <textarea
                required
                maxLength={4000}
                value={reply}
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
              <div key={h.id}>
                <strong>{t(h.action.replaceAll(".", "_"))}</strong>
                <small>
                  {h.actor} · {new Date(h.created_at).toLocaleString()}
                </small>
                <HistoryText event={h} />
              </div>
            ))}
            <div className="toolbar">
              <button
                disabled={!historyPage}
                onClick={() => setHistoryPage(historyPage - 1)}
              >
                {t("previous")}
              </button>
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
  session,
}: {
  item: ReviewItem;
  session: ReviewSession;
}) {
  const { t } = useTranslation(),
    [title, setTitle] = useState(
      item.title || item.summary || "Ancien échange",
    ),
    [summary, setSummary] = useState(item.summary),
    [status, setStatus] = useState(item.status),
    [responsible, setResponsible] = useState(item.responsible);
  const patch = (data: Record<string, unknown>) =>
    void session
      .updatePoint(item.id, { version: item.version, ...data })
      .catch(() => {});
  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          patch({ title, summary, status, responsible });
        }}
      >
        <label>
          Titre
          <input
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Description
          <textarea
            aria-label={t("pointComment")}
            maxLength={4000}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </label>
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
        <button disabled={session.saving}>{t("savePoint")}</button>
      </form>
      {item.publication === "draft" ? (
        <div className="toolbar">
          <button
            disabled={session.saving}
            onClick={() => patch({ publication: "published" })}
          >
            Publier le point
          </button>
          <button
            disabled={session.saving}
            onClick={() => {
              if (
                confirm(
                  "Supprimer ce brouillon ? Les dessins seront conservés.",
                )
              )
                patch({ point_deleted: true });
            }}
          >
            Supprimer le brouillon
          </button>
        </div>
      ) : (
        <button
          disabled={session.saving || !!item.cancelled_at}
          onClick={() => {
            if (confirm("Annuler ce point en conservant son historique ?"))
              patch({ cancelled: true });
          }}
        >
          Annuler le point
        </button>
      )}
    </>
  );
}
function AnnotationEditor({
  item,
  session,
}: {
  item: ReviewItem;
  session: ReviewSession;
}) {
  const { t } = useTranslation(),
    [content, setContent] = useState(item.content),
    [color, setColor] = useState(item.color);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void session
          .update(item.id, { version: item.version, content, color })
          .catch(() => {});
      }}
    >
      {item.type === "text" && (
        <label>
          {t("textNote")}
          <textarea
            maxLength={2000}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </label>
      )}
      <label>
        {t("color")}
        <select
          value={color}
          onChange={(e) => setColor(e.target.value as typeof color)}
        >
          {reviewColors.map((c) => (
            <option key={c} value={c}>
              {t(`color_${c}`)}
            </option>
          ))}
        </select>
      </label>
      <button disabled={session.saving}>Enregistrer le dessin</button>
      <button
        type="button"
        disabled={session.saving}
        onClick={() => {
          if (
            confirm(
              "Supprimer cette annotation ? Le point et sa discussion seront conservés.",
            )
          )
            void session
              .update(item.id, {
                version: item.version,
                annotation_deleted: true,
              })
              .catch(() => {});
        }}
      >
        Supprimer l’annotation
      </button>
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
          <MessageBody body={message.body} />
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
