import { useState, type FormEvent } from "react";
import { auth } from "../client";
import { qc } from "../query";
import { useTranslation } from "react-i18next";
import { Field } from "../components/Field";
export function Mfa() {
  const { t } = useTranslation();
  const [qr, setQr] = useState("");
  const [factor, setFactor] = useState("");
  const [message, setMessage] = useState("");
  async function enroll() {
    const { data, error } = await auth!.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `ForgeBridge ${new Date().toISOString()}`,
    });
    if (error) {
      setMessage(t("error"));
      return;
    }
    setFactor(data.id);
    setQr(data.totp.qr_code);
  }
  async function verify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code"));
    let id = factor;
    if (!id) {
      const { data } = await auth!.auth.mfa.listFactors();
      id = data?.totp.find((f) => f.status === "verified")?.id ?? "";
    }
    if (!id) {
      setMessage(t("error"));
      return;
    }
    const { error } = await auth!.auth.mfa.challengeAndVerify({
      factorId: id,
      code,
    });
    setMessage(t(error ? "error" : "success"));
    if (!error) {
      setQr("");
      await qc.invalidateQueries();
    }
  }
  return (
    <section className="panel">
      <h2>{t("mfa")}</h2>
      <button onClick={() => void enroll()}>{t("enroll")}</button>
      {qr && <img className="qr" alt="TOTP QR" src={qr} />}
      <form onSubmit={(e) => void verify(e)}>
        <Field name="otp">
          <input
            name="code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            autoComplete="one-time-code"
            required
          />
        </Field>
        <button>{t(qr ? "verify" : "challenge")}</button>
      </form>
      <button
        className="link"
        onClick={() => {
          void auth!.auth.signOut({ scope: "global" }).then(({ error }) => {
            if (error) setMessage(t("error"));
          });
        }}
      >
        {t("revokeSessions")}
      </button>
      <p role="status">{message}</p>
    </section>
  );
}
