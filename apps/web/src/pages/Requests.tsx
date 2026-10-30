import { ApprovalForm } from "../approvals/ApprovalForm";
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, useNavigate, useParams, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { api } from "../client";
import { isDemo } from "../demo";
import type { Project } from "../types";
import {
  requestStatuses,
  requestPriorities,
  type TechnicalRequest,
} from "../../../../packages/shared/src/messages";
import { RequestForm } from "../messages/RequestForm";
export function Requests({ projects }: { projects: Project[] }) {
  const { project: route } = useParams(),
    [params] = useSearchParams(),
    navigate = useNavigate(),
    { t } = useTranslation(),
    project = route ?? params.get("project") ?? "";
  return (
    <>
      <div className="page-title">
        <h1>{t("requests")}</h1>
        <NavLink to={project ? `/projects/${project}/messages` : "/messages"}>
          {t("messages")}
        </NavLink>
      </div>
      <label>
        {t("project")}
        <select
          value={project}
          onChange={(e) =>
            navigate(
              e.target.value
                ? `/projects/${e.target.value}/requests`
                : "/requests",
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
        project && <ProjectRequests key={project} project={project} />
      )}
    </>
  );
}
function ProjectRequests({ project }: { project: string }) {
  const navigate = useNavigate();
  const [approvalSource, setApprovalSource] = useState<TechnicalRequest | null>(
    null,
  );
  const { t } = useTranslation(),
    [q, setQ] = useState(""),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState(""),
    [priority, setPriority] = useState(""),
    [sort, setSort] = useState("updated"),
    [page, setPage] = useState(0),
    [editing, setEditing] = useState<TechnicalRequest | null>(null);
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
    priority,
    sort,
    page: String(page),
  });
  const list = useQuery({
    queryKey: ["requests", project, search.toString()],
    queryFn: () =>
      api<{ items: TechnicalRequest[]; hasMore: boolean }>(
        `projects/${project}/requests?${search}`,
      ),
  });
  return (
    <>
      <div className="toolbar">
        <label>
          {t("search")}
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label>
          {t("status")}
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(0);
            }}
          >
            <option value="">{t("allStatuses")}</option>
            {requestStatuses.map((s) => (
              <option key={s} value={s}>
                {t(`request_${s}`)}
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
            <option value="updated">{t("updated")}</option>
            <option value="due">{t("dueDate")}</option>
            <option value="priority">{t("priority")}</option>
          </select>
        </label>
        <button onClick={() => void list.refetch()}>
          {t("refreshMessages")}
        </button>
      </div>
      {list.isError && <p role="alert">{t("error")}</p>}
      {list.isPending && <p>{t("loading")}</p>}
      <section className="panel table-wrap">
        <table>
          <thead>
            <tr>
              {[
                "requestNumber",
                "requestTitle",
                "status",
                "priority",
                "responsible",
                "dueDate",
                "document",
                "sourceDiscussion",
                "edit",
              ].map((k) => (
                <th key={k}>{t(k)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.data?.items.map((r) => (
              <tr key={r.id}>
                <td>
                  <code>{r.id.slice(0, 8)}</code>
                </td>
                <td>{r.title}</td>
                <td>{t(`request_${r.status}`)}</td>
                <td>{t(`priority_${r.priority}`)}</td>
                <td>{r.responsible || "—"}</td>
                <td>{r.due_date ?? "—"}</td>
                <td>{r.document_name ?? "—"}</td>
                <td>
                  <NavLink
                    to={`/projects/${project}/messages?conversation=${r.conversation_id}&message=${r.message_id}`}
                  >
                    {t("openSourceDiscussion")}
                  </NavLink>
                </td>
                <td>
                  <button onClick={() => setEditing(r)}>
                    {t("editRequest")}
                  </button>
                  <button onClick={() => setApprovalSource(r)}>
                    {t("requestApproval")}
                  </button>
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
      {approvalSource && (
        <ApprovalForm
          seed={{
            project,
            technical_request_id: approvalSource.id,
            message_id: approvalSource.message_id,
            title: approvalSource.title,
          }}
          onClose={() => setApprovalSource(null)}
          onSaved={(id) => {
            navigate(`/projects/${project}/approvals?approval=${id}`);
          }}
        />
      )}
      {editing && (
        <RequestForm
          project={project}
          request={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            void list.refetch();
          }}
        />
      )}
    </>
  );
}
