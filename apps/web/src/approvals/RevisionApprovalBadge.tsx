import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router";
import { api } from "../client";
import type { RevisionApproval } from "../../../../packages/shared/src/approvals";
export function RevisionApprovalBadge({
  revision,
  project,
}: {
  revision: string;
  project: string;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["revision-approval", revision],
    staleTime: 0,
    queryFn: () =>
      api<RevisionApproval>(`revisions/${revision}/approval-state`),
  });
  if (query.isError) return <p role="alert">{t("approvalStateUnavailable")}</p>;
  if (!query.data) return <p>{t("loading")}</p>;
  const data = query.data;
  return (
    <section
      className="revision-approval-state"
      aria-label={t("approvalRevisionState")}
    >
      <div className="toolbar">
        <span>
          {t("approvalPurpose_internal_review")} :{" "}
          <span className="badge">{t(`approval_${data.review_status}`)}</span>
        </span>
        <span>
          {t("approvalPurpose_manufacturing")} :{" "}
          <span className="badge">
            {t(`approval_${data.manufacturing_status}`)}
          </span>
        </span>
      </div>
      {data.current_manufacturing_ready && (
        <strong>{t("approvalInternalManufacturing")}</strong>
      )}
      {data.obsolete_for_current && (
        <p className="notice">{t("approvalObsolete")}</p>
      )}
      <small>{t("approvalInternalNotice")}</small>
      <NavLink to={`/projects/${project}/approvals?revision=${revision}`}>
        {t("approvalViewRegister")}
      </NavLink>
    </section>
  );
}
