import { userError } from "../errors";
import { MessageApprovals } from "../approvals/MessageApprovals";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router";
import { api } from "../client";
import { TranslatedText } from "../translations/TranslatedText";
import {
  referenceUrl,
  type Message,
} from "../../../../packages/shared/src/messages";
import { RequestForm } from "./RequestForm";
export function MessageCard({
  message: m,
  project,
  actor,
  archived,
  busy,
  onReply,
  onChange,
  highlight = false,
}: {
  message: Message;
  project: string;
  actor: string;
  archived: boolean;
  busy: boolean;
  onReply: (m: Message) => void;
  onChange: () => void;
  highlight?: boolean;
}) {
  const { t } = useTranslation(),
    [editing, setEditing] = useState(false),
    [body, setBody] = useState(m.body),
    [shared, setShared] = useState(!!m.shared),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [request, setRequest] = useState(false),
    [preview, setPreview] = useState("");
  async function update(remove = false) {
    setSaving(true);
    setError("");
    try {
      await api(
        `messages/${m.id}`,
        remove ? { version: m.version } : { body, version: m.version, shared },
        remove ? "DELETE" : "PATCH",
      );
      setEditing(false);
      onChange();
    } catch (e) {
      setError(userError(e, t));
    } finally {
      setSaving(false);
    }
  }
  return (
    <article
      className={`message-card ${highlight ? "message-highlight" : ""}`}
      data-testid={`message-${m.id}`}
    >
      <div className="message-author">
        <strong>{m.author}</strong>
        <time dateTime={m.created_at}>
          {new Date(m.created_at).toLocaleString()}
        </time>
        <span className="badge">
          {t(m.shared ? "sharedMessage" : "privateMessage")}
        </span>
        {m.version > 1 && (
          <small>
            {t("edited")} · {new Date(m.updated_at).toLocaleString()}
          </small>
        )}
      </div>
      {m.deleted_at ? (
        <p>{t("messageDeleted")}</p>
      ) : (
        <>
          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void update();
              }}
            >
              <label>
                {t("editMessage")}
                <textarea
                  required
                  maxLength={8000}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </label>
              <label className="inline-check">
                <input
                  type="checkbox"
                  disabled={!!m.shared}
                  checked={shared}
                  onChange={(e) => setShared(e.target.checked)}
                />
                {t("shareMessage")}
              </label>
              <button disabled={saving}>{t("save")}</button>
              <button type="button" onClick={() => setEditing(false)}>
                {t("cancel")}
              </button>
            </form>
          ) : (
            <TranslatedText
              source={{ kind: "message", id: m.id, field: "body" }}
              text={m.body}
            />
          )}
          <div className="message-references">
            {m.references.map((r, i) => (
              <NavLink
                className="reference-chip"
                key={r.id ?? i}
                to={referenceUrl(project, r)}
              >
                {r.label ?? t("document")}
              </NavLink>
            ))}
          </div>
          {m.attachments.map((a) => (
            <div className="message-file" key={a.id}>
              <span>
                {a.filename} · {Math.ceil(a.size / 1024)} KB
              </span>
              <a
                className="button"
                href={`/api/v1/message-attachments/${a.id}/content?download=1`}
                download
              >
                {t("downloadAttachment")}
              </a>
              {["pdf", "png", "jpg", "jpeg", "webp"].includes(a.extension) && (
                <button
                  onClick={() => setPreview(preview === a.id ? "" : a.id)}
                >
                  {t("previewAttachment")}
                </button>
              )}
              {preview === a.id &&
                (a.extension === "pdf" ? (
                  <iframe
                    title={a.filename}
                    src={`/api/v1/message-attachments/${a.id}/content`}
                  />
                ) : (
                  <img
                    alt={a.filename}
                    src={`/api/v1/message-attachments/${a.id}/content`}
                  />
                ))}
            </div>
          ))}
          <MessageApprovals message={m} project={project} />
          <div className="message-actions">
            {!m.parent_id && (
              <button onClick={() => onReply(m)}>
                {t("openThread")} ({m.reply_count})
              </button>
            )}
            {!archived && (
              <>
                {actor === m.author_id && (
                  <button
                    disabled={busy || saving}
                    onClick={() => {
                      setBody(m.body);
                      setShared(!!m.shared);
                      setEditing(true);
                    }}
                  >
                    {t("editMessage")}
                  </button>
                )}
                {actor === m.author_id && !m.shared && (
                  <button
                    disabled={busy || saving || !!m.reply_count}
                    onClick={() => {
                      if (confirm(t("deleteMessageConfirm"))) void update(true);
                    }}
                  >
                    {t("deleteMessage")}
                  </button>
                )}
                <button onClick={() => setRequest(true)}>
                  {t("createRequest")}
                </button>
              </>
            )}
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {request && (
        <RequestForm
          project={project}
          message={m}
          onClose={() => setRequest(false)}
          onDone={() => {
            setRequest(false);
            onChange();
          }}
        />
      )}
    </article>
  );
}
