import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Revision } from "../../../../packages/shared/src/documents";
import { maxUploadBytes } from "../../../../packages/shared/src/documents";
import { DocumentViewer } from "./DocumentViewer";
export function PageReplacement({
  revision,
  onSave,
  busy,
}: {
  revision: Revision;
  onSave: (file: File, label: string, description: string) => Promise<boolean>;
  busy: boolean;
}) {
  const { t } = useTranslation(),
    [targets, setTargets] = useState(""),
    [source, setSource] = useState<File | null>(null),
    [label, setLabel] = useState(""),
    [description, setDescription] = useState(""),
    [preparing, setPreparing] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false),
    [preview, setPreview] = useState<{
      file: File;
      bytes: Uint8Array;
      url: string;
    } | null>(null);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );
  useEffect(() => {
    setPreview(null);
    setError("");
    setSaved(false);
    setSource(null);
    setTargets("");
    setLabel("");
  }, [revision.id]);
  async function prepare() {
    if (!source) return;
    setPreparing(true);
    setError("");
    setSaved(false);
    setPreview(null);
    try {
      if (source.size > maxUploadBytes) throw new Error(t("pdfLimit"));
      const response = await fetch(`/api/v1/revisions/${revision.id}/content`, {
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(t("fileOpenError"));
      const lib = await import("../pdf/replacePages");
      const bytes = await lib.replacePdfPages(
        new Uint8Array(await response.arrayBuffer()),
        new Uint8Array(await source.arrayBuffer()),
        targets,
      );
      const file = new File(
        [bytes as Uint8Array<ArrayBuffer>],
        revision.filename.replace(/\.pdf$/i, "") + "-pages.pdf",
        { type: "application/pdf" },
      );
      setPreview({ file, bytes, url: URL.createObjectURL(file) });
    } catch (e) {
      const code = e instanceof Error && "code" in e ? String(e.code) : "";
      setError(code ? t(code) : t("replacementFailed"));
    } finally {
      setPreparing(false);
    }
  }
  return (
    <section className="page-replacement">
      <details>
        <summary>{t("replacePages")}</summary>
        <p>{t("replacePagesHelp")}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void prepare();
          }}
        >
          <div className="form-grid">
            <label>
              {t("pagesToReplace")}
              <input
                required
                placeholder="4,7"
                value={targets}
                onChange={(e) => {
                  setTargets(e.target.value);
                  setPreview(null);
                }}
              />
            </label>
            <label>
              {t("replacementPdf")}
              <input
                type="file"
                accept=".pdf,application/pdf"
                required
                onChange={(e) => {
                  setSource(e.target.files?.[0] ?? null);
                  setPreview(null);
                }}
              />
            </label>
          </div>
          <button disabled={preparing || busy || !source}>
            {t(preparing ? "loading" : "preparePreview")}
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
        {saved && <p role="status">{t("success")}</p>}
        {preview && (
          <>
            <h3>{t("replacementPreview")}</h3>
            <p>{t("newRevisionNoAnnotations")}</p>
            <DocumentViewer
              revision={{
                ...revision,
                filename: preview.file.name,
                size: preview.file.size,
              }}
              previewSource={preview}
            />
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (confirm(t("confirmPageReplacement")))
                  void onSave(
                    preview.file,
                    label,
                    `${t("pagesToReplace")}: ${targets} · ${t("revision")} ${revision.label}. ${description}`,
                  )
                    .then((ok) => {
                      if (ok) {
                        setPreview(null);
                        setSaved(true);
                      } else setError(t("transferFailed"));
                    })
                    .catch(() => setError(t("transferFailed")));
              }}
            >
              <label>
                {t("newRevisionLabel")}
                <input
                  required
                  maxLength={40}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
              <label>
                {t("changeDescription")}
                <textarea
                  maxLength={3000}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <button disabled={busy || !label.trim()}>
                {t("confirmNewRevision")}
              </button>
            </form>
          </>
        )}
      </details>
    </section>
  );
}
