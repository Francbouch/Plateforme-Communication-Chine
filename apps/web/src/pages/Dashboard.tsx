import { useQuery } from "@tanstack/react-query";
import { NavLink } from "react-router";
import {
  Plus,
  FolderKanban,
  ClipboardCheck,
  Shield,
  ArrowUpRight,
} from "lucide-react";
import { api } from "../client";
import type { Project, Invite } from "../types";
import { useTranslation } from "react-i18next";
export function Dashboard({
  projects,
  org,
  loading,
  error,
  timezone,
}: {
  projects: Project[];
  org: string;
  loading: boolean;
  error: boolean;
  timezone: string;
}) {
  const { t, i18n } = useTranslation();
  const invites = useQuery({
    queryKey: ["invitations", org],
    queryFn: () => api<Invite[]>(`invitations?organization_id=${org}`),
    enabled: !!org,
  });
  const events = useQuery({
    queryKey: ["audit_events", org],
    queryFn: () =>
      api<{ id: string; action: string; created_at: string }[]>(
        `audit_events?organization_id=${org}`,
      ),
    enabled: !!org,
  });
  return (
    <>
      <div className="page-title">
        <div>
          <span className="eyebrow">{t("dashboard")}</span>
          <h1>{t("welcome")}</h1>
          <p>{t("intro")}</p>
        </div>
        <NavLink className="button primary" to="/projects">
          <Plus size={16} />
          {t("projects")}
        </NavLink>
      </div>
      <div className="summary">
        <div>
          <FolderKanban />
          <strong>{loading || error ? "—" : projects.length}</strong>
          <span>{t("projects")}</span>
        </div>
        <div>
          <ClipboardCheck />
          <strong>
            {invites.isPending || invites.isError
              ? "—"
              : (invites.data ?? []).filter(
                  (i) =>
                    !i.accepted_at &&
                    !i.revoked_at &&
                    Date.parse(i.expires_at) > Date.now(),
                ).length}
          </strong>
          <span>{t("invitations")}</span>
        </div>
        <div className="summary-note">
          <Shield />
          <span>
            {t("security")}
            <small>{t("notAuthorized")}</small>
          </span>
        </div>
      </div>
      <div className="section-heading">
        <h2>{t("recent")}</h2>
        <NavLink to="/projects">
          {t("projects")} <ArrowUpRight size={15} />
        </NavLink>
      </div>
      {loading ? (
        <p>{t("loading")}</p>
      ) : error ? (
        <p role="alert">{t("error")}</p>
      ) : (
        <div className="project-grid">
          {[...projects]
            .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
            .slice(0, 6)
            .map((p) => (
              <NavLink className="project-card panel" to="/projects" key={p.id}>
                <div className="card-top">
                  <span className="folder">
                    <FolderKanban size={23} />
                  </span>
                  <span className="badge">{t(p.status)}</span>
                </div>
                <span className="eyebrow">{p.code}</span>
                <h3>{p.name}</h3>
                <p>{p.description}</p>
                <div className="card-bottom">
                  <span>
                    {new Intl.DateTimeFormat(i18n.language, {
                      timeZone: timezone,
                    }).format(new Date(p.updated_at))}
                  </span>
                  <ArrowUpRight size={17} />
                </div>
              </NavLink>
            ))}
          {!projects.length && <p className="empty">{t("empty")}</p>}
        </div>
      )}
      <div className="section-heading">
        <h2>{t("activity")}</h2>
      </div>
      <section className="panel">
        {events.isError ? (
          <p role="alert">{t("error")}</p>
        ) : !events.data?.length ? (
          <p>{t("empty")}</p>
        ) : (
          events.data.slice(0, 8).map((e) => (
            <div className="row" key={e.id}>
              <code>{e.action}</code>
              <time>
                {new Intl.DateTimeFormat(i18n.language, {
                  timeZone: timezone,
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(e.created_at))}
              </time>
            </div>
          ))
        )}
      </section>
    </>
  );
}
