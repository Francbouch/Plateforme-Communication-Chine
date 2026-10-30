import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useSearchParams, NavLink } from "react-router";
import {
  Folder as FolderIcon,
  FileText,
  Image,
  FileBox,
  Upload,
  MoreHorizontal,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../client";
import { isDemo } from "../demo";
import { PageReplacement } from "../components/PageReplacement";
import type { ReviewTarget } from "../../../../packages/shared/src/review";
import { DocumentViewer } from "../components/DocumentViewer";
import {
  documentStatuses,
  fileTypes,
  maxUploadBytes,
  type Folder,
  type DocumentRow,
  type Revision,
  type DocumentInfo,
  type DocumentDetail,
  type Page,
} from "../../../../packages/shared/src/documents";
import type { Project } from "../types";
function useDebounce(value: string) {
  const [result, setResult] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setResult(value), 300);
    return () => clearTimeout(timer);
  }, [value]);
  return result;
}
export function FileIcon({ extension }: { extension: string }) {
  const Icon =
    extension === "pdf"
      ? FileText
      : ["png", "jpg", "jpeg", "webp"].includes(extension)
        ? Image
        : FileBox;
  return <Icon size={18} aria-hidden />;
}
function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
export function sizeText(n: number) {
  return n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
}
export function FolderPicker({
  project,
  value,
  onChange,
}: {
  project: string;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const { t } = useTranslation();
  const [pickerPage, setPickerPage] = useState(0);
  useEffect(() => setPickerPage(0), [value, project]);
  const folders = useQuery({
    queryKey: ["folder-picker", project, value, pickerPage],
    queryFn: () =>
      api<{ items: Folder[]; hasMore: boolean }>(
        `projects/${project}/folders?parent_id=${value ?? ""}&page=${pickerPage}`,
      ),
  });
  const path = useQuery({
    queryKey: ["folder-path", value],
    queryFn: () => api<Folder[]>(`folders/${value}/path`),
    enabled: !!value,
  });
  return (
    <div className="folder-picker">
      <strong>{t("destination")}</strong>
      <div className="toolbar">
        <button type="button" onClick={() => onChange(null)}>
          {t("libraryRoot")}
        </button>
        {path.data?.map((f) => (
          <button type="button" key={f.id} onClick={() => onChange(f.id)}>
            / {f.name}
          </button>
        ))}
      </div>
      {folders.isError && <p role="alert">{t("error")}</p>}
      <div className="toolbar">
        {folders.data?.items.map((f) => (
          <button type="button" key={f.id} onClick={() => onChange(f.id)}>
            <FolderIcon size={15} />
            {f.name} →
          </button>
        ))}
      </div>
      <div className="toolbar">
        <button
          type="button"
          disabled={pickerPage === 0}
          onClick={() => setPickerPage(pickerPage - 1)}
        >
          {t("previous")}
        </button>
        <span>{pickerPage + 1}</span>
        <button
          type="button"
          disabled={!folders.data?.hasMore}
          onClick={() => setPickerPage(pickerPage + 1)}
        >
          {t("next")}
        </button>
      </div>
    </div>
  );
}
interface Transfer {
  id: string;
  file: File;
  progress: number;
  state: "waiting" | "uploading" | "done" | "failed";
  error?: string;
  uploadId?: string;
  document: DocumentInfo | null;
  label: string;
  change: string;
}
export function Documents({ projects }: { projects: Project[] }) {
  const { project: routeProject } = useParams(),
    [search, setSearch] = useSearchParams(),
    { t } = useTranslation(),
    client = useQueryClient();
  const project = routeProject ?? search.get("project") ?? "",
    folder = search.get("folder") ?? null;
  const [q, setQ] = useState(""),
    [status, setStatus] = useState(""),
    [extension, setExtension] = useState(""),
    [revision, setRevision] = useState(""),
    [after, setAfter] = useState(""),
    [sort, setSort] = useState("date"),
    [direction, setDirection] = useState("desc"),
    [allFolders, setAllFolders] = useState(false),
    [page, setPage] = useState(0);
  const debounced = useDebounce(q),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [drag, setDrag] = useState(false),
    [transfers, setTransfers] = useState<Transfer[]>([]),
    [uploading, setUploading] = useState(false);
  const [editingFolder, setEditingFolder] = useState<
      Folder | null | undefined
    >(),
    [folderName, setFolderName] = useState(""),
    [target, setTarget] = useState<string | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [editDoc, setEditDoc] = useState<DocumentInfo | null>(null),
    [revLabel, setRevLabel] = useState(""),
    [changes, setChanges] = useState(""),
    [viewRevision, setViewRevision] = useState("");
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null);
  const [folderPage, setFolderPage] = useState(0);
  const [revisionPage, setRevisionPage] = useState(0),
    [historyPage, setHistoryPage] = useState(0);
  useEffect(() => {
    setRevisionPage(0);
    setHistoryPage(0);
  }, [selected]);
  useEffect(() => {
    setPage(0);
    setFolderPage(0);
    setSelected(null);
    setViewRevision("");
  }, [project, folder]);
  useEffect(() => {
    setPage(0);
  }, [
    debounced,
    status,
    extension,
    revision,
    after,
    sort,
    direction,
    allFolders,
  ]);
  useEffect(() => {
    if (!uploading) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);
  const enabled = !!project && !isDemo;
  const config = useQuery({
    queryKey: ["library-config", project],
    queryFn: () =>
      api<{ storageReady: boolean; maxUploadBytes: number }>(
        `projects/${project}/library`,
      ),
    enabled,
  });
  const folders = useQuery({
    queryKey: ["folders", project, folder, folderPage],
    queryFn: () =>
      api<{ items: Folder[]; hasMore: boolean }>(
        `projects/${project}/folders?parent_id=${folder ?? ""}&page=${folderPage}`,
      ),
    enabled,
  });
  const path = useQuery({
    queryKey: ["folder-path", folder],
    queryFn: () => api<Folder[]>(`folders/${folder}/path`),
    enabled: enabled && !!folder,
  });
  const params = new URLSearchParams({
    folder_id: allFolders ? "all" : (folder ?? ""),
    q: debounced,
    status,
    extension,
    revision,
    after,
    sort,
    direction,
    page: String(page),
  });
  const docs = useQuery({
    queryKey: ["documents", project, params.toString()],
    queryFn: () =>
      api<Page<DocumentRow>>(`projects/${project}/documents?${params}`),
    enabled,
  });
  const detail = useQuery({
    queryKey: ["document", selected, revisionPage, historyPage],
    queryFn: () =>
      api<DocumentDetail>(
        `documents/${selected}?revision_page=${revisionPage}&history_page=${historyPage}`,
      ),
    enabled: enabled && !!selected,
  });
  // Stable message links select the requested revision explicitly, never the latest.
  const linkedDocument = search.get("document"),
    linkedRevision = search.get("revision"),
    linkedPoint = search.get("point"),
    linkedPage = search.get("pdf_page");
  useEffect(() => {
    if (!linkedDocument) return;
    setSelected(linkedDocument);
    setViewRevision(linkedRevision ?? "");
    setReviewTarget(
      linkedRevision
        ? {
            revision_id: linkedRevision,
            page: Math.max(1, Number(linkedPage) || 1),
            id: linkedPoint ?? "",
          }
        : null,
    );
  }, [
    linkedDocument,
    linkedRevision,
    linkedPage,
    linkedPoint,
    project,
    folder,
  ]);
  const targetedRevision = useQuery({
    queryKey: ["revision-meta", viewRevision],
    queryFn: () => api<Revision>(`revisions/${viewRevision}`),
    enabled:
      !!selected &&
      !!viewRevision &&
      !detail.data?.revisions.some((r) => r.id === viewRevision),
  });
  const current = viewRevision
    ? (detail.data?.revisions.find((r) => r.id === viewRevision) ??
      (targetedRevision.data?.document_id === selected
        ? targetedRevision.data
        : undefined))
    : detail.data?.revisions[0];
  const linkedUnavailable =
    !!viewRevision &&
    !current &&
    !targetedRevision.isPending &&
    !detail.isPending;
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["folders"] }),
      client.invalidateQueries({ queryKey: ["folder-picker"] }),
      client.invalidateQueries({ queryKey: ["folder-path"] }),
      client.invalidateQueries({ queryKey: ["documents"] }),
      client.invalidateQueries({ queryKey: ["document"] }),
      client.invalidateQueries({ queryKey: ["projects"] }),
      client.invalidateQueries({ queryKey: ["project-search"] }),
    ]);
  };
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
      await refresh();
      setMessage(t("success"));
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function navigateFolder(id: string | null) {
    const next = new URLSearchParams(search);
    if (id) next.set("folder", id);
    else next.delete("folder");
    setSearch(next);
  }
  function transferUpdate(id: string, patch: Partial<Transfer>) {
    setTransfers((old) =>
      old.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    );
  }
  async function send(
    item: Transfer,
    document: DocumentInfo | null,
    label: string,
    change: string,
  ) {
    let uploadId = item.uploadId;
    try {
      transferUpdate(item.id, {
        state: "uploading",
        error: undefined,
        progress: 0,
      });
      const ext = item.file.name.split(".").pop()!.toLowerCase();
      if (!Object.hasOwn(fileTypes, ext)) throw new Error(t("unsupportedFile"));
      if (!item.file.size || item.file.size > maxUploadBytes)
        throw new Error(t("uploadLimit"));
      if (!uploadId) {
        const digest = await crypto.subtle.digest(
          "SHA-256",
          await item.file.arrayBuffer(),
        );
        const sha256 = [...new Uint8Array(digest)]
          .map((n) => n.toString(16).padStart(2, "0"))
          .join("");
        const reservation = await api<{ id: string }>(
          `projects/${project}/uploads`,
          {
            document_id: document?.id ?? null,
            folder_id: document?.folder_id ?? folder,
            name: document?.name ?? item.file.name,
            number: document?.number ?? "",
            description: document?.description ?? "",
            status: document?.status ?? "draft",
            label: label || "A",
            change_description: change,
            filename: item.file.name,
            size: item.file.size,
            sha256,
          },
        );
        uploadId = reservation.id;
        transferUpdate(item.id, { uploadId });
      }
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", `/api/v1/uploads/${uploadId}/content`);
        xhr.timeout = 300000;
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable)
            transferUpdate(item.id, {
              progress: Math.round((e.loaded / e.total) * 95),
            });
        };
        xhr.onerror = () => reject(new Error(t("transferFailed")));
        xhr.ontimeout = () => reject(new Error(t("transferFailed")));
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else {
            try {
              reject(
                new ApiError(
                  xhr.status,
                  JSON.parse(xhr.responseText).error ?? t("transferFailed"),
                ),
              );
            } catch {
              reject(new Error(t("transferFailed")));
            }
          }
        };
        xhr.send(item.file);
      });
      await api(`uploads/${uploadId}/complete`, {});
      transferUpdate(item.id, { state: "done", progress: 100 });
      return true;
    } catch (e) {
      transferUpdate(item.id, { state: "failed", error: errorText(e) });
      return false;
    }
  }
  async function enqueue(
    files: FileList | File[],
    document: DocumentInfo | null = null,
    override?: { label: string; change: string },
  ) {
    if (uploading) {
      setMessage(t("loading"));
      return;
    }
    if (!config.data?.storageReady) {
      setMessage(t(config.isPending ? "loading" : "storageNotReady"));
      return;
    }
    const requestedLabel = override?.label ?? revLabel,
      requestedChange = override?.change ?? changes;
    const added = Array.from(files).map((file) => ({
      id: crypto.randomUUID(),
      file,
      progress: 0,
      state: "waiting" as const,
      document,
      label: document ? requestedLabel : "A",
      change: requestedChange,
    }));
    if (document && added.length !== 1) {
      setMessage(t("oneRevisionFile"));
      return;
    }
    if (document && !requestedLabel.trim()) {
      setMessage(t("revisionRequired"));
      return;
    }
    setTransfers((old) => [...old.filter((i) => i.state !== "done"), ...added]);
    setUploading(true);
    try {
      let success = true;
      for (const item of added)
        success =
          (await send(item, document, item.label, item.change)) && success;
      setRevisionPage(0);
      await refresh();
      return success;
    } finally {
      setUploading(false);
    }
  }
  if (isDemo)
    return (
      <section className="notice">
        <h1>{t("documents")}</h1>
        <p>{t("realLibraryOnly")}</p>
      </section>
    );
  return (
    <>
      <div className="page-title">
        <div>
          <span className="eyebrow">{t("documents")}</span>
          <h1>
            {projects.find((p) => p.id === project)?.name ?? t("library")}
          </h1>
          <p>{t("libraryHelp")}</p>
        </div>
        <NavLink to="/projects">{t("projects")}</NavLink>
      </div>
      {!routeProject && (
        <label>
          {t("project")}
          <select
            value={project}
            onChange={(e) =>
              setSearch(e.target.value ? { project: e.target.value } : {})
            }
          >
            <option value="">{t("selectProject")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} — {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {project && (
        <>
          {config.isError && (
            <p role="alert">
              {t("error")}: {errorText(config.error)}
            </p>
          )}
          {config.data && !config.data.storageReady && (
            <p className="notice" role="alert">
              {t("storageNotReady")}
            </p>
          )}
          <nav className="breadcrumbs" aria-label={t("folderPath")}>
            <button onClick={() => navigateFolder(null)}>
              {t("libraryRoot")}
            </button>
            {path.data?.map((f) => (
              <button key={f.id} onClick={() => navigateFolder(f.id)}>
                / {f.name}
              </button>
            ))}
          </nav>
          <div className="toolbar">
            <button
              onClick={() => {
                setEditingFolder(null);
                setFolderName("");
                setTarget(folder);
              }}
            >
              <FolderIcon size={16} />
              {t("newFolder")}
            </button>
            <label className="button primary">
              {" "}
              <Upload size={16} />
              {t("importDocuments")}
              <input
                className="file-input"
                aria-label={t("importDocuments")}
                type="file"
                multiple
                accept={Object.keys(fileTypes)
                  .map((e) => `.${e}`)
                  .join(",")}
                disabled={uploading || !config.data?.storageReady}
                onChange={(e) => {
                  if (e.target.files) void enqueue(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <span>{t("uploadLimit")}</span>
          </div>
          <div
            className={`drop-zone ${drag ? "dragging" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              void enqueue(e.dataTransfer.files);
            }}
          >
            {t("dropFiles")}
          </div>
          {transfers.length > 0 && (
            <section className="panel">
              <h2>{t("transfers")}</h2>
              {transfers.map((item) => (
                <div className="transfer" key={item.id}>
                  <span>
                    {item.file.name} · {sizeText(item.file.size)}
                  </span>
                  <progress max="100" value={item.progress} />
                  <span>
                    {t(
                      item.state === "done"
                        ? "success"
                        : item.state === "failed"
                          ? "transferFailed"
                          : item.state === "waiting"
                            ? "pending"
                            : "loading",
                    )}
                  </span>
                  {item.error && <span role="alert">{item.error}</span>}
                  {item.state === "failed" && (
                    <>
                      <button
                        disabled={uploading}
                        onClick={() => {
                          setUploading(true);
                          void send(
                            item,
                            item.document,
                            item.label,
                            item.change,
                          )
                            .then(refresh)
                            .finally(() => setUploading(false));
                        }}
                      >
                        {t("retry")}
                      </button>
                      {item.uploadId && (
                        <button
                          disabled={uploading}
                          onClick={() =>
                            void run(async () => {
                              await api(
                                `uploads/${item.uploadId}`,
                                undefined,
                                "DELETE",
                              );
                              setTransfers((old) =>
                                old.filter((i) => i.id !== item.id),
                              );
                            })
                          }
                        >
                          {t("cancel")}
                        </button>
                      )}
                    </>
                  )}
                </div>
              ))}
            </section>
          )}
          <div className="library-filters">
            <label>
              {t("search")}
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("documentSearch")}
              />
            </label>
            <label>
              {t("status")}
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">{t("allStatuses")}</option>
                {documentStatuses.map((s) => (
                  <option key={s} value={s}>
                    {t(s)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("fileType")}
              <select
                value={extension}
                onChange={(e) => setExtension(e.target.value)}
              >
                <option value="">{t("allTypes")}</option>
                {Object.keys(fileTypes).map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              {t("revision")}
              <input
                value={revision}
                maxLength={40}
                onChange={(e) => setRevision(e.target.value)}
              />
            </label>
            <label>
              {t("modifiedAfter")}
              <input
                type="date"
                value={after}
                onChange={(e) => setAfter(e.target.value)}
              />
            </label>
            <label>
              {t("sortBy")}
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                {["name", "date", "size", "type"].map((x) => (
                  <option key={x} value={x}>
                    {t(x === "type" ? "fileType" : x)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("order")}
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value)}
              >
                <option value="asc">↑</option>
                <option value="desc">↓</option>
              </select>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={allFolders}
                onChange={(e) => setAllFolders(e.target.checked)}
              />
              {t("allFolders")}
            </label>
          </div>
          {(docs.isPending || folders.isPending) && (
            <p role="status">{t("loading")}</p>
          )}
          {(docs.isError || folders.isError) && (
            <p role="alert">{t("error")}</p>
          )}
          {!allFolders && (
            <div className="toolbar">
              <span>
                {t("folder")} · {folderPage + 1}
              </span>
              <button
                disabled={folderPage === 0}
                onClick={() => setFolderPage(folderPage - 1)}
              >
                {t("previous")}
              </button>
              <button
                disabled={!folders.data?.hasMore}
                onClick={() => setFolderPage(folderPage + 1)}
              >
                {t("next")}
              </button>
            </div>
          )}
          <section className="panel table-wrap">
            <table>
              <thead>
                <tr>
                  {[
                    "name",
                    "fileType",
                    "revision",
                    "status",
                    "size",
                    "updated",
                    "actions",
                  ].map((k) => (
                    <th key={k}>{t(k)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!allFolders &&
                  folders.data?.items.map((f) => (
                    <tr key={f.id}>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => navigateFolder(f.id)}
                        >
                          <FolderIcon size={18} />
                          {f.name}
                        </button>
                      </td>
                      <td>{t("folder")}</td>
                      <td colSpan={4} />
                      <td>
                        <details>
                          <summary aria-label={t("actions")}>
                            <MoreHorizontal size={18} />
                          </summary>
                          <button
                            onClick={() => {
                              setEditingFolder(f);
                              setFolderName(f.name);
                              setTarget(f.parent_id);
                            }}
                          >
                            {t("renameMove")}
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => {
                              if (confirm(t("archiveFolderConfirm")))
                                void run(() =>
                                  api(`folders/${f.id}/archive`, {}),
                                );
                            }}
                          >
                            {t("archive")}
                          </button>
                        </details>
                      </td>
                    </tr>
                  ))}
                {docs.data?.items.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => {
                          setSelected(d.id);
                          setViewRevision("");
                        }}
                      >
                        <FileIcon extension={d.extension} />
                        <span>
                          <strong>{d.name}</strong>
                          <small>{d.number}</small>
                        </span>
                      </button>
                    </td>
                    <td>{d.extension.toUpperCase()}</td>
                    <td>{d.label}</td>
                    <td>
                      <span className="badge">{t(d.status)}</span>
                    </td>
                    <td>{sizeText(d.size)}</td>
                    <td>{new Date(d.updated_at).toLocaleDateString()}</td>
                    <td>
                      <details>
                        <summary aria-label={t("actions")}>
                          <MoreHorizontal size={18} />
                        </summary>
                        <button
                          onClick={() => {
                            setEditDoc(d);
                            setTarget(d.folder_id);
                          }}
                        >
                          {t("editMove")}
                        </button>
                        <a
                          href={`/api/v1/revisions/${d.revision_id}/content?download=1`}
                        >
                          {t("downloadOriginal")}
                        </a>
                        <button
                          disabled={busy}
                          onClick={() => {
                            if (confirm(t("archiveDocumentConfirm")))
                              void run(() =>
                                api(
                                  `documents/${d.id}`,
                                  { ...d, status: "archived" },
                                  "PATCH",
                                ),
                              );
                          }}
                        >
                          {t("archive")}
                        </button>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {docs.data &&
              !docs.data.items.length &&
              !folders.data?.items.length && <p>{t("empty")}</p>}
          </section>
          <div className="toolbar">
            <button
              disabled={page === 0 || docs.isFetching}
              onClick={() => setPage(page - 1)}
            >
              {t("previous")}
            </button>
            <span>
              {t("page")} {page + 1}
            </span>
            <button
              disabled={!docs.data?.hasMore || docs.isFetching}
              onClick={() => setPage(page + 1)}
            >
              {t("next")}
            </button>
          </div>
        </>
      )}
      {editingFolder !== undefined && (
        <div className="modal-backdrop">
          <section
            className="modal panel"
            role="dialog"
            aria-modal="true"
            aria-label={t("folder")}
          >
            <h2>{t(editingFolder ? "renameMove" : "newFolder")}</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api(
                    editingFolder
                      ? `folders/${editingFolder.id}`
                      : `projects/${project}/folders`,
                    { name: folderName, parent_id: target },
                    editingFolder ? "PATCH" : "POST",
                  );
                  setEditingFolder(undefined);
                });
              }}
            >
              <label>
                {t("name")}
                <input
                  required
                  maxLength={160}
                  value={folderName}
                  onChange={(e) => setFolderName(e.target.value)}
                />
              </label>
              <FolderPicker
                project={project}
                value={target}
                onChange={setTarget}
              />
              <div className="actions">
                <button disabled={busy}>{t("save")}</button>
                <button
                  type="button"
                  onClick={() => setEditingFolder(undefined)}
                >
                  {t("cancel")}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {editDoc && (
        <div className="modal-backdrop">
          <section
            className="modal panel"
            role="dialog"
            aria-modal="true"
            aria-label={t("edit")}
          >
            <h2>{t("editMove")}</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const values = Object.fromEntries(
                  new FormData(e.currentTarget),
                );
                void run(async () => {
                  await api(
                    `documents/${editDoc.id}`,
                    { ...values, folder_id: target },
                    "PATCH",
                  );
                  setEditDoc(null);
                });
              }}
            >
              <div className="form-grid">
                <label>
                  {t("name")}
                  <input
                    name="name"
                    defaultValue={editDoc.name}
                    required
                    maxLength={200}
                  />
                </label>
                <label>
                  {t("documentNumber")}
                  <input
                    name="number"
                    defaultValue={editDoc.number}
                    maxLength={80}
                  />
                </label>
                <label>
                  {t("description")}
                  <textarea
                    name="description"
                    defaultValue={editDoc.description}
                    maxLength={4000}
                  />
                </label>
                <label>
                  {t("status")}
                  <select name="status" defaultValue={editDoc.status}>
                    {documentStatuses.map((s) => (
                      <option key={s} value={s}>
                        {t(s)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <FolderPicker
                project={project}
                value={target}
                onChange={setTarget}
              />
              <div className="actions">
                <button disabled={busy}>{t("save")}</button>
                <button type="button" onClick={() => setEditDoc(null)}>
                  {t("cancel")}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {selected && (
        <div className="modal-backdrop">
          <section
            className="modal document-modal panel"
            role="dialog"
            aria-modal="true"
            aria-label={t("documentDetails")}
          >
            <div className="toolbar">
              <button
                onClick={() => {
                  setSelected(null);
                  setViewRevision("");
                }}
              >
                {t("backLibrary")}
              </button>
              <h2>{detail.data?.document.name}</h2>
              {detail.data && (
                <button
                  onClick={() => {
                    setEditDoc(detail.data.document);
                    setTarget(detail.data.document.folder_id);
                    setSelected(null);
                  }}
                >
                  {t("editMove")}
                </button>
              )}
            </div>
            {detail.isPending && <p>{t("loading")}</p>}
            {detail.isError && <p role="alert">{t("error")}</p>}
            {detail.data && (
              <>
                <p>
                  {detail.data.document.number} ·{" "}
                  {t(detail.data.document.status)} ·{" "}
                  {detail.data.document.description}
                </p>
                <label>
                  {t("revisionHistory")}
                  <select
                    value={current?.id ?? ""}
                    onChange={(e) => setViewRevision(e.target.value)}
                  >
                    {current &&
                      !detail.data.revisions.some(
                        (r) => r.id === current.id,
                      ) && (
                        <option value={current.id}>
                          {current.label} · {current.filename}
                        </option>
                      )}
                    {detail.data.revisions.map((r, i) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                        {i === 0 && revisionPage === 0
                          ? ` — ${t("currentRevision")}`
                          : ""}{" "}
                        · {r.filename} · {sizeText(r.size)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="toolbar">
                  <button
                    disabled={revisionPage === 0}
                    onClick={() => setRevisionPage(revisionPage - 1)}
                  >
                    {t("previous")}
                  </button>
                  <span>
                    {t("revisionHistory")} · {revisionPage + 1}
                  </span>
                  <button
                    disabled={!detail.data.hasMoreRevisions}
                    onClick={() => setRevisionPage(revisionPage + 1)}
                  >
                    {t("next")}
                  </button>
                </div>
                {linkedUnavailable && (
                  <p role="alert">{t("referenceUnavailable")}</p>
                )}
                {current && (
                  <>
                    <p>{current.change_description}</p>
                    <DocumentViewer
                      revision={current}
                      target={reviewTarget}
                      onReviewNavigate={(target) => {
                        setViewRevision(target.revision_id);
                        setReviewTarget(target);
                      }}
                    />
                    {current.extension === "pdf" &&
                      detail.data.document.status !== "archived" && (
                        <PageReplacement
                          key={current.id}
                          revision={current}
                          busy={uploading}
                          onSave={async (file, label, description) => {
                            const success = await enqueue(
                              [file],
                              detail.data!.document,
                              { label, change: description },
                            );
                            if (success) {
                              setViewRevision("");
                              setReviewTarget(null);
                            }
                            return !!success;
                          }}
                        />
                      )}
                  </>
                )}
                <section className="revision-upload">
                  <h3>{t("newRevision")}</h3>
                  <label>
                    {t("revision")}
                    <input
                      value={revLabel}
                      maxLength={40}
                      onChange={(e) => setRevLabel(e.target.value)}
                    />
                  </label>
                  <label>
                    {t("changeDescription")}
                    <textarea
                      value={changes}
                      maxLength={4000}
                      onChange={(e) => setChanges(e.target.value)}
                    />
                  </label>
                  <input
                    aria-label={t("newRevision")}
                    type="file"
                    accept={Object.keys(fileTypes)
                      .map((e) => `.${e}`)
                      .join(",")}
                    disabled={
                      uploading ||
                      !revLabel.trim() ||
                      !config.data?.storageReady ||
                      detail.data.document.status === "archived"
                    }
                    onChange={(e) => {
                      if (e.target.files)
                        void enqueue(e.target.files, detail.data!.document);
                      e.target.value = "";
                    }}
                  />
                </section>
                <h3>{t("statusHistory")}</h3>
                <div className="toolbar">
                  <button
                    disabled={historyPage === 0}
                    onClick={() => setHistoryPage(historyPage - 1)}
                  >
                    {t("previous")}
                  </button>
                  <span>{historyPage + 1}</span>
                  <button
                    disabled={!detail.data.hasMoreHistory}
                    onClick={() => setHistoryPage(historyPage + 1)}
                  >
                    {t("next")}
                  </button>
                </div>
                {detail.data.history.length ? (
                  detail.data.history.map((h) => (
                    <p key={h.id}>
                      {h.from_status ? t(h.from_status) : "—"} →{" "}
                      {t(h.to_status)} ·{" "}
                      {new Date(h.created_at).toLocaleString()}
                    </p>
                  ))
                ) : (
                  <p>{t("empty")}</p>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
