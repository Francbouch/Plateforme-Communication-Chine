import { AccessManager } from "../access/AccessManager";
import { Glossary } from "../translations/Glossary";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../client";
import {
  roles,
  type Project,
  type Profile,
  type Supplier,
  type Invite,
  type Account,
} from "../types";
import { useTranslation } from "react-i18next";
import { Field } from "../components/Field";
export function Admin({
  org,
  projects,
  profile,
}: {
  org: string;
  projects: Project[];
  profile: Profile;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const collaborative =
    client.getQueryData<Account>(["me"])?.mode === "collaborative" ||
    !!client.getQueryData<Account>(["me"])?.access_controls_ready;
  const [message, setMessage] = useState("");
  const [token, setToken] = useState("");
  const [edit, setEdit] = useState<Supplier | null | undefined>();
  const suppliers = useQuery({
    queryKey: ["suppliers", org],
    queryFn: () => api<Supplier[]>(`suppliers?organization_id=${org}`),
    enabled: !!org,
  });
  const invitations = useQuery({
    queryKey: ["invitations", org],
    queryFn: () => api<Invite[]>(`invitations?organization_id=${org}`),
    enabled: !!org,
  });
  const members = useQuery({
    queryKey: ["members", org],
    queryFn: () =>
      api<{ user_id: string; role: string; active: boolean }[]>(
        `organization_memberships?organization_id=${org}`,
      ),
    enabled: !!org,
  });
  async function run(fn: () => Promise<unknown>) {
    try {
      await fn();
      setMessage(t("success"));
      await client.invalidateQueries();
    } catch (e) {
      setMessage(
        e instanceof ApiError
          ? `${t("error")} (${e.status}): ${e.message}`
          : t("error"),
      );
    }
  }
  return (
    <>
      <div className="page-title">
        <div>
          <span className="eyebrow">{t("security")}</span>
          <h1>{t("admin")}</h1>
          <p>{t("adminHelp")}</p>
        </div>
      </div>
      <p role="status">{message}</p>
      {collaborative && (
        <AccessManager key={`access-${org}`} org={org} projects={projects} />
      )}
      <Glossary key={org} org={org} />
      <section className="panel">
        <h2>{t("createOrganization")}</h2>
        <p>{t("privateMode")}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const name = String(new FormData(form).get("name"));
            void run(async () => {
              await api("organizations", { name });
              form.reset();
            });
          }}
        >
          <Field name="name">
            <input name="name" required maxLength={160} />
          </Field>
          <button>{t("create")}</button>
        </form>
      </section>
      <div className="admin-grid">
        <section className="panel">
          <h2>{t("preferences")}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = Object.fromEntries(new FormData(e.currentTarget));
              void run(async () => {
                await api("me", f, "PATCH");
                await i18n.changeLanguage(String(f.language));
              });
            }}
          >
            <Field name="name">
              <input
                name="name"
                defaultValue={profile.name}
                required
                maxLength={120}
              />
            </Field>
            <Field name="language">
              <select name="language" defaultValue={profile.language}>
                <option value="fr-CA">Français</option>
                <option value="en">English</option>
                <option value="zh-CN">简体中文</option>
              </select>
            </Field>
            <Field name="timezone">
              <input name="timezone" defaultValue={profile.timezone} required />
            </Field>
            <button>{t("save")}</button>
          </form>
        </section>
        <section className="panel">
          <h2>{t(collaborative ? "access_title" : "privateDeveloper")}</h2>
          <p>{t(collaborative ? "access_sharing_notice" : "privateMode")}</p>
        </section>
      </div>
      {org && (
        <>
          <section className="panel">
            <div className="section-heading">
              <h2>{t("suppliers")}</h2>
              <button onClick={() => setEdit(null)}>{t("create")}</button>
            </div>
            {suppliers.isError && <p role="alert">{t("error")}</p>}
            {suppliers.data?.map((s) => (
              <div key={s.id} className="row">
                <div>
                  <strong>{s.name}</strong>
                  <p>
                    {s.country} · {t(s.status)}
                  </p>
                </div>
                <button onClick={() => setEdit(s)}>{t("edit")}</button>
              </div>
            ))}
            {edit !== undefined && (
              <form
                key={edit?.id ?? "new"}
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = Object.fromEntries(new FormData(e.currentTarget));
                  void run(async () => {
                    await api("suppliers", {
                      ...f,
                      organization_id: org,
                      id: edit?.id ?? null,
                    });
                    setEdit(undefined);
                  });
                }}
              >
                <div className="form-grid">
                  {["name", "country", "contacts"].map((k) => (
                    <Field key={k} name={k}>
                      <input
                        name={k}
                        defaultValue={String(edit?.[k as keyof Supplier] ?? "")}
                        required={k !== "contacts"}
                        maxLength={k === "contacts" ? 2000 : 160}
                      />
                    </Field>
                  ))}
                  <Field name="language">
                    <select
                      name="language"
                      defaultValue={edit?.language ?? "zh-CN"}
                    >
                      <option value="fr-CA">Français</option>
                      <option value="en">English</option>
                      <option value="zh-CN">简体中文</option>
                    </select>
                  </Field>
                  <Field name="notes">
                    <textarea
                      name="internal_notes"
                      maxLength={4000}
                      defaultValue={edit?.supplier_notes?.internal_notes ?? ""}
                    />
                  </Field>
                  <Field name="status">
                    <select
                      name="status"
                      defaultValue={edit?.status ?? "active"}
                    >
                      <option value="active">{t("active")}</option>
                      <option value="inactive">{t("inactive")}</option>
                    </select>
                  </Field>
                </div>
                <div className="actions">
                  <button>{t("save")}</button>
                  <button type="button" onClick={() => setEdit(undefined)}>
                    {t("cancel")}
                  </button>
                </div>
              </form>
            )}
          </section>
          {!collaborative && (
            <section className="panel">
              <h2>{t("members")}</h2>
              {members.isError ? (
                <p role="alert">{t("error")}</p>
              ) : (
                members.data?.map((m) => (
                  <div className="row" key={m.user_id}>
                    <code>{m.user_id}</code>
                    <select
                      aria-label={t("role")}
                      value={m.role}
                      disabled={m.user_id === profile.id}
                      onChange={(e) =>
                        void run(() =>
                          api(
                            `organization_memberships/${m.user_id}`,
                            {
                              organization_id: org,
                              role: e.target.value,
                              active: m.active,
                            },
                            "PATCH",
                          ),
                        )
                      }
                    >
                      {roles.map((r) => (
                        <option key={r} value={r}>
                          {t(r)}
                        </option>
                      ))}
                    </select>
                    <button
                      disabled={m.user_id === profile.id}
                      onClick={() =>
                        void run(() =>
                          api(
                            `organization_memberships/${m.user_id}`,
                            {
                              organization_id: org,
                              role: m.role,
                              active: !m.active,
                            },
                            "PATCH",
                          ),
                        )
                      }
                    >
                      {t(m.active ? "revoke" : "enabled")}
                    </button>
                  </div>
                ))
              )}
            </section>
          )}
          {!collaborative && (
            <section className="panel">
              <h2>{t("invitations")}</h2>
              <p>{t("supplierAccountsDisabled")}</p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = Object.fromEntries(new FormData(e.currentTarget));
                  void run(async () => {
                    const result = await api<{ token: string }>("invitations", {
                      ...f,
                      supplier_id: f.supplier_id || null,
                      expires_days: 7,
                    });
                    setToken(result.token);
                  });
                }}
              >
                <div className="form-grid">
                  <Field name="email">
                    <input type="email" name="email" required />
                  </Field>
                  <Field name="project">
                    <select name="project_id" required>
                      <option value="">—</option>
                      {projects.map((p) => (
                        <option value={p.id} key={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field name="role">
                    <select name="role">
                      {roles
                        .filter((r) => r !== "owner")
                        .map((r) => (
                          <option value={r} key={r}>
                            {t(r)}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field name="supplier">
                    <select name="supplier_id">
                      <option value="">—</option>
                      {suppliers.data?.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <button>{t("invite")}</button>
              </form>
              {token && (
                <div className="notice">
                  <p>{t("copyToken")}</p>
                  <code className="token">{token}</code>
                  <button onClick={() => setToken("")}>{t("cancel")}</button>
                </div>
              )}
              {invitations.isError && <p role="alert">{t("error")}</p>}
              {invitations.data?.map((i) => (
                <div className="row" key={i.id}>
                  <span>
                    {i.email} · {t(i.role)}
                  </span>
                  <span>
                    {t(
                      i.revoked_at
                        ? "revoked"
                        : i.accepted_at
                          ? "accepted"
                          : Date.parse(i.expires_at) < Date.now()
                            ? "expired"
                            : "pending",
                    )}
                  </span>
                  {!i.revoked_at && !i.accepted_at && (
                    <button
                      onClick={() =>
                        void run(() =>
                          api(`invitations/${i.id}`, undefined, "DELETE"),
                        )
                      }
                    >
                      {t("revoke")}
                    </button>
                  )}
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </>
  );
}
