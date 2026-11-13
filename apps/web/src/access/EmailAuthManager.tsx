import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../client";
export function EmailAuthManager({ admin }: { admin: string }) {
  const { t } = useTranslation(),
    [user, setUser] = useState(""),
    [email, setEmail] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const status = useQuery({
    queryKey: ["email-auth", "status"],
    queryFn: () =>
      api<{
        schema_ready: boolean;
        enrollments?: { email: string; profile_id: string; linked: boolean }[];
      }>("access/email-auth/status"),
  });
  if (!status.data?.schema_ready) return null;
  async function enroll(id: string, address?: string) {
    setBusy(true);
    setMessage("");
    try {
      await api("access/email-auth/enrollments", {
        user_id: id,
        ...(address ? { email: address } : {}),
      });
      await status.refetch();
      setMessage(t("success"));
    } catch {
      setMessage(t("auth_enrollment_failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-label={t("auth_management")}>
      <h2>{t("auth_management")}</h2>
      <p>{t("auth_management_help")}</p>
      <button
        disabled={busy}
        onClick={() => {
          void enroll(admin);
        }}
      >
        {t("auth_enroll_self")}
      </button>
      <p>
        <a href="/login">{t("auth_signin")}</a> ·{" "}
        <a href="/recovery">{t("auth_recovery")}</a>
      </p>
      <details>
        <summary>{t("auth_enroll_existing")}</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void enroll(user, email);
          }}
        >
          <label>
            {t("auth_profile_id")}
            <input
              value={user}
              required
              pattern="[a-fA-F0-9-]{36}"
              onChange={(e) => setUser(e.target.value)}
            />
          </label>
          <label>
            {t("email")}
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <button disabled={busy}>{t("auth_approve_link")}</button>
        </form>
      </details>
      <EmailSessions />
      <ul>
        {status.data.enrollments?.map((e) => (
          <li key={e.profile_id}>
            {e.email} — {t(e.linked ? "auth_linked" : "auth_waiting")}
          </li>
        ))}
      </ul>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
export function EmailSessions() {
  const { t } = useTranslation(),
    [error, setError] = useState("");
  const sessions = useQuery({
    queryKey: ["email-auth", "sessions"],
    queryFn: () =>
      api<{ items: { id: string; createdAt: string; expiresAt: string }[] }>(
        "access/email-auth/sessions",
      ),
  });
  return (
    <details className="panel">
      <summary>{t("auth_sessions")}</summary>
      {sessions.data?.items.map((s) => (
        <p key={s.id}>
          {new Date(s.createdAt).toLocaleString()} · {t("auth_session_expires")}{" "}
          {new Date(s.expiresAt).toLocaleString()}{" "}
          <button
            onClick={() => {
              void api(`access/email-auth/sessions/${s.id}/revoke`, {})
                .then(() => sessions.refetch())
                .catch(() => setError(t("requestFailed")));
            }}
          >
            {t("auth_revoke_session")}
          </button>
        </p>
      ))}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
