import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../client";
import {
  permissionNames,
  rolePermissions,
  type Permissions,
  accessRoles,
} from "../../../../packages/shared/src/access";
type Member = {
  user_id: string;
  name: string;
  email: string;
  role: string;
  active: number;
  permissions: string;
  version: number;
  added_at: string;
};
export function ProjectMembers({
  project,
  actor,
}: {
  project: string;
  actor: string;
}) {
  const { t } = useTranslation(),
    [selected, setSelected] = useState<Member | null>(null),
    [role, setRole] = useState("reviewer"),
    [permissions, setPermissions] = useState<Permissions>(
      rolePermissions("reviewer"),
    ),
    [error, setError] = useState("");
  const data = useQuery({
    queryKey: ["access", "members", project],
    queryFn: () =>
      api<{ items: Member[] }>(`access/projects/${project}/members`),
  });
  async function save(m: Member, active: boolean) {
    try {
      await api(
        `access/projects/${project}/members/${m.user_id}`,
        {
          role: active ? role : m.role,
          active,
          permissions: active
            ? permissions
            : { ...rolePermissions(m.role), ...JSON.parse(m.permissions) },
          version: m.version,
        },
        "PATCH",
      );
      setSelected(null);
      await data.refetch();
    } catch {
      setError(t("access_failed"));
    }
  }
  return (
    <section className="panel">
      <h2>{t("access_members")}</h2>
      {error && <p role="alert">{error}</p>}
      {data.data?.items.map((m) => (
        <article key={m.user_id}>
          <strong>{m.name}</strong> · {m.email} · {t(`access_role_${m.role}`)} ·{" "}
          {t(m.active ? "active" : "access_revoked")}
          {m.user_id !== actor && m.role !== "project_admin" && (
            <>
              <button
                onClick={() => {
                  setSelected(m);
                  setRole(m.role);
                  setPermissions({
                    ...rolePermissions(m.role),
                    ...JSON.parse(m.permissions),
                  });
                }}
              >
                {t("access_edit_permissions")}
              </button>
              <button onClick={() => void save(m, false)}>
                {t("access_revoke")}
              </button>
            </>
          )}
        </article>
      ))}
      {selected && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save(selected, true);
          }}
        >
          <label>
            {t("role")}
            <select
              aria-label={t("role")}
              value={role}
              onChange={(e) => {
                setRole(e.target.value);
                setPermissions(rolePermissions(e.target.value));
              }}
            >
              {accessRoles
                .filter(
                  (r) =>
                    r.startsWith("supplier_") ===
                      selected.role.startsWith("supplier_") &&
                    r !== "project_admin",
                )
                .map((r) => (
                  <option value={r} key={r}>
                    {t(`access_role_${r}`)}
                  </option>
                ))}
            </select>
          </label>
          <fieldset>
            <legend>{t("access_permissions")}</legend>
            {permissionNames
              .filter((k) => k !== "manage_members")
              .map((k) => (
                <label className="inline-check" key={k}>
                  <input
                    type="checkbox"
                    checked={permissions[k]}
                    onChange={(e) =>
                      setPermissions({ ...permissions, [k]: e.target.checked })
                    }
                  />
                  {t(`access_permission_${k}`)}
                </label>
              ))}
          </fieldset>
          <button>{t("access_save_permissions")}</button>
        </form>
      )}
    </section>
  );
}
