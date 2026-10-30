import { useState, useEffect, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink } from "react-router";
import { isDemo } from "../demo";
import { Plus } from "lucide-react";
import { api, ApiError } from "../client";
import type { Project } from "../types";
import { Collaborators } from "./Collaborators";
import { useTranslation } from "react-i18next";
import { Field } from "../components/Field";
export function Projects({
  projects,
  org,
  loading = false,
  error = false,
}: {
  projects: Project[];
  org: string;
  loading?: boolean;
  error?: boolean;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const list = useQuery({
    queryKey: ["project-search", org, query, status, page],
    queryFn: () =>
      api<{ items: Project[]; hasMore: boolean }>(
        `projects/search?${new URLSearchParams({ organization_id: org, q: query, status, page: String(page) })}`,
      ),
    enabled: !!org && !isDemo,
  });
  const visible = isDemo
    ? projects.filter(
        (p) =>
          (!status || p.status === status) &&
          (p.name + " " + p.code).toLowerCase().includes(search.toLowerCase()),
      )
    : (list.data?.items ?? []);

  const client = useQueryClient();
  const [editing, setEditing] = useState<Project | null | undefined>();
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api("projects", {
        ...f,
        organization_id: org,
        id: editing?.id ?? null,
      });
      await client.invalidateQueries({ queryKey: ["projects", org] });
      await client.invalidateQueries({ queryKey: ["project-search"] });
      setEditing(undefined);
      setMessage(t("success"));
    } catch (e) {
      setMessage(
        e instanceof ApiError
          ? `${t("error")} (${e.status}): ${e.message}`
          : t("error"),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-title">
        <div>
          <span className="eyebrow">{t("welcome")}</span>
          <h1>{t("projects")}</h1>
        </div>
        <button
          className="primary"
          disabled={!org}
          onClick={() => setEditing(null)}
        >
          <Plus size={16} />
          {t("create")}
        </button>
      </div>
      {!org && (
        <p className="notice">
          {t("noOrg")} <NavLink to="/admin">{t("createOrganization")}</NavLink>
        </p>
      )}
      <div className="toolbar">
        <label>
          {t("search")}
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
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
            {["active", "paused", "completed", "archived"].map((s) => (
              <option key={s} value={s}>
                {t(s)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p role="status">{message}</p>
      {editing !== undefined && (
        <section className="panel">
          <form onSubmit={submit} key={editing?.id ?? "new"}>
            <div className="form-grid">
              <Field name="code">
                <input
                  name="code"
                  defaultValue={editing?.code}
                  required
                  maxLength={40}
                  pattern="[A-Za-z0-9_-]+"
                />
              </Field>
              <Field name="name">
                <input
                  name="name"
                  defaultValue={editing?.name}
                  required
                  maxLength={160}
                />
              </Field>
              <Field name="description">
                <textarea
                  name="description"
                  defaultValue={editing?.description}
                  maxLength={4000}
                />
              </Field>
              <Field name="status">
                <select
                  name="status"
                  defaultValue={editing?.status ?? "active"}
                >
                  {["active", "paused", "completed", "archived"].map((s) => (
                    <option key={s} value={s}>
                      {t(s)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="actions">
              <button className="primary" disabled={busy}>
                {t("save")}
              </button>
              <button type="button" onClick={() => setEditing(undefined)}>
                {t("cancel")}
              </button>
            </div>
          </form>
        </section>
      )}
      {(loading || (list.isFetching && !isDemo)) && (
        <p role="status">{t("loading")}</p>
      )}
      {(error || list.isError) && <p role="alert">{t("error")}</p>}
      <section className="panel table-wrap">
        <table>
          <thead>
            <tr>
              {[
                "code",
                "name",
                "status",
                "created",
                "updated",
                "documents",
                "supplier",
                "edit",
                "collaborators",
              ].map((x) => (
                <th key={x}>{t(x)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => (
              <tr key={p.id}>
                <td>
                  <code>{p.code}</code>
                </td>
                <td>
                  <strong>{p.name}</strong>
                  <p>{p.description}</p>
                </td>
                <td>
                  <span className="badge">{t(p.status)}</span>
                </td>
                <td>
                  {p.created_at
                    ? new Date(p.created_at).toLocaleDateString()
                    : "—"}
                </td>
                <td>{new Date(p.updated_at).toLocaleDateString()}</td>
                <td>
                  <NavLink to={`/projects/${p.id}/documents`}>
                    {t("openLibrary")} ({p.document_count ?? 0})
                  </NavLink>
                </td>
                <td>{p.supplier_names || "—"}</td>
                <td>
                  <button onClick={() => setEditing(p)}>{t("edit")}</button>
                  {p.status !== "archived" && (
                    <button
                      onClick={() => {
                        if (confirm(t("archiveProjectConfirm")))
                          void api("projects", { ...p, status: "archived" })
                            .then(async () => {
                              await client.invalidateQueries({
                                queryKey: ["projects"],
                              });
                              await client.invalidateQueries({
                                queryKey: ["project-search"],
                              });
                            })
                            .catch((e) =>
                              setMessage(
                                e instanceof Error ? e.message : t("error"),
                              ),
                            );
                      }}
                    >
                      {t("archive")}
                    </button>
                  )}
                </td>
                <td>
                  <button onClick={() => setSelected(p.id)}>
                    {t("collaborators")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !error && !visible.length && (
          <p className="empty">{t("empty")}</p>
        )}
      </section>
      <div className="toolbar">
        <button disabled={page === 0} onClick={() => setPage(page - 1)}>
          {t("previous")}
        </button>
        <span>
          {t("page")} {page + 1}
        </span>
        <button
          disabled={!list.data?.hasMore || isDemo}
          onClick={() => setPage(page + 1)}
        >
          {t("next")}
        </button>
      </div>
      {selected && <Collaborators project={selected} org={org} />}
    </>
  );
}
