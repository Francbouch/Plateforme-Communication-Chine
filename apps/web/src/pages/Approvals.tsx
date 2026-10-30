import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, useNavigate, useParams, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { api } from "../client";
import { isDemo } from "../demo";
import type { Project } from "../types";
import {
  approvalStatuses,
  approvalPurposes,
  type Approval,
} from "../../../../packages/shared/src/approvals";
import {
  requestPriorities,
  referenceUrl,
} from "../../../../packages/shared/src/messages";
import { ApprovalForm } from "../approvals/ApprovalForm";
import { ApprovalDetail } from "../approvals/ApprovalDetail";
export function Approvals({ projects }: { projects: Project[] }) {
  const { project: route } = useParams(),
    [params] = useSearchParams(),
    navigate = useNavigate(),
    { t } = useTranslation(),
    project = route ?? params.get("project") ?? "";
  return (
    <>
      <div className="page-title">
        <div>
          <span className="eyebrow">ForgeBridge</span>
          <h1>{t("approvals")}</h1>
        </div>
        <NavLink to={project ? `/projects/${project}/documents` : "/documents"}>
          {t("documents")}
        </NavLink>
      </div>
      <p className="notice">{t("approvalInternalNotice")}</p>
      <label>
        {t("project")}
        <select
          value={project}
          onChange={(e) =>
            navigate(
              e.target.value
                ? `/projects/${e.target.value}/approvals`
                : "/approvals",
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
        <p>{t("realLibraryOnly")}</p>
      ) : (
        project && <ProjectApprovals key={project} project={project} />
      )}
    </>
  );
}
function ProjectApprovals({ project }: { project: string }) {
  const { t } = useTranslation(),
    [params, setParams] = useSearchParams(),
    [creating, setCreating] = useState(false),
    [q, setQ] = useState(""),
    [query, setQuery] = useState(""),
    [priority, setPriority] = useState(""),
    [purpose, setPurpose] = useState(""),
    [sort, setSort] = useState("created"),
    [page, setPage] = useState(0);
  const selected = params.get("approval") ?? "",
    status = params.get("status") ?? "",
    filter = params.get("filter") ?? "",
    revision = params.get("revision") ?? "";
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(q);
      setPage(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);
  const search = new URLSearchParams({
    q: query,
    status,
    filter,
    priority,
    purpose,
    sort,
    page: String(page),
    ...(revision ? { revision } : {}),
  });
  const list = useQuery({
    queryKey: ["approvals", project, search.toString()],
    queryFn: () =>
      api<{ items: Approval[]; hasMore: boolean }>(
        `projects/${project}/approvals?${search}`,
      ),
  });
  const summary = useQuery({
    queryKey: ["approval-summary", project],
    queryFn: () =>
      api<Record<string, number>>(`projects/${project}/approval-summary`),
  });
  function select(id: string) {
    setParams((old) => {
      const p = new URLSearchParams(old);
      if (id) p.set("approval", id);
      else p.delete("approval");
      return p;
    });
  }
  function apply(kind: string) {
    setPage(0);
    setParams((old) => {
      const p = new URLSearchParams(old);
      p.delete("approval");
      p.delete("revision");
      p.delete("status");
      p.delete("filter");
      if (["overdue", "blocking"].includes(kind)) p.set("filter", kind);
      else if (kind) p.set("status", kind);
      return p;
    });
  }
  if (selected)
    return (
      <ApprovalDetail
        key={selected}
        id={selected}
        project={project}
        onSelect={select}
        onClose={() => select("")}
      />
    );
  return (
    <>
      <div className="approval-summary">
        {[
          "pending",
          "changes_requested",
          "approved",
          "rejected",
          "overdue",
          "blocking",
        ].map((k) => (
          <button key={k} onClick={() => apply(k)}>
            <strong>{summary.data?.[k] ?? "—"}</strong>
            <span>{t(`approvalSummary_${k}`)}</span>
          </button>
        ))}
      </div>
      {summary.isError && <p role="alert">{t("approvalStateUnavailable")}</p>}
      <div className="toolbar">
        <button className="primary" onClick={() => setCreating(true)}>
          {t("requestApproval")}
        </button>
        <button
          onClick={() => {
            void list.refetch();
            void summary.refetch();
          }}
        >
          {t("refreshMessages")}
        </button>
        <label>
          {t("search")}
          <input
            type="search"
            maxLength={200}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label>
          {t("status")}
          <select value={status} onChange={(e) => apply(e.target.value)}>
            <option value="">{t("allStatuses")}</option>
            {approvalStatuses.map((s) => (
              <option key={s} value={s}>
                {t(`approval_${s}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("approvalPurpose")}
          <select
            value={purpose}
            onChange={(e) => {
              setPurpose(e.target.value);
              setPage(0);
            }}
          >
            <option value="">{t("approvalAllPurposes")}</option>
            {approvalPurposes.map((s) => (
              <option key={s} value={s}>
                {t(`approvalPurpose_${s}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("priority")}
          <select
            value={priority}
            onChange={(e) => {
              setPriority(e.target.value);
              setPage(0);
            }}
          >
            <option value="">{t("allPriorities")}</option>
            {requestPriorities.map((s) => (
              <option key={s} value={s}>
                {t(`priority_${s}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("sort")}
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              setPage(0);
            }}
          >
            {["created", "due", "decision", "priority"].map((s) => (
              <option value={s} key={s}>
                {t(`approvalSort_${s}`)}
              </option>
            ))}
          </select>
        </label>
        {(filter || revision) && (
          <button onClick={() => apply("")}>{t("approvalClearFilter")}</button>
        )}
      </div>
      {list.isError && <p role="alert">{t("approvalStateUnavailable")}</p>}
      {list.isPending && <p>{t("loading")}</p>}
      <section className="panel table-wrap">
        <table>
          <thead>
            <tr>
              {[
                "approvalNumber",
                "document",
                "revision",
                "approvalTitle",
                "status",
                "responsible",
                "created",
                "approvalDecisionDate",
                "dueDate",
                "priority",
                "actions",
              ].map((k) => (
                <th key={k}>{t(k)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.data?.items.map((a) => (
              <tr key={a.id}>
                <td>APR-{String(a.number).padStart(5, "0")}</td>
                <td>{a.document_number || a.document_name}</td>
                <td>
                  {a.revision_label}
                  {!a.is_latest && <small> · {t("approvalHistorical")}</small>}
                </td>
                <td>
                  {a.title}
                  <small className="approval-purpose-label">
                    {t(`approvalPurpose_${a.purpose}`)}
                  </small>
                </td>
                <td>
                  <span className="badge">{t(`approval_${a.status}`)}</span>
                </td>
                <td>{a.responsible || "—"}</td>
                <td>{new Date(a.created_at).toLocaleDateString()}</td>
                <td>
                  {a.decided_at
                    ? new Date(a.decided_at).toLocaleDateString()
                    : "—"}
                </td>
                <td>{a.due_date ?? "—"}</td>
                <td>{t(`priority_${a.priority}`)}</td>
                <td>
                  <button onClick={() => select(a.id)}>
                    {t("approvalDetails")}
                  </button>
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data?.items.length === 0 && <p>{t("empty")}</p>}
      </section>
      <div className="toolbar">
        <button disabled={!page} onClick={() => setPage(page - 1)}>
          {t("previous")}
        </button>
        <button
          disabled={!list.data?.hasMore}
          onClick={() => setPage(page + 1)}
        >
          {t("next")}
        </button>
      </div>
      {creating && (
        <ApprovalForm
          seed={{ project }}
          onClose={() => setCreating(false)}
          onSaved={(key) => {
            setCreating(false);
            select(key);
          }}
        />
      )}
    </>
  );
}
