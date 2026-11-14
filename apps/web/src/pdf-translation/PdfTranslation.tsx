import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../client";
import { extractNotes, type TextFragment } from "./extract";
import {
  detectNote,
  type PdfSegment,
  type PdfTranslationRow,
} from "../../../../packages/shared/src/pdf-translation";
import type { Revision } from "../../../../packages/shared/src/documents";
import { toScreen, type PageSpace } from "../review/geometry";
type HistoryEntry = {
  id: string;
  body: string;
  author: string;
  created_at: string;
  verified: number;
  approved: number | null;
  reviewed_at: string | null;
  reviewer_id: string | null;
  reviewer: string | null;
};
type Entry = {
  segment: PdfSegment;
  segment_id: string;
  translation: PdfTranslationRow | null;
  position: { dx: number; dy: number };
  detected: string;
};
type Lookup = {
  items: Omit<Entry, "segment">[];
  can_verify: boolean;
  can_propose: boolean;
  enabled: boolean;
  audience: string;
};
export function PdfTranslation({
  pdf,
  revision,
  page,
  space,
  sheet,
  selectTool,
  panelHost,
}: {
  pdf: PDFDocumentProxy | null;
  revision: Revision;
  page: number;
  space: PageSpace | null;
  sheet: HTMLElement | null;
  selectTool: boolean;
  panelHost: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const [language, setLanguage] = useState("original"),
    [source, setSource] = useState("auto"),
    [audience, setAudience] = useState("internal"),
    [entries, setEntries] = useState<Entry[]>([]),
    [active, setActive] = useState(0),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [consent, setConsent] = useState(false),
    [labels, setLabels] = useState(false),
    [interactive, setInteractive] = useState(false),
    [canVerify, setCanVerify] = useState(false),
    [canPropose, setCanPropose] = useState(false),
    [enabled, setEnabled] = useState(false),
    [body, setBody] = useState(""),
    [progress, setProgress] = useState(0),
    [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [refresh, setRefresh] = useState(0);
  const contextKey = `${revision.id}:${page}:${language}:${source}:${audience}`;
  const [entryContext, setEntryContext] = useState("");
  const visible = entryContext === contextKey ? entries : [];
  const epoch = useRef(0),
    pending = useRef(false);
  useEffect(() => {
    const generation = ++epoch.current;
    setEntries([]);
    setError("");
    setActive(0);
    setBusy(false);
    setHistory(null);
    if (!pdf || language === "original") {
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      const p = await pdf.getPage(page),
        content = await p.getTextContent();
      const fragments = content.items.filter(
        (item): item is typeof item & TextFragment => "str" in item,
      );
      const segments = extractNotes(fragments, p.view),
        all: Entry[] = [];
      for (let i = 0; i < segments.length; i += 6) {
        if (epoch.current !== generation) return;
        const batch = segments.slice(i, i + 6);
        const data = await api<Lookup>(`revisions/${revision.id}/pdf-text`, {
          page,
          segments: batch,
          source_language: source,
          target_language: language,
          audience,
        });
        if (epoch.current !== generation) return;
        setCanVerify(data.can_verify);
        setCanPropose(data.can_propose);
        setEnabled(data.enabled);
        all.push(
          ...data.items.map((item, index) => ({
            ...item,
            segment: batch[index],
          })),
        );
      }
      if (epoch.current === generation) {
        setEntryContext(
          `${revision.id}:${page}:${language}:${source}:${audience}`,
        );
        setEntries(all);
      }
    })()
      .catch((e) => {
        if (epoch.current === generation)
          setError(e instanceof ApiError ? e.message : "pdfTranslationError");
      })
      .finally(() => {
        if (epoch.current === generation) setLoading(false);
      });
    return () => {
      epoch.current++;
    };
  }, [pdf, page, language, source, audience, revision.id, refresh]);
  const chosen = visible[active],
    row = chosen?.translation;
  useEffect(() => {
    setBody(row?.body ?? "");
    setHistory(null);
  }, [row?.id, row?.body, active]);
  async function generate() {
    if (pending.current || !consent) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setProgress(0);
    const generation = epoch.current;
    try {
      for (const [index, entry] of visible.entries()) {
        if (generation !== epoch.current) break;
        const src = source === "auto" ? detectNote(entry.segment.text) : source;
        if (!entry.translation && src !== "uncertain" && src !== language) {
          const translated = await api<PdfTranslationRow>(
            `revisions/${revision.id}/pdf-translate`,
            {
              page,
              segments: [entry.segment],
              source_language: source,
              target_language: language,
              audience,
              consent: true,
            },
          );
          if (generation !== epoch.current) break;
          setEntries((current) =>
            current.map((e) =>
              e.segment_id === entry.segment_id
                ? { ...e, translation: translated }
                : e,
            ),
          );
        }
        if (generation === epoch.current) setProgress(index + 1);
      }
    } catch (e) {
      if (generation === epoch.current)
        setError(e instanceof Error ? e.message : "pdfTranslationError");
    } finally {
      pending.current = false;
      if (generation === epoch.current) setBusy(false);
    }
  }
  async function correction(verify: boolean) {
    if (!row || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const generation = epoch.current;
    try {
      const next = await api<PdfTranslationRow>(
        `pdf-translations/${row.id}/corrections`,
        { body, version: row.correction_version, verify },
      );
      if (generation === epoch.current)
        setEntries((es) =>
          es.map((e) =>
            e.translation?.id === row.id ? { ...e, translation: next } : e,
          ),
        );
    } catch (e) {
      if (generation === epoch.current)
        setError(e instanceof Error ? e.message : "pdfTranslationError");
    } finally {
      pending.current = false;
      if (generation === epoch.current) setBusy(false);
    }
  }
  async function review(id: string, approved: boolean) {
    if (!row || pending.current) return;
    pending.current = true;
    setBusy(true);
    const generation = epoch.current;
    try {
      const next = await api<PdfTranslationRow>(
        `pdf-translations/${row.id}/reviews`,
        { correction_id: id, approved },
      );
      if (generation === epoch.current)
        setEntries((es) =>
          es.map((e) =>
            e.translation?.id === row.id ? { ...e, translation: next } : e,
          ),
        );
    } catch (e) {
      if (generation === epoch.current)
        setError(e instanceof Error ? e.message : "pdfTranslationError");
    } finally {
      pending.current = false;
      if (generation === epoch.current) setBusy(false);
    }
  }
  async function move(dx: number, dy: number) {
    if (!row || !chosen || pending.current) return;
    pending.current = true;
    const generation = epoch.current;
    try {
      const pos = await api<{ dx: number; dy: number }>(
        `pdf-translations/${row.id}/position`,
        {
          dx: Math.max(
            -chosen.segment.x,
            Math.min(1 - chosen.segment.x, chosen.position.dx + dx),
          ),
          dy: Math.max(
            -chosen.segment.y,
            Math.min(1 - chosen.segment.y, chosen.position.dy + dy),
          ),
        },
      );
      if (generation === epoch.current)
        setEntries((es) =>
          es.map((e) =>
            e.segment_id === chosen.segment_id ? { ...e, position: pos } : e,
          ),
        );
    } catch {
      if (generation === epoch.current) setError("pdfTranslationError");
    } finally {
      pending.current = false;
    }
  }
  const valid = visible.filter(
    (e) => e.translation && !e.translation.warnings.length,
  );
  return (
    <div className="pdf-translation-controls">
      <label>
        {t("pdfDocumentLanguage")}{" "}
        <select
          aria-label={t("pdfDocumentLanguage")}
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          <option value="original">{t("pdfOriginal")}</option>
          <option value="en">English</option>
          <option value="fr">Français</option>
          <option value="zh-CN">中文 (简体)</option>
        </select>
      </label>
      {language !== "original" &&
        panelHost &&
        createPortal(
          <details open className="pdf-translation-panel">
            <summary>{t("pdfTranslationNotes")}</summary>
            <p>{t("pdfSafeLayer")}</p>
            <label>
              {t("pdfSourceLanguage")}{" "}
              <select
                aria-label={t("pdfSourceLanguage")}
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="auto">{t("pdfAutomaticDetection")}</option>
                <option value="en">English</option>
                <option value="fr">Français</option>
                <option value="zh-CN">中文 (简体)</option>
              </select>
            </label>
            {canVerify && (
              <label>
                {t("pdfTranslationAudience")}{" "}
                <select
                  aria-label={t("pdfTranslationAudience")}
                  value={audience}
                  onChange={(e) => setAudience(e.target.value)}
                >
                  <option value="internal">{t("pdfInternalLayer")}</option>
                  <option value="shared">{t("pdfSharedLayer")}</option>
                </select>
              </label>
            )}
            <label>
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              {t("pdfTranslationConsent")}
            </label>
            <button
              disabled={
                busy || loading || !consent || !enabled || !visible.length
              }
              onClick={() => void generate()}
            >
              {t("pdfTranslateMissing")}
            </button>
            <button
              disabled={busy || loading}
              onClick={() => setRefresh((n) => n + 1)}
            >
              {t("pdfRefreshNotes")}
            </button>
            <p role="status" data-testid="pdf-translation-progress">
              {loading
                ? t("pdfExtracting")
                : busy
                  ? t("pdfTranslationProgress", {
                      done: progress,
                      total: visible.length,
                    })
                  : visible.length
                    ? t("pdfTranslationCount", {
                        count: valid.length,
                        total: visible.length,
                      })
                    : t("pdfNoDigitalText")}
            </p>
            {visible.length === 200 && <p>{t("pdfExtractionLimit")}</p>}
            {!enabled && visible.length > 0 && (
              <p>{t("pdfProviderDisabled")}</p>
            )}
            {error && (
              <p role="alert">
                {t(error, { defaultValue: t("pdfTranslationError") })}
              </p>
            )}
            <label>
              <input
                type="checkbox"
                checked={labels}
                onChange={(e) => setLabels(e.target.checked)}
              />
              {t("pdfShowLabels")}
            </label>
            <label>
              <input
                type="checkbox"
                checked={interactive}
                onChange={(e) => setInteractive(e.target.checked)}
              />
              {t("pdfSelectNotes")}
            </label>
            <ol className="pdf-note-list">
              {visible.map((e, index) => (
                <li key={e.segment_id}>
                  <button
                    aria-pressed={active === index}
                    onClick={() => setActive(index)}
                  >
                    {e.segment.text}
                  </button>
                  {e.translation ? (
                    <p>
                      {e.translation.warnings.length
                        ? t("pdfUnsafeTranslation")
                        : e.translation.body}{" "}
                      ·{" "}
                      {t(
                        e.translation.status === "verified"
                          ? "pdfVerified"
                          : "pdfAutomatic",
                      )}
                      {e.translation.proposals.length > 0 &&
                        ` · ${t("pdfProposed")}`}
                    </p>
                  ) : (
                    <span>
                      {t(
                        source === "auto" && e.detected === "uncertain"
                          ? "pdfUncertainLanguage"
                          : (source === "auto" ? e.detected : source) ===
                              language
                            ? "pdfAlreadyOriginal"
                            : "pdfNotTranslated",
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ol>
            {chosen && (
              <section aria-label={t("pdfSelectedNote")}>
                <h3>{t("pdfSelectedNote")}</h3>
                <p>
                  <strong>{t("pdfOriginal")}</strong> : {chosen.segment.text}
                </p>
                {row && (
                  <>
                    <p>
                      <strong>
                        {t(
                          row.reused_from
                            ? "pdfReusedTranslation"
                            : "pdfMachineTranslation",
                        )}
                      </strong>{" "}
                      : {row.machine}
                    </p>
                    <p>
                      {t(
                        row.status === "verified"
                          ? "pdfVerified"
                          : "pdfAutomatic",
                      )}
                    </p>
                    {canPropose && (
                      <>
                        <label>
                          {t("pdfCorrection")}
                          <textarea
                            aria-label={t("pdfCorrection")}
                            value={body}
                            onChange={(e) => setBody(e.target.value)}
                            maxLength={2400}
                          />
                        </label>
                        <button
                          disabled={busy || !body.trim()}
                          onClick={() => void correction(false)}
                        >
                          {t("pdfProposeCorrection")}
                        </button>
                        {canVerify && (
                          <button
                            disabled={busy || !body.trim()}
                            onClick={() => void correction(true)}
                          >
                            {t("pdfVerifyCorrection")}
                          </button>
                        )}
                      </>
                    )}
                    {row.proposals.map((p) => (
                      <div key={p.id}>
                        <p>
                          {t("pdfProposed")} · {p.author} ·{" "}
                          {new Date(p.created_at).toLocaleString()}
                        </p>
                        <p>{p.body}</p>
                        {canVerify && (
                          <>
                            <button
                              disabled={busy}
                              onClick={() => void review(p.id, true)}
                            >
                              {t("pdfApproveCorrection")}
                            </button>
                            <button
                              disabled={busy}
                              onClick={() => void review(p.id, false)}
                            >
                              {t("pdfRejectCorrection")}
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                    <div role="group" aria-label={t("pdfMoveLabel")}>
                      {[
                        ["←", -0.02, 0],
                        ["→", 0.02, 0],
                        ["↑", 0, 0.02],
                        ["↓", 0, -0.02],
                      ].map(([label, dx, dy]) => (
                        <button
                          key={label}
                          onClick={() => void move(Number(dx), Number(dy))}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={() => {
                        const generation = epoch.current;
                        void api<{ items: HistoryEntry[] }>(
                          `pdf-translations/${row.id}/history`,
                        )
                          .then((data) => {
                            if (epoch.current === generation)
                              setHistory(data.items);
                          })
                          .catch(() => setError("pdfTranslationError"));
                      }}
                    >
                      {t("pdfTranslationHistory")}
                    </button>
                    {history && (
                      <div>
                        <p role="status">
                          {t("pdfHistoryCount", { count: history.length })}
                        </p>
                        <ol>
                          {history.map((h) => (
                            <li key={h.id}>
                              <p>
                                {h.author} ·{" "}
                                {new Date(h.created_at).toLocaleString()} ·{" "}
                                {t(
                                  h.verified || h.approved === 1
                                    ? "pdfVerified"
                                    : h.approved === 0
                                      ? "pdfRejected"
                                      : "pdfProposed",
                                )}
                              </p>
                              <p>{h.body}</p>
                              {h.reviewed_at && (
                                <p>
                                  {new Date(h.reviewed_at).toLocaleString()} ·{" "}
                                  {h.reviewer}
                                </p>
                              )}
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </>
                )}
              </section>
            )}
          </details>,
          panelHost,
        )}
      {language !== "original" &&
        space &&
        sheet &&
        createPortal(
          <div
            className="pdf-translation-layer"
            data-testid="pdf-translation-layer"
            aria-hidden={!interactive}
          >
            {visible.map((e, index) => {
              if (!e.translation || e.translation.warnings.length) return null;
              const [x, y] = toScreen(
                [e.segment.x + e.position.dx, e.segment.y + e.position.dy],
                space,
              );
              const rad = (e.segment.angle * Math.PI) / 180,
                [a, b, c, d] = space.transform;
              const angle =
                (Math.atan2(
                  b * Math.cos(rad) + d * Math.sin(rad),
                  a * Math.cos(rad) + c * Math.sin(rad),
                ) *
                  180) /
                Math.PI;
              return (
                <button
                  key={e.segment_id}
                  data-testid={`pdf-note-${index}`}
                  data-segment-id={e.segment_id}
                  className={active === index ? "pdf-note active" : "pdf-note"}
                  tabIndex={interactive && selectTool ? 0 : -1}
                  style={{
                    left: x,
                    top: y,
                    fontSize: labels
                      ? Math.min(
                          32,
                          Math.max(12, e.segment.font_size * Math.hypot(a, b)),
                        )
                      : 13,
                    transform: `rotate(${angle}deg) translate(0,-200%)`,
                    pointerEvents: interactive && selectTool ? "auto" : "none",
                  }}
                  title={`${e.segment.text}\n${e.translation.body}`}
                  onClick={() => setActive(index)}
                >
                  {labels && e.translation.body.length < 100
                    ? e.translation.body
                    : `[${index + 1}]`}
                </button>
              );
            })}
          </div>,
          sheet,
        )}
    </div>
  );
}
