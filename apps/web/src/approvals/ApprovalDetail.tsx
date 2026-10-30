import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink } from "react-router";
import { useTranslation } from "react-i18next";
import { api } from "../client";
import { referenceUrl } from "../../../../packages/shared/src/messages";
import type { ApprovalDetail as Detail } from "../../../../packages/shared/src/approvals";
import { ApprovalForm } from "./ApprovalForm";
import { ReferencePicker } from "../messages/ReferencePicker";
import { MessageBody } from "../components/MessageBody";
export function ApprovalDetail({
  id,
  project,
  onSelect,
  onClose,
}: {
  id: string;
  project: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(),
    client = useQueryClient(),
    [historyPage, setHistoryPage] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(false),
    [resubmitting, setResubmitting] = useState(false),
    [action, setAction] = useState(""),
    [comment, setComment] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [picker, setPicker] = useState(false),
    [extra, setExtra] = useState<{ id: string; label: string }[]>([]);
  const detail = useQuery({
    queryKey: ["approval", id, historyPage],
    queryFn: () => api<Detail>(`approvals/${id}?event_page=${historyPage}`),
  });
  const a = detail.data?.approval;
  function refresh() {
    void Promise.all([
      client.invalidateQueries({ queryKey: ["approval", id] }),
      client.invalidateQueries({ queryKey: ["approvals"] }),
      client.invalidateQueries({ queryKey: ["approval-summary"] }),
      client.invalidateQueries({ queryKey: ["revision-approval"] }),
      client.invalidateQueries({ queryKey: ["message-approvals"] }),
    ]);
  }
  async function perform(remove = false) {
    if (!a) return;
    setBusy(true);
    setError("");
    try {
      await api(
        remove ? `approvals/${id}` : `approvals/${id}/actions`,
        remove
          ? { version: a.version }
          : {
              version: a.version,
              action,
              comment,
              point_ids: extra.map((p) => p.id),
            },
        remove ? "DELETE" : "POST",
      );
      setAction("");
      setComment("");
      setExtra([]);
      setConfirmed(false);
      if (remove) {
        client.removeQueries({ queryKey: ["approval", id] });
        void client.invalidateQueries({ queryKey: ["approvals"] });
        void client.invalidateQueries({ queryKey: ["approval-summary"] });
        onClose();
      } else refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("error"));
    } finally {
      setBusy(false);
    }
  }
  function choose(value: string) {
    setAction(value);
    setComment("");
    setExtra([]);
    setConfirmed(false);
  }
  if (detail.isError)
    return (
      <section role="alert">
        {t("approvalStateUnavailable")}
        <button onClick={onClose}>{t("back")}</button>
      </section>
    );
  if (!a) return <p>{t("loading")}</p>;
  if (a.project_id !== project)
    return <p role="alert">{t("referenceUnavailable")}</p>;
  return (
    <section
      className="panel approval-detail"
      aria-label={t("approvalDetails")}
    >
      <div className="toolbar">
        <button onClick={onClose}>{t("back")}</button>
        <h2>
          APR-{String(a.number).padStart(5, "0")} · {a.title}
        </h2>
        <span className="badge">{t(`approval_${a.status}`)}</span>
      </div>
      <p className="notice">{t("approvalInternalNotice")}</p>
      <p>
        <strong>
          {a.document_number || a.document_name} · {t("revision")}{" "}
          {a.revision_label}
        </strong>{" "}
        · {t(`approvalPurpose_${a.purpose}`)}
      </p>
      {!a.is_latest && <p className="notice">{t("approvalObsolete")}</p>}
      <MessageBody body={a.description} />
      <dl className="approval-metadata">
        <div>
          <dt>{t("approvalRequester")}</dt>
          <dd>
            {a.requester} · {new Date(a.created_at).toLocaleString()}
          </dd>
        </div>
        <div>
          <dt>{t("responsible")}</dt>
          <dd>{a.responsible || "—"}</dd>
        </div>
        <div>
          <dt>{t("dueDate")}</dt>
          <dd>{a.due_date ?? "—"}</dd>
        </div>
        <div>
          <dt>{t("priority")}</dt>
          <dd>{t(`priority_${a.priority}`)}</dd>
        </div>
        {a.decided_at && (
          <div>
            <dt>{t("approvalDecision")}</dt>
            <dd>
              {a.decider} · {new Date(a.decided_at).toLocaleString()}
              <MessageBody body={a.decision_comment} />
            </dd>
          </div>
        )}
      </dl>
      <div className="toolbar">
        <NavLink
          to={referenceUrl(project, {
            document_id: a.document_id,
            revision_id: a.revision_id,
            point_id: null,
            page: null,
          })}
        >
          {t("approvalOpenRevision")}
        </NavLink>
        {a.message_id && (
          <NavLink
            to={`/projects/${project}/messages?conversation=${a.conversation_id}&message=${a.message_id}`}
          >
            {t("openSourceDiscussion")}
          </NavLink>
        )}
        {a.technical_request_id && (
          <NavLink to={`/projects/${project}/requests`}>
            {t("approvalLinkedRequest")}
          </NavLink>
        )}
        {a.previous_id && (
          <button onClick={() => onSelect(a.previous_id!)}>
            {t("approvalPreviousCycle")}
          </button>
        )}
        {detail.data?.successor_id && (
          <button onClick={() => onSelect(detail.data!.successor_id!)}>
            {t("approvalNextCycle")}
          </button>
        )}
      </div>
      <h3>{t("approvalLinkedPoints")}</h3>
      <div className="message-references">
        {detail.data?.points.map((p) => (
          <NavLink
            className="reference-chip"
            key={p.id}
            to={referenceUrl(project, {
              document_id: p.document_id,
              revision_id: p.revision_id,
              point_id: p.id,
              page: p.page,
            })}
          >
            #{p.number} · {p.title}
            {p.point_deleted_at ? ` · ${t("approvalPointRemoved")}` : ""}
          </NavLink>
        ))}
      </div>
      <div className="toolbar">
        {a.status === "draft" && (
          <>
            <button disabled={busy} onClick={() => setEditing(true)}>
              {t("approvalEditDraft")}
            </button>
            <button disabled={busy} onClick={() => choose("submit")}>
              {t("approvalSubmit")}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                if (confirm(t("approvalDeleteConfirm"))) void perform(true);
              }}
            >
              {t("approvalDeleteDraft")}
            </button>
          </>
        )}
        {a.status === "pending" && (
          <>
            <button disabled={busy} onClick={() => choose("approve")}>
              {t("approvalApprove")}
            </button>
            <button disabled={busy} onClick={() => choose("reject")}>
              {t("approvalReject")}
            </button>
            <button disabled={busy} onClick={() => choose("request_changes")}>
              {t("approvalRequestChanges")}
            </button>
          </>
        )}
        {a.status !== "cancelled" && (
          <button disabled={busy} onClick={() => choose("cancel")}>
            {t("approvalCancel")}
          </button>
        )}
        {["approved", "rejected", "changes_requested", "cancelled"].includes(
          a.status,
        ) &&
          !detail.data?.successor_id && (
            <button disabled={busy} onClick={() => setResubmitting(true)}>
              {t("approvalResubmit")}
            </button>
          )}
      </div>
      {error && <p role="alert">{error}</p>}
      {action && (
        <form
          className="panel approval-action"
          onSubmit={(e) => {
            e.preventDefault();
            void perform();
          }}
        >
          <h3>{t(`approvalAction_${action}`)}</h3>
          <p>
            {t("approvalDecisionConfirmation", { revision: a.revision_label })}
          </p>
          <label>
            {t("approvalJustification")}
            <textarea
              value={comment}
              maxLength={8000}
              required={["reject", "request_changes", "cancel"].includes(
                action,
              )}
              onChange={(e) => setComment(e.target.value)}
            />
          </label>
          {action === "request_changes" && (
            <>
              <button
                type="button"
                disabled={extra.length >= 20}
                onClick={() => setPicker(true)}
              >
                {t("approvalAddPoint")}
              </button>
              <NavLink
                to={referenceUrl(project, {
                  document_id: a.document_id,
                  revision_id: a.revision_id,
                  point_id: null,
                  page: null,
                })}
              >
                {t("approvalCreatePointInViewer")}
              </NavLink>
              {extra.map((p) => (
                <span className="reference-chip" key={p.id}>
                  {p.label}
                  <button
                    type="button"
                    onClick={() =>
                      setExtra((old) => old.filter((x) => x.id !== p.id))
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </>
          )}
          <label className="inline-check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              required
            />
            {t("approvalConfirmExactRevision", { revision: a.revision_label })}
          </label>
          <div className="actions">
            <button className="primary" disabled={busy || !confirmed}>
              {t("approvalRecordAction")}
            </button>
            <button type="button" disabled={busy} onClick={() => setAction("")}>
              {t("cancel")}
            </button>
          </div>
        </form>
      )}
      {picker && (
        <ReferencePicker
          project={project}
          initialDocument={a.document_id}
          initialRevision={a.revision_id}
          onClose={() => setPicker(false)}
          onAdd={(r) => {
            if (r.revision_id !== a.revision_id || !r.point_id)
              setError(t("approvalExactPointRequired"));
            else
              setExtra((old) => [
                ...old.filter((x) => x.id !== r.point_id),
                { id: r.point_id!, label: r.label ?? r.point_id! },
              ]);
          }}
        />
      )}
      <h3>{t("approvalHistory")}</h3>
      {detail.data?.events
        .slice()
        .reverse()
        .map((e) => (
          <article className="approval-event" key={e.id}>
            <strong>
              {t(`approvalEvent_${e.action.replaceAll(".", "_")}`)}
            </strong>
            <small>
              {e.actor} · {new Date(e.created_at).toLocaleString()}
            </small>
            <ApprovalEventPayload payload={e.payload} project={project} />
          </article>
        ))}
      <div className="toolbar">
        <button
          disabled={!historyPage}
          onClick={() => setHistoryPage(historyPage - 1)}
        >
          {t("previous")}
        </button>
        <button
          disabled={!detail.data?.hasMoreEvents}
          onClick={() => setHistoryPage(historyPage + 1)}
        >
          {t("next")}
        </button>
      </div>
      {editing && detail.data && (
        <ApprovalForm
          seed={{
            project,
            document_id: a.document_id,
            revision_id: a.revision_id,
            revision_label: a.revision_label,
          }}
          detail={detail.data}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            refresh();
          }}
        />
      )}
      {resubmitting && (
        <ApprovalForm
          seed={{
            project,
            document_id: a.document_id,
            revision_id: a.revision_id,
            revision_label: a.revision_label,
            title: a.title,
            description: a.description,
            purpose: a.purpose,
            priority: a.priority,
            responsible: a.responsible,
            due_date: a.due_date,
            message_id: a.message_id,
            technical_request_id: a.technical_request_id,
          }}
          previous={a.id}
          onClose={() => setResubmitting(false)}
          onSaved={(key) => {
            setResubmitting(false);
            refresh();
            onSelect(key);
          }}
        />
      )}
    </section>
  );
}
function ApprovalEventPayload({
  payload,
  project,
}: {
  payload: string;
  project: string;
}) {
  const { t } = useTranslation();
  const p = JSON.parse(payload);
  function snapshots(
    rows?: {
      id: string;
      number: number;
      title: string;
      page: number;
      revision_id: string;
      document_id: string;
    }[],
  ) {
    return rows?.map((point) => (
      <NavLink
        key={point.id}
        className="reference-chip"
        to={referenceUrl(project, {
          document_id: point.document_id,
          revision_id: point.revision_id,
          point_id: point.id,
          page: point.page,
        })}
      >
        #{point.number} · {point.title} · p. {point.page}
      </NavLink>
    ));
  }
  return (
    <>
      {p.comment && <MessageBody body={p.comment} />}{" "}
      {p.from && (
        <p>
          {t(`approval_${p.from}`)} → {t(`approval_${p.to}`)}
        </p>
      )}
      {p.before && (
        <details>
          <summary>{t("approvalDraftChanges")}</summary>
          <p>
            {t("beforeChange")}: {p.before.title} · {p.before.description}
          </p>
          <p>
            {t("afterChange")}: {p.after.title} · {p.after.description}
          </p>
          <div>
            {t("beforeChange")}: {snapshots(p.before.point_snapshot)}
          </div>
          <div>
            {t("afterChange")}: {snapshots(p.after.point_snapshot)}
          </div>
          <p>
            {t("approvalPointReferencesChanged")}:{" "}
            {(p.before.point_ids ?? []).length} →{" "}
            {(p.after.point_ids ?? []).length}
          </p>
        </details>
      )}
      {p.title && !p.before && <p>{p.title}</p>}
      {snapshots(p.point_snapshot)}
      {p.point_ids?.length > 0 && (
        <p>
          {t("approvalLinkedPoints")} : {p.point_ids.length}
        </p>
      )}
    </>
  );
}
