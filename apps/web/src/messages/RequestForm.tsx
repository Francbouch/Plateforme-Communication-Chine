import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../client";
import {
  requestStatuses,
  requestPriorities,
  type TechnicalRequest,
  type Message,
  type MessageReference,
} from "../../../../packages/shared/src/messages";
import { ReferencePicker } from "./ReferencePicker";
export function RequestForm({
  project,
  message,
  request,
  onDone,
  onClose,
}: {
  project: string;
  message?: Message;
  request?: TechnicalRequest;
  onDone: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [picker, setPicker] = useState(false);
  const [reference, setReference] = useState<MessageReference | null>(
    message?.references.find((r) => r.point_id) ?? null,
  );
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError("");
    try {
      await api(
        request ? `requests/${request.id}` : `messages/${message!.id}/requests`,
        {
          ...f,
          due_date: f.due_date || null,
          point_id: reference?.point_id ?? null,
          ...(request ? { version: request.version } : {}),
        },
        request ? "PATCH" : "POST",
      );
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("error"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t(request ? "editRequest" : "createRequest")}
        className="modal panel request-dialog"
      >
        <h2>{t(request ? "editRequest" : "createRequest")}</h2>
        <form onSubmit={(e) => void submit(e)}>
          <label>
            {t("requestTitle")}
            <input
              name="title"
              required
              maxLength={200}
              defaultValue={request?.title ?? message?.body.slice(0, 200)}
            />
          </label>
          <label>
            {t("description")}
            <textarea
              name="description"
              maxLength={8000}
              defaultValue={request?.description ?? message?.body}
            />
          </label>
          <div className="form-grid">
            <label>
              {t("responsible")}
              <input
                name="responsible"
                maxLength={120}
                defaultValue={request?.responsible}
              />
            </label>
            <label>
              {t("dueDate")}
              <input
                name="due_date"
                type="date"
                defaultValue={request?.due_date ?? ""}
              />
            </label>
            <label>
              {t("priority")}
              <select
                name="priority"
                defaultValue={request?.priority ?? "normal"}
              >
                {requestPriorities.map((v) => (
                  <option key={v} value={v}>
                    {t(`priority_${v}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("status")}
              <select name="status" defaultValue={request?.status ?? "todo"}>
                {requestStatuses.map((v) => (
                  <option key={v} value={v}>
                    {t(`request_${v}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!request && (
            <div>
              <p>{reference?.label ?? t("noLinkedPoint")}</p>
              <button type="button" onClick={() => setPicker(true)}>
                {t("linkExistingPoint")}
              </button>
              {reference && (
                <button type="button" onClick={() => setReference(null)}>
                  {t("remove")}
                </button>
              )}
            </div>
          )}
          {error && <p role="alert">{error}</p>}
          <div className="actions">
            <button className="primary" disabled={busy}>
              {t("save")}
            </button>
            <button type="button" disabled={busy} onClick={onClose}>
              {t("cancel")}
            </button>
          </div>
        </form>
        {picker && (
          <ReferencePicker
            project={project}
            onClose={() => setPicker(false)}
            onAdd={(r) => {
              if (r.point_id) setReference(r);
              else setError(t("chooseTechnicalPoint"));
            }}
          />
        )}
      </section>
    </div>
  );
}
