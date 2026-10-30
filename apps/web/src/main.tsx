import React, { useEffect, useState, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Routes, Route } from "react-router";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Layers,
  LayoutDashboard,
  FolderKanban,
  Files,
  MessageSquare,
  ClipboardCheck,
  Factory,
  Shield,
  Bell,
  Settings,
  Globe,
  Sun,
  LockKeyhole,
  Wrench,
} from "lucide-react";
import { api } from "./client";
import { isDemo } from "./demo";
import { qc } from "./query";
import type { Account, Project } from "./types";
import { Field } from "./components/Field";
import { Dashboard } from "./pages/Dashboard";
const Documents = lazy(() =>
  import("./pages/Documents").then((module) => ({ default: module.Documents })),
);
const Messages = lazy(() =>
  import("./pages/Messages").then((m) => ({ default: m.Messages })),
);
const Requests = lazy(() =>
  import("./pages/Requests").then((m) => ({ default: m.Requests })),
);
import { Projects } from "./pages/Projects";
import { Admin } from "./pages/Admin";
import "./i18n";
import "./style.css";
function App() {
  const { t, i18n } = useTranslation();
  const [dark, setDark] = useState(
    localStorage.getItem("forgebridge.theme") === "dark",
  );
  const organizationKey = isDemo
    ? "forgebridge.demo.organization"
    : "forgebridge.organization";
  const [org, setOrg] = useState(
    () => localStorage.getItem(organizationKey) ?? "",
  );
  const [languageError, setLanguageError] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("forgebridge.theme", dark ? "dark" : "light");
  }, [dark]);
  const account = useQuery({
    queryKey: ["me"],
    queryFn: () => api<Account>("me"),
  });
  useEffect(() => {
    if (account.data) {
      if (!account.data.organizations.some((o) => o.id === org))
        setOrg(account.data.organizations[0]?.id ?? "");
    }
  }, [account.data, org]);
  useEffect(() => {
    if (account.data?.organizations.some((o) => o.id === org))
      localStorage.setItem(organizationKey, org);
  }, [account.data, org, organizationKey]);
  const preferredLanguage = account.data?.profile.language;
  useEffect(() => {
    if (preferredLanguage) void i18n.changeLanguage(preferredLanguage);
  }, [preferredLanguage]);
  async function updateLanguage(language: string) {
    try {
      if (account.data)
        await api(
          "me",
          {
            name: account.data.profile.name,
            timezone: account.data.profile.timezone,
            language,
          },
          "PATCH",
        );
      await i18n.changeLanguage(language);
      setLanguageError(false);
      if (account.data) await qc.invalidateQueries({ queryKey: ["me"] });
    } catch {
      setLanguageError(true);
    }
  }
  const projects = useQuery({
    queryKey: ["projects", org],
    queryFn: () => api<Project[]>(`projects?organization_id=${org}`),
    enabled: !!org,
  });
  const nav = [
    ["dashboard", LayoutDashboard, "/"],
    ["projects", FolderKanban, "/projects"],
    ["documents", Files, "/documents"],
    ["requests", Wrench, "/requests"],
    ["messages", MessageSquare, "/messages"],
    ["approvals", ClipboardCheck, "/approvals"],
    ["manufacturing", Factory, "/manufacturing"],
    ["legal", Shield, "/legal"],
    ["notifications", Bell, "/notifications"],
    ["admin", Settings, "/admin"],
  ] as const;
  return (
    <>
      <div className="shell">
        <aside>
          <div className="brand">
            <span className="mark">
              <Layers size={23} />
            </span>
            ForgeBridge<span className="phase">01</span>
          </div>
          <p className="brand-caption">{t("brand")}</p>
          <div className="workspace">
            <LockKeyhole size={16} />
            <span>{t("security")}</span>
          </div>
          <nav aria-label={t("welcome")}>
            {nav.map(([key, Icon, path]) => (
              <NavLink key={key} to={path} end={path === "/"}>
                <Icon size={18} />
                <span>{t(key)}</span>
                {![
                  "dashboard",
                  "projects",
                  "admin",
                  "documents",
                  "messages",
                  "requests",
                ].includes(key) && <span className="dot" title={t("soon")} />}
              </NavLink>
            ))}
          </nav>
          <div className="aside-bottom">
            <span className="avatar">
              {account.data?.profile.name.slice(0, 2).toUpperCase() || "FB"}
            </span>
            <div>
              <strong>{account.data?.profile.name || "ForgeBridge"}</strong>
              <small>{t("security")}</small>
            </div>
          </div>
        </aside>
        <div className="main">
          <header>
            <span className="eyebrow">FORGEBRIDGE / {t("welcome")}</span>
            <div className="header-tools">
              <Globe size={16} />
              <select
                aria-label={t("language")}
                value={i18n.language}
                onChange={(e) => void updateLanguage(e.target.value)}
              >
                <option value="fr-CA">Français</option>
                <option value="en">English</option>
                <option value="zh-CN">简体中文</option>
              </select>
              <button
                className="icon"
                aria-label={t("theme")}
                onClick={() => setDark(!dark)}
              >
                <Sun size={18} />
              </button>
            </div>
          </header>
          <main>
            {isDemo && (
              <p className="notice" role="status">
                Aperçu de démonstration · Données fictives · Aucune connexion
                requise · Modifications limitées à cet onglet.
              </p>
            )}
            {languageError && <p role="alert">{t("error")}</p>}
            {account.isError ? (
              <section className="notice" role="alert">
                <LockKeyhole />
                <h1>{t("privateAccessRequired")}</h1>
                <p>{t("privateAccessHelp")}</p>
                <button onClick={() => window.location.reload()}>
                  {t("retry")}
                </button>
              </section>
            ) : account.isPending ? (
              <p role="status">{t("loading")}</p>
            ) : (
              <>
                <div className="org-selector">
                  <Field name="organization">
                    <select
                      value={org}
                      onChange={(e) => setOrg(e.target.value)}
                    >
                      {account.data.organizations.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                {!org && <p className="notice">{t("noOrg")}</p>}
                <Routes>
                  <Route
                    path="/"
                    element={
                      <Dashboard
                        projects={projects.data ?? []}
                        timezone={account.data.profile.timezone}
                        loading={projects.isPending && !!org}
                        error={projects.isError}
                        org={org}
                      />
                    }
                  />
                  <Route
                    path="/projects"
                    element={
                      <Projects
                        projects={projects.data ?? []}
                        org={org}
                        loading={projects.isPending && !!org}
                        error={projects.isError}
                      />
                    }
                  />
                  <Route
                    path="/documents"
                    element={
                      <Suspense fallback={<p>{t("loading")}</p>}>
                        <Documents projects={projects.data ?? []} />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/projects/:project/documents"
                    element={
                      <Suspense fallback={<p>{t("loading")}</p>}>
                        <Documents projects={projects.data ?? []} />
                      </Suspense>
                    }
                  />
                  {["/messages", "/projects/:project/messages"].map((path) => (
                    <Route
                      key={path}
                      path={path}
                      element={
                        <Suspense fallback={<p>{t("loading")}</p>}>
                          <Messages
                            projects={projects.data ?? []}
                            actor={account.data.profile.id}
                          />
                        </Suspense>
                      }
                    />
                  ))}
                  {["/requests", "/projects/:project/requests"].map((path) => (
                    <Route
                      key={path}
                      path={path}
                      element={
                        <Suspense fallback={<p>{t("loading")}</p>}>
                          <Requests projects={projects.data ?? []} />
                        </Suspense>
                      }
                    />
                  ))}
                  <Route
                    path="/admin"
                    element={
                      <Admin
                        org={org}
                        projects={projects.data ?? []}
                        profile={account.data.profile}
                      />
                    }
                  />
                  {nav
                    .filter(
                      ([k]) =>
                        ![
                          "dashboard",
                          "projects",
                          "admin",
                          "documents",
                          "messages",
                          "requests",
                        ].includes(k),
                    )
                    .map(([key]) => (
                      <Route
                        key={key}
                        path={`/${key}`}
                        element={
                          <section className="notice">
                            <Files />
                            <h1>{t(key)}</h1>
                            <p>
                              {t(
                                key === "documents" ? "documentsHelp" : "soon",
                              )}
                            </p>
                          </section>
                        }
                      />
                    ))}
                  <Route
                    path="*"
                    element={<NavLink to="/">{t("back")}</NavLink>}
                  />
                </Routes>
              </>
            )}
          </main>
          <footer>
            ForgeBridge <span>·</span> {t("security")}
          </footer>
        </div>
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter basename={isDemo ? "/demo" : "/"}>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
