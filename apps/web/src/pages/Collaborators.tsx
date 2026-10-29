import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import { roles, type Collaborator, type Supplier } from "../types";
import { useTranslation } from "react-i18next";
import { Field } from "../components/Field";
export function Collaborators({
  project,
  org,
}: {
  project: string;
  org: string;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [message, setMessage] = useState("");
  const data = useQuery({
    queryKey: ["collaborators", project],
    queryFn: () => api<Collaborator[]>(`projects/${project}/collaborators`),
  });
  const suppliers = useQuery({
    queryKey: ["suppliers", org],
    queryFn: () => api<Supplier[]>(`suppliers?organization_id=${org}`),
  });
  async function update(m: Collaborator, r: string, a: boolean) {
    try {
      await api(
        `projects/${project}/collaborators/${m.user_id}`,
        { role: r, active: a },
        "PATCH",
      );
      await client.invalidateQueries({ queryKey: ["collaborators", project] });
    } catch {
      setMessage(t("error"));
    }
  }
  return (
    <section className="panel">
      <h2>{t("collaborators")}</h2>
      <p role="status">{message}</p>
      {data.isError && <p role="alert">{t("error")}</p>}
      {data.data?.map((m) => (
        <div className="row" key={m.user_id}>
          <code>{m.user_id}</code>
          <select
            aria-label={t("role")}
            value={m.role}
            onChange={(e) => void update(m, e.target.value, m.active)}
          >
            {roles
              .filter(
                (r) =>
                  r !== "owner" &&
                  r.startsWith("supplier_") === Boolean(m.supplier_id),
              )
              .map((r) => (
                <option value={r} key={r}>
                  {t(r)}
                </option>
              ))}
          </select>
          <button onClick={() => void update(m, m.role, !m.active)}>
            {t(m.active ? "revoke" : "enabled")}
          </button>
        </div>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const supplier = String(
            new FormData(e.currentTarget).get("supplier"),
          );
          void api(`projects/${project}/suppliers`, { supplier_id: supplier })
            .then(() => setMessage(t("success")))
            .catch(() => setMessage(t("error")));
        }}
      >
        <Field name="supplier">
          <select name="supplier" required>
            <option value="">—</option>
            {suppliers.data?.map((s) => (
              <option value={s.id} key={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <button>{t("associate")}</button>
      </form>
    </section>
  );
}
