import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../client";
import {
  requestPriorities,
  type MessageReference,
} from "../../../../packages/shared/src/messages";
import {
  approvalPurposes,
  type ApprovalDetail,
} from "../../../../packages/shared/src/approvals";
import { ReferencePicker } from "../messages/ReferencePicker";
export interface ApprovalSeed {
  project: string;
  document_id?: string;
  revision_id?: string;
  revision_label?: string;
  message_id?: string | null;
  technical_request_id?: string | null;
  title?: string;
  purpose?: ApprovalDetail["approval"]["purpose"];
  priority?: ApprovalDetail["approval"]["priority"];
  description?: string;
  responsible?: string;
  due_date?: string | null;
}
export function ApprovalForm({
  seed,
  detail,
  previous,
  onClose,
  onSaved,
}: {
  seed: ApprovalSeed;
  detail?: ApprovalDetail;
  previous?: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const client = useQueryClient();
  const { t } = useTranslation(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [picker, setPicker] = useState(false);
  const [reference, setReference] = useState<MessageReference | null>(
    seed.revision_id
      ? {
          document_id: seed.document_id ?? null,
          revision_id: seed.revision_id,
          point_id: null,
          page: null,
          label: seed.revision_label,
        }
      : null,
  );
  const [linked, setLinked] = useState<{ id: string; label: string }[]>(
    detail?.points.map((p) => ({
      id: p.id,
      label: `#${p.number} · ${p.title}`,
    })) ?? [],
  );
  const [draftId] = useState(() => crypto.randomUUID());
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!reference?.revision_id) return;
    setBusy(true);
    setError("");
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const payload = {
        ...f,
        id: draftId,
        revision_id: reference.revision_id,
        point_ids: linked.map((p) => p.id),
        due_date: f.due_date || null,
        message_id: detail?.approval.message_id ?? seed.message_id ?? null,
        technical_request_id:
          detail?.approval.technical_request_id ??
          seed.technical_request_id ??
          null,
        ...(detail ? { version: detail.approval.version } : {}),
      };
      const result = await api<{ id?: string }>(
        detail
          ? `approvals/${detail.approval.id}`
          : previous
            ? `approvals/${previous}/resubmit`
            : "approvals",
        payload,
        detail ? "PATCH" : "POST",
      );
      await Promise.all([
        client.invalidateQueries({ queryKey: ["approvals"] }),
        client.invalidateQueries({ queryKey: ["approval-summary"] }),
        client.invalidateQueries({ queryKey: ["revision-approval"] }),
        client.invalidateQueries({ queryKey: ["message-approvals"] }),
        ...(detail
          ? [
              client.invalidateQueries({
                queryKey: ["approval", detail.approval.id],
              }),
            ]
          : []),
      ]);
      onSaved(detail?.approval.id ?? result.id!);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("error"));
    } finally {
      setBusy(false);
    }
  }
  function add(r: MessageReference) {
    if (!r.revision_id) {
      setError(t("approvalChooseRevision"));
      return;
    }
    if (detail && r.revision_id !== detail.approval.revision_id) {
      setError(t("approvalRevisionImmutable"));
      return;
    }
    if (reference?.revision_id !== r.revision_id) setLinked([]);
    setReference(r);
    if (r.point_id)
      setLinked((old) => [
        ...old.filter((p) => p.id !== r.point_id),
        { id: r.point_id!, label: r.label ?? r.point_id! },
      ]);
    setError("");
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal panel approval-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t(detail ? "approvalEditDraft" : "requestApproval")}
      >
        <h2>{t(detail ? "approvalEditDraft" : "requestApproval")}</h2>
        <p className="notice">{t("approvalInternalNotice")}</p>
        <p>
          <strong>{t("revision")} :</strong>{" "}
          {reference?.label ?? t("approvalChooseRevision")}
        </p>
        <button type="button" disabled={busy} onClick={() => setPicker(true)}>
          {t(reference ? "approvalAddPoint" : "approvalChooseRevision")}
        </button>
        <div className="message-references">
          {linked.map((p) => (
            <span className="reference-chip" key={p.id}>
              {p.label}
              <button
                type="button"
                disabled={busy}
                aria-label={t("removeReference")}
                onClick={() =>
                  setLinked((old) => old.filter((x) => x.id !== p.id))
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <label>
            {t("approvalTitle")}
            <input
              name="title"
              required
              maxLength={200}
              defaultValue={detail?.approval.title ?? seed.title ?? ""}
            />
          </label>
          <label>
            {t("approvalInstructions")}
            <textarea
              name="description"
              maxLength={8000}
              defaultValue={detail?.approval.description ?? seed.description}
            />
          </label>
          <div className="form-grid">
            <label>
              {t("approvalPurpose")}
              <select
                name="purpose"
                defaultValue={
                  detail?.approval.purpose ?? seed.purpose ?? "internal_review"
                }
              >
                {approvalPurposes.map((p) => (
                  <option key={p} value={p}>
                    {t(`approvalPurpose_${p}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("responsible")}
              <input
                name="responsible"
                maxLength={120}
                defaultValue={detail?.approval.responsible ?? seed.responsible}
              />
            </label>
            <label>
              {t("dueDate")}
              <input
                name="due_date"
                type="date"
                defaultValue={detail?.approval.due_date ?? seed.due_date ?? ""}
              />
            </label>
            <label>
              {t("priority")}
              <select
                name="priority"
                defaultValue={
                  detail?.approval.priority ?? seed.priority ?? "normal"
                }
              >
                {requestPriorities.map((p) => (
                  <option key={p} value={p}>
                    {t(`priority_${p}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error && <p role="alert">{error}</p>}
          <div className="actions">
            <button
              className="primary"
              disabled={busy || !reference?.revision_id || linked.length > 20}
            >
              {t("approvalSaveDraft")}
            </button>
            <button type="button" disabled={busy} onClick={onClose}>
              {t("cancel")}
            </button>
          </div>
        </form>
        {picker && (
          <ReferencePicker
            key={reference?.revision_id ?? "new"}
            project={seed.project}
            initialDocument={reference?.document_id ?? ""}
            initialRevision={reference?.revision_id ?? ""}
            onClose={() => setPicker(false)}
            onAdd={add}
          />
        )}
      </section>
    </div>
  );
}
