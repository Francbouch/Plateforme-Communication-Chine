import { useState, type FormEvent } from "react";
import { auth } from "../client";
import { useTranslation } from "react-i18next";
import { Field } from "../components/Field";
export function Login() {
  const { t } = useTranslation();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [signup, setSignup] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const f = new FormData(e.currentTarget);
    const credentials = {
      email: String(f.get("email")),
      password: String(f.get("password")),
    };
    try {
      const result = signup
        ? await auth!.auth.signUp(credentials)
        : await auth!.auth.signInWithPassword(credentials);
      setMessage(result.error ? t("error") : signup ? t("checkEmail") : "");
    } catch {
      setMessage(t("error"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="auth panel">
      <span className="eyebrow">FORGEBRIDGE</span>
      <h1>{t(signup ? "signup" : "login")}</h1>
      <p>{t("authHelp")}</p>
      <form onSubmit={submit}>
        <Field name="email">
          <input name="email" type="email" autoComplete="email" required />
        </Field>
        <Field name="password">
          <input
            name="password"
            type="password"
            minLength={signup ? 12 : 1}
            autoComplete={signup ? "new-password" : "current-password"}
            required
          />
        </Field>
        <button className="primary" disabled={busy}>
          {t(signup ? "signup" : "login")}
        </button>
      </form>
      <button className="link" onClick={() => setSignup(!signup)}>
        {t(signup ? "login" : "signup")}
      </button>
      <p role="status">{message}</p>
    </section>
  );
}
