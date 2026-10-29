import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../client";
import type { Project } from "../types";
import { Collaborators } from "./Collaborators";
import { useTranslation } from "react-i18next";
import { Field } from "../components/Field";
export function Projects({
  projects,
  org,
}: {
  projects: Project[];
  org: string;
}) {
  const { t } = useTranslation();
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
      setEditing(undefined);
      setMessage(t("success"));
    } catch {
      setMessage(t("error"));
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
      <p>{t("notAuthorized")}</p>
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
                  {["active", "paused", "archived"].map((s) => (
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
      <section className="panel table-wrap">
        <table>
          <thead>
            <tr>
              {["code", "name", "status", "edit", "collaborators"].map((x) => (
                <th key={x}>{t(x)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
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
                  <button onClick={() => setEditing(p)}>{t("edit")}</button>
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
        {!projects.length && <p className="empty">{t("empty")}</p>}
      </section>
      {selected && <Collaborators project={selected} org={org} />}
    </>
  );
}
