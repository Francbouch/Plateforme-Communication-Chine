import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { api } from "../client";
import type { Approval } from "../../../../packages/shared/src/approvals";
import type { Message } from "../../../../packages/shared/src/messages";
import { ApprovalForm, type ApprovalSeed } from "./ApprovalForm";
export function MessageApprovals({
  message,
  project,
}: {
  message: Message;
  project: string;
}) {
  const { t } = useTranslation(),
    navigate = useNavigate(),
    [open, setOpen] = useState(false),
    [page, setPage] = useState(0),
    [seed, setSeed] = useState<ApprovalSeed | null>(null);
  const approvals = useQuery({
    queryKey: ["message-approvals", message.id, page],
    queryFn: () =>
      api<{ items: Approval[]; hasMore: boolean }>(
        `messages/${message.id}/approvals?page=${page}`,
      ),
    enabled: open,
  });
  return (
    <details
      className="message-approvals"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>{t("approvals")}</summary>
      {open && (
        <>
          <p>{t("approvalDiscussionNotDecision")}</p>
          {message.references
            .filter((r) => r.revision_id)
            .map((r, i) => (
              <button
                key={r.id ?? i}
                onClick={() =>
                  setSeed({
                    project,
                    document_id: r.document_id!,
                    revision_id: r.revision_id!,
                    revision_label: r.label,
                    message_id: message.id,
                    title: message.body.slice(0, 200),
                  })
                }
              >
                {t("requestApproval")} · {r.label}
              </button>
            ))}
          {approvals.isError && (
            <p role="alert">{t("approvalStateUnavailable")}</p>
          )}
          {approvals.data?.items.map((a) => (
            <p key={a.id}>
              <NavLink to={`/projects/${project}/approvals?approval=${a.id}`}>
                APR-{a.number} · {a.revision_label} ·{" "}
                {t(`approval_${a.status}`)}
              </NavLink>{" "}
              · {t("approvalInternalShort")}
            </p>
          ))}
          <div className="toolbar">
            <button disabled={!page} onClick={() => setPage(page - 1)}>
              {t("previous")}
            </button>
            <button
              disabled={!approvals.data?.hasMore}
              onClick={() => setPage(page + 1)}
            >
              {t("next")}
            </button>
          </div>
        </>
      )}
      {seed && (
        <ApprovalForm
          seed={seed}
          onClose={() => setSeed(null)}
          onSaved={(id) =>
            navigate(`/projects/${project}/approvals?approval=${id}`)
          }
        />
      )}
    </details>
  );
}
