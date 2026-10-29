import React, { useEffect, useState } from "react";
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
  LogOut,
  LockKeyhole,
  Wrench,
} from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { auth, api } from "./client";
import { qc } from "./query";
import type { Account, Project } from "./types";
import { Field } from "./components/Field";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Projects } from "./pages/Projects";
import { Admin } from "./pages/Admin";
import "./i18n";
import "./style.css";
function App() {
  const { t, i18n } = useTranslation();
  const [session, setSession] = useState<Session | null>(null);
  const [initial, setInitial] = useState(true);
  const [dark, setDark] = useState(
    localStorage.getItem("forgebridge.theme") === "dark",
  );
  const [org, setOrg] = useState("");
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("forgebridge.theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    if (!auth) {
      setInitial(false);
      return;
    }
    void auth.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setInitial(false);
    });
    const { data } = auth.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      qc.clear();
    });
    return () => data.subscription.unsubscribe();
  }, []);
  const account = useQuery({
    queryKey: ["me", session?.user.id],
    queryFn: () => api<Account>("me"),
    enabled: !!session,
  });
  useEffect(() => {
    if (account.data) {
      void i18n.changeLanguage(account.data.profile.language);
      if (!account.data.organizations.some((o) => o.id === org))
        setOrg(account.data.organizations[0]?.id ?? "");
    }
  }, [account.data, i18n, org]);
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
                {!["dashboard", "projects", "admin"].includes(key) && (
                  <span className="dot" title={t("soon")} />
                )}
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
            {session && (
              <button
                className="icon"
                aria-label={t("logout")}
                onClick={() => void auth?.auth.signOut()}
              >
                <LogOut size={17} />
              </button>
            )}
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
                onChange={(e) => void i18n.changeLanguage(e.target.value)}
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
            {!auth ? (
              <section className="notice">
                <LockKeyhole />
                <h1>{t("unconfigured")}</h1>
                <p>{t("configHelp")}</p>
              </section>
            ) : initial ? (
              <p role="status">{t("loading")}</p>
            ) : !session ? (
              <Login />
            ) : account.isError ? (
              <p role="alert">{t("error")}</p>
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
                      <Projects projects={projects.data ?? []} org={org} />
                    }
                  />
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
                      ([k]) => !["dashboard", "projects", "admin"].includes(k),
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
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
