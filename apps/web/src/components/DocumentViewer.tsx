import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Revision } from "../../../../packages/shared/src/documents";
import { useTranslation } from "react-i18next";
import { useReview } from "../review/useReview";
import { AnnotationLayer, type DrawingTool } from "../review/AnnotationLayer";
import { ReviewPanel } from "../review/ReviewPanel";
import type { PageSpace } from "../review/geometry";
import {
  reviewColors,
  type ReviewItem,
  type ReviewTarget,
} from "../../../../packages/shared/src/review";
interface DocumentViewerProps {
  revision: Revision;
  previewSource?: { bytes: Uint8Array; url: string };
  onReviewNavigate?: (target: ReviewTarget) => void;
  target?: ReviewTarget | null;
}
export function DocumentViewer(props: DocumentViewerProps) {
  // PDF.js tasks, canvas, gestures and saving state belong to one revision.
  // Old requests may finish against their original revision without touching the next session.
  return (
    <RevisionViewer
      key={`${props.revision.id}:${props.previewSource ? "preview" : "stored"}`}
      {...props}
    />
  );
}
function RevisionViewer({
  revision,
  previewSource,
  onReviewNavigate,
  target,
}: DocumentViewerProps) {
  const { t } = useTranslation();
  const url = previewSource?.url ?? `/api/v1/revisions/${revision.id}/content`;
  const pageContainer = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null),
    container = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null),
    [page, setPage] = useState(1),
    [zoom, setZoom] = useState(1),
    [fit, setFit] = useState("width"),
    [width, setWidth] = useState(800),
    [error, setError] = useState("");
  const [space, setSpace] = useState<PageSpace | null>(null),
    [rotation, setRotation] = useState(0),
    [tool, setTool] = useState<DrawingTool>("select"),
    [color, setColor] = useState<ReviewItem["color"]>("red"),
    [full, setFull] = useState(false);
  const reviewEnabled = revision.extension === "pdf" && !previewSource;
  const session = useReview(revision, page, reviewEnabled);
  useEffect(() => {
    setSpace(null);
    setRotation(0);
    setTool("select");
  }, [revision.id]);
  useEffect(() => {
    const update = () =>
      setFull(document.fullscreenElement === container.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  useEffect(() => {
    if (target?.revision_id === revision.id) {
      setPage(target.page);
      session.setSelected(target.id);
      session.setPanel(true);
    }
  }, [target, revision.id]);
  function navigate(target: ReviewTarget) {
    if (target.revision_id === revision.id) {
      setPage(target.page);
      session.setSelected(target.id);
    } else onReviewNavigate?.(target);
  }
  useEffect(() => {
    const observer = new ResizeObserver((entries) =>
      setWidth(entries[0].contentRect.width),
    );
    if (pageContainer.current) observer.observe(pageContainer.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setPdf(null);
    setPage(target?.revision_id === revision.id ? target.page : 1);
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
          ...(previewSource
            ? { data: previewSource.bytes.slice() }
            : { url, withCredentials: true }),
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
  }, [url, revision.extension, t, previewSource]);
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
        const base = p.getViewport({
          scale: 1,
          rotation: (p.rotate + rotation) % 360,
        });
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
          view = p.getViewport({
            scale,
            rotation: (p.rotate + rotation) % 360,
          });
        setSpace({
          width: view.width,
          height: view.height,
          transform: view.transform,
          box: p.view,
        });
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
  }, [pdf, page, zoom, fit, width, t, rotation]);
  useEffect(() => {
    if (!session.selected || !pageContainer.current) return;
    const node = pageContainer.current.querySelector(
      `[data-testid="annotation-${session.selected}"]`,
    );
    if (!node) return;
    const box = node.getBoundingClientRect(),
      area = pageContainer.current.getBoundingClientRect();
    if (
      box.left < area.left + 10 ||
      box.right > area.right - 10 ||
      box.top < area.top + 10 ||
      box.bottom > area.bottom - 10
    )
      pageContainer.current.scrollBy({
        left: box.left + box.width / 2 - (area.left + area.width / 2),
        top: box.top + box.height / 2 - (area.top + area.height / 2),
      });
  }, [session.selected, session.annotations.data, space]);
  const image = ["png", "jpg", "jpeg", "webp"].includes(revision.extension);
  return (
    <div ref={container} className="viewer" data-revision-id={revision.id}>
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
                disabled={!pdf}
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
        {reviewEnabled && (
          <>
            <button onClick={() => setRotation((rotation + 90) % 360)}>
              {t("rotatePage")}
            </button>
            <button
              onClick={() => {
                const promise = full
                  ? document.exitFullscreen()
                  : container.current?.requestFullscreen();
                void promise?.catch(() =>
                  session.setError(t("fullscreenUnavailable")),
                );
              }}
            >
              {t(full ? "exitFullscreen" : "fullscreen")}
            </button>
            <button onClick={() => session.setPanel(!session.panel)}>
              {t(session.panel ? "hideComments" : "showComments")}
            </button>
          </>
        )}
        <a
          className="button"
          download={previewSource ? revision.filename : undefined}
          href={previewSource ? url : `${url}?download=1`}
        >
          {t("downloadOriginal")}
        </a>
      </div>
      {error && <p role="alert">{error}</p>}
      {reviewEnabled && (
        <>
          <p className="eyebrow" data-testid="active-review-revision">
            {t("annotatingRevision", { revision: revision.label })}
          </p>
          <div
            className="annotation-toolbar"
            role="toolbar"
            aria-label={t("annotationTools")}
          >
            {(
              [
                "select",
                "marker",
                "rectangle",
                "arrow",
                "freehand",
                "highlight",
                "text",
              ] as DrawingTool[]
            ).map((name) => (
              <button
                key={name}
                aria-pressed={tool === name}
                disabled={session.saving || !pdf}
                onClick={() => setTool(name)}
              >
                {t(`tool_${name}`)}
              </button>
            ))}
            <label>
              {t("drawingColor")}
              <select
                value={color}
                onChange={(e) => setColor(e.target.value as typeof color)}
              >
                {reviewColors.map((c) => (
                  <option key={c} value={c}>
                    {t(`color_${c}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p role="status" data-testid="review-save-state">
            {t(
              session.saving
                ? "savingReview"
                : session.error
                  ? "reviewNotSaved"
                  : session.saved
                    ? "reviewSaved"
                    : "reviewReady",
            )}
          </p>
          {session.error && <p role="alert">{session.error}</p>}
          {session.annotations.isError && (
            <p role="alert">{t("reviewLoadError")}</p>
          )}
          {session.annotations.hasNextPage && (
            <button onClick={() => void session.annotations.fetchNextPage()}>
              {t("moreAnnotations")}
            </button>
          )}
        </>
      )}
      <div
        className={
          reviewEnabled && session.panel
            ? "review-layout"
            : "review-layout expanded"
        }
      >
        <div className="viewer-content" ref={pageContainer}>
          {revision.extension === "pdf" ? (
            <>
              <div
                className="pdf-sheet"
                style={{ width: space?.width, height: space?.height }}
              >
                <canvas ref={canvas} />
                {reviewEnabled && space && (
                  <AnnotationLayer
                    key={`${revision.id}-${page}`}
                    space={space}
                    page={page}
                    tool={tool}
                    color={color}
                    session={session}
                    onDrawn={() => setTool("select")}
                  />
                )}
              </div>
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
        {reviewEnabled && session.panel && (
          <ReviewPanel
            session={session}
            revision={revision}
            currentPage={page}
            pageCount={pdf?.numPages ?? 1}
            onNavigate={navigate}
          />
        )}
      </div>
    </div>
  );
}
