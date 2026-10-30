import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Revision } from "../../../../packages/shared/src/documents";
import { useTranslation } from "react-i18next";
export function DocumentViewer({ revision }: { revision: Revision }) {
  const { t } = useTranslation();
  const url = `/api/v1/revisions/${revision.id}/content`;
  const canvas = useRef<HTMLCanvasElement>(null),
    container = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null),
    [page, setPage] = useState(1),
    [zoom, setZoom] = useState(1),
    [fit, setFit] = useState("width"),
    [width, setWidth] = useState(800),
    [error, setError] = useState("");
  useEffect(() => {
    const observer = new ResizeObserver((entries) =>
      setWidth(entries[0].contentRect.width),
    );
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setPdf(null);
    setPage(1);
    setZoom(1);
    setError("");
    if (revision.extension !== "pdf") return;
    let disposed = false;
    let task: ReturnType<typeof import("pdfjs-dist").getDocument> | undefined;
    void import("pdfjs-dist")
      .then((lib) => {
        if (disposed) return;
        lib.GlobalWorkerOptions.workerSrc = pdfWorker;
        task = lib.getDocument({
          url,
          withCredentials: true,
          disableAutoFetch: true,
          disableStream: true,
          cMapUrl: "/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/pdfjs/standard_fonts/",
          wasmUrl: "/pdfjs/wasm/",
        });
        void task.promise
          .then((doc) => {
            if (!disposed) setPdf(doc);
          })
          .catch(() => {
            if (!disposed) setError(t("fileOpenError"));
          });
      })
      .catch(() => setError(t("fileOpenError")));
    return () => {
      disposed = true;
      void task?.destroy();
    };
  }, [url, revision.extension, t]);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let cancelled = false,
      render:
        | ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]>
        | undefined;
    void pdf
      .getPage(page)
      .then((p) => {
        if (cancelled || !canvas.current) return;
        const base = p.getViewport({ scale: 1 });
        const fitted =
          fit === "width"
            ? (width - 24) / base.width
            : fit === "page"
              ? Math.min((width - 24) / base.width, 650 / base.height)
              : 1;
        const ratio = Math.min(devicePixelRatio || 1, 2),
          scale = Math.min(
            Math.max(0.01, fitted * zoom),
            4,
            8192 / (base.width * ratio),
            8192 / (base.height * ratio),
            Math.sqrt(16000000 / (base.width * base.height * ratio * ratio)),
          ),
          view = p.getViewport({ scale });
        const node = canvas.current;
        node.width = Math.floor(view.width * ratio);
        node.height = Math.floor(view.height * ratio);
        node.style.width = `${view.width}px`;
        node.style.height = `${view.height}px`;
        render = p.render({
          canvas: node,
          viewport: view,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        });
        void render.promise.catch((e) => {
          if (!cancelled && e.name !== "RenderingCancelledException")
            setError(t("fileOpenError"));
        });
      })
      .catch(() => {
        if (!cancelled) setError(t("fileOpenError"));
      });
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [pdf, page, zoom, fit, width, t]);
  const image = ["png", "jpg", "jpeg", "webp"].includes(revision.extension);
  return (
    <div ref={container} className="viewer">
      <div className="toolbar">
        {revision.extension === "pdf" && (
          <>
            <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
              ←
            </button>
            <label>
              {t("page")}{" "}
              <input
                aria-label={t("page")}
                type="number"
                min="1"
                max={pdf?.numPages ?? 1}
                value={page}
                onChange={(e) =>
                  setPage(
                    Math.max(
                      1,
                      Math.min(pdf?.numPages ?? 1, Number(e.target.value) || 1),
                    ),
                  )
                }
              />
            </label>
            <span>/ {pdf?.numPages ?? "…"}</span>
            <button
              disabled={!pdf || page >= pdf.numPages}
              onClick={() => setPage(page + 1)}
            >
              →
            </button>
          </>
        )}
        {(image || revision.extension === "pdf") && (
          <>
            <button
              aria-label={t("zoomOut")}
              onClick={() => setZoom(Math.max(0.25, zoom - 0.25))}
            >
              −
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              aria-label={t("zoomIn")}
              onClick={() => setZoom(Math.min(4, zoom + 0.25))}
            >
              +
            </button>
            <button
              onClick={() => {
                setFit("width");
                setZoom(1);
              }}
            >
              {t("fitWidth")}
            </button>
            <button
              onClick={() => {
                setFit("page");
                setZoom(1);
              }}
            >
              {t("fitPage")}
            </button>
          </>
        )}
        <a className="button" href={`${url}?download=1`}>
          {t("downloadOriginal")}
        </a>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="viewer-content">
        {revision.extension === "pdf" ? (
          <>
            <canvas ref={canvas} />
            {!pdf && !error && <p>{t("loading")}</p>}
          </>
        ) : image ? (
          <img
            alt={revision.filename}
            src={url}
            style={{
              width: fit === "width" ? `${zoom * 100}%` : undefined,
              maxHeight: fit === "page" ? 650 : undefined,
              transform: fit === "page" ? `scale(${zoom})` : undefined,
            }}
            onError={() => setError(t("fileOpenError"))}
          />
        ) : (
          <p>
            {t("technicalDownloadOnly")} · {revision.filename}
          </p>
        )}
      </div>
    </div>
  );
}
