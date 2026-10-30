import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../client";
import { MessageBody } from "../components/MessageBody";
import { isDemo } from "../demo";
import {
  translationLanguages,
  type TranslationLanguage,
  type TranslationSource,
  type TranslationResult,
} from "../../../../packages/shared/src/translations";
export function TranslatedText(props: {
  source: TranslationSource;
  text: string;
  official?: boolean;
}) {
  return (
    <TextControl
      key={`${props.source.kind}:${props.source.id}:${props.source.field}:${props.text}`}
      {...props}
    />
  );
}
function TextControl({
  source,
  text,
  official,
}: {
  source: TranslationSource;
  text: string;
  official?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false),
    [target, setTarget] = useState<TranslationLanguage>(() => {
      const saved = localStorage.getItem("forgebridge.translation.target");
      return translationLanguages.includes(saved as TranslationLanguage)
        ? (saved as TranslationLanguage)
        : i18n.language.startsWith("zh")
          ? "zh-CN"
          : i18n.language.startsWith("en")
            ? "en"
            : "fr";
    }),
    [from, setFrom] = useState("auto"),
    [data, setData] = useState<TranslationResult | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [editing, setEditing] = useState(false),
    [correction, setCorrection] = useState(""),
    [copied, setCopied] = useState(false);
  const [showOriginal, setShowOriginal] = useState(true);
  async function translate(force = false) {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const r = await api<TranslationResult>("translations", {
        ...source,
        source_language: from,
        target_language: target,
        force,
      });
      setData(r);
      setShowOriginal(false);
      setEditing(false);
    } catch (e) {
      setError(
        e instanceof ApiError && e.message.startsWith("translation_")
          ? t(e.message)
          : t("translation_failed"),
      );
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!data) return;
    setBusy(true);
    setError("");
    try {
      setData(
        await api<TranslationResult>(
          `translations/${data.id}`,
          { body: correction, version: data.correction_version },
          "PATCH",
        ),
      );
      setEditing(false);
    } catch (e) {
      setError(
        e instanceof ApiError && e.message.startsWith("translation_")
          ? t(e.message)
          : t("translation_failed"),
      );
    } finally {
      setBusy(false);
    }
  }
  if (!text.trim()) return null;
  return (
    <div
      className="translated-text"
      data-translation-source={`${source.kind}:${source.id}:${source.field}`}
    >
      {(showOriginal || !data) && <MessageBody body={text} />}
      {!showOriginal && data && (
        <div className="translation-result" lang={target}>
          <span className="badge">
            {t(
              data.corrected !== null
                ? "translation_corrected"
                : "translation_automatic",
            )}
          </span>
          <MessageBody body={data.corrected ?? data.machine} />
          <small>
            {t("translation_review_recommended")}
            {data.cached ? ` · ${t("translation_cached")}` : ""}
          </small>
          {data.corrected_at && (
            <small>
              {t("translation_corrected_by", { name: data.corrector })} ·{" "}
              {new Date(data.corrected_at).toLocaleString()}
            </small>
          )}
          {!!data.warnings.length && (
            <p role="alert">{t("translation_technical_warning")}</p>
          )}
          {official && (
            <p className="muted">{t("translation_decision_notice")}</p>
          )}
        </div>
      )}
      {!isDemo && (
        <button
          className="translation-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {t("translation_translate")}
        </button>
      )}
      {open && (
        <div className="translation-controls">
          <label>
            {t("translation_source_language")}
            <select
              aria-label={t("translation_source_language")}
              value={from}
              disabled={busy}
              onChange={(e) => {
                setFrom(e.target.value);
                setShowOriginal(true);
                setData(null);
                setEditing(false);
              }}
            >
              <option value="auto">{t("translation_detect")}</option>
              {translationLanguages.map((l) => (
                <option key={l} value={l}>
                  {t(`translation_lang_${l}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("translation_target_language")}
            <select
              aria-label={t("translation_target_language")}
              value={target}
              disabled={busy}
              onChange={(e) => {
                const l = e.target.value as TranslationLanguage;
                setTarget(l);
                localStorage.setItem("forgebridge.translation.target", l);
                setData(null);
                setShowOriginal(true);
                setEditing(false);
              }}
            >
              {translationLanguages.map((l) => (
                <option key={l} value={l}>
                  {t(`translation_lang_${l}`)}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={busy || from === target}
            onClick={() => void translate()}
          >
            {t(busy ? "translation_loading" : "translation_generate")}
          </button>
          {data && (
            <>
              <small>
                {t("translation_detected", {
                  language: data.detected_language ?? from,
                })}
              </small>
              <button onClick={() => setShowOriginal(!showOriginal)}>
                {t(showOriginal ? "translation_show" : "translation_original")}
              </button>
              <button disabled={busy} onClick={() => void translate(true)}>
                {t("translation_again")}
              </button>
              <button
                onClick={() => {
                  void navigator.clipboard
                    .writeText(data.corrected ?? data.machine)
                    .then(() => setCopied(true))
                    .catch(() => setError(t("translation_copy_failed")));
                }}
              >
                {t(copied ? "translation_copied" : "translation_copy")}
              </button>
              <button
                onClick={() => {
                  setCorrection(data.corrected ?? data.machine);
                  setEditing(true);
                }}
              >
                {t("translation_edit")}
              </button>
              <details>
                <summary>{t("translation_versions")}</summary>
                <MessageBody body={data.original} />
                <MessageBody body={data.machine} />
              </details>
            </>
          )}
          {editing && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label>
                {t("translation_correction")}
                <textarea
                  aria-label={t("translation_correction")}
                  required
                  maxLength={16000}
                  value={correction}
                  onChange={(e) => setCorrection(e.target.value)}
                />
              </label>
              <button disabled={busy}>{t("translation_save")}</button>
              <button type="button" onClick={() => setEditing(false)}>
                {t("cancel")}
              </button>
            </form>
          )}
          {error && <p role="alert">{error}</p>}
          <small>{t("translation_privacy_notice")}</small>
        </div>
      )}
    </div>
  );
}
