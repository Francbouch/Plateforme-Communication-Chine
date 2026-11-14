import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
export function EmailLogin({
  onSignedIn,
}: {
  onSignedIn: () => Promise<unknown>;
}) {
  const { t, i18n } = useTranslation();
  const [email, setEmail] = useState(""),
    [otp, setOtp] = useState(""),
    [sent, setSent] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const pending = useRef(false);
  async function submit(signin: boolean) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        signin
          ? "/api/auth/sign-in/email-otp"
          : "/api/auth/email-otp/send-verification-otp",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            signin
              ? { email: email.trim().toLowerCase(), otp }
              : { email: email.trim().toLowerCase(), type: "sign-in" },
          ),
        },
      );
      if (!response.ok) {
        setMessage(
          t(
            response.status === 429
              ? "requestRateLimited"
              : signin
                ? "auth_invalid_code"
                : "requestFailed",
          ),
        );
        return;
      }
      if (signin) {
        setOtp("");
        await onSignedIn();
      } else {
        setSent(true);
        setMessage(t("auth_code_notice"));
      }
    } catch {
      setMessage(t("offlineError"));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <main className="access-entry panel">
      <strong>ForgeBridge</strong>
      <h1>{t("auth_signin")}</h1>
      <p>{t("auth_help")}</p>
      <select
        aria-label={t("language")}
        value={i18n.language}
        onChange={(e) => {
          void i18n.changeLanguage(e.target.value);
        }}
      >
        <option value="fr-CA">Français</option>
        <option value="en">English</option>
        <option value="zh-CN">简体中文</option>
      </select>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(sent);
        }}
      >
        <label>
          {t("email")}
          <input
            type="email"
            required
            autoComplete="email"
            maxLength={254}
            value={email}
            disabled={busy}
            onChange={(e) => {
              setEmail(e.target.value);
              setSent(false);
              setOtp("");
              setMessage("");
            }}
          />
        </label>
        {sent && (
          <label>
            {t("auth_code")}
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{8}"
              required
              minLength={8}
              maxLength={8}
              value={otp}
              disabled={busy}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
            />
          </label>
        )}
        <button disabled={busy}>{t(sent ? "auth_verify" : "auth_send")}</button>
        {sent && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void submit(false);
            }}
          >
            {t("auth_resend")}
          </button>
        )}
      </form>
      {message && <p role="status">{message}</p>}
      <a href="/recovery">{t("auth_recovery")}</a>
    </main>
  );
}
