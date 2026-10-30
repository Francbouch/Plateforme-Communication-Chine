import { useState, useRef, useEffect, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../client";
import { fileTypes } from "../../../../packages/shared/src/documents";
import type { MessageReference } from "../../../../packages/shared/src/messages";
import { ReferencePicker } from "./ReferencePicker";
type Transfer = { id: string; file: File; progress: number; ready: boolean };
export function MessageComposer({
  project,
  conversation,
  parent,
  onSent,
}: {
  project: string;
  conversation: string;
  parent?: string;
  onSent: () => void;
}) {
  const { t } = useTranslation(),
    [body, setBody] = useState(""),
    [shared, setShared] = useState(false),
    [refs, setRefs] = useState<MessageReference[]>([]),
    [picker, setPicker] = useState(false),
    [files, setFiles] = useState<Transfer[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const client = useQueryClient();
  const draft = useRef(crypto.randomUUID());
  useEffect(() => {
    if (!busy && !body && !files.length) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy, body, files.length]);
  function transfer(item: Transfer) {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/v1/message-attachments/${item.id}/content`);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable)
          setFiles((old) =>
            old.map((f) =>
              f.id === item.id
                ? { ...f, progress: Math.round((e.loaded / e.total) * 100) }
                : f,
            ),
          );
      };
      xhr.onerror = () => reject(new Error(t("attachmentFailed")));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else {
          let text = t("attachmentFailed");
          try {
            text = JSON.parse(xhr.responseText).error ?? text;
          } catch {
            /* Access may return HTML. */
          }
          reject(new Error(text));
        }
      };
      xhr.send(item.file);
    });
  }
  async function upload(file: File) {
    setBusy(true);
    setError("");
    try {
      if (
        file.size < 1 ||
        file.size > 10485760 ||
        !Object.hasOwn(fileTypes, file.name.split(".").pop()!.toLowerCase())
      )
        throw new Error(t("attachmentLimit"));
      const sha256 = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
        ),
        (v) => v.toString(16).padStart(2, "0"),
      ).join("");
      const reserved = await api<{ id: string }>(
        `conversations/${conversation}/attachments`,
        { filename: file.name, size: file.size, sha256 },
      );
      const item = { id: reserved.id, file, progress: 0, ready: false };
      setFiles((old) => [...old, item]);
      await transfer(item);
      setFiles((old) =>
        old.map((f) =>
          f.id === item.id ? { ...f, ready: true, progress: 100 } : f,
        ),
      );
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status === 409 &&
        e.message.startsWith("File already exists in project library")
      ) {
        setError(t("fileAlreadyInLibrary"));
        setPicker(true);
      } else setError(e instanceof Error ? e.message : t("error"));
    } finally {
      setBusy(false);
      void client.invalidateQueries({ queryKey: ["message-uploads", project] });
    }
  }
  async function retry(item: Transfer) {
    setBusy(true);
    setError("");
    try {
      await transfer(item);
      setFiles((old) =>
        old.map((f) => (f.id === item.id ? { ...f, ready: true } : f)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : t("error"));
    } finally {
      setBusy(false);
      void client.invalidateQueries({ queryKey: ["message-uploads", project] });
    }
  }
  async function remove(item: Transfer) {
    setBusy(true);
    try {
      await api(`message-attachments/${item.id}`, undefined, "DELETE");
      setFiles((old) => old.filter((f) => f.id !== item.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("error"));
    } finally {
      setBusy(false);
      void client.invalidateQueries({ queryKey: ["message-uploads", project] });
    }
  }
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || files.some((f) => !f.ready)) return;
    setBusy(true);
    setError("");
    try {
      await api(`conversations/${conversation}/messages`, {
        id: draft.current,
        body,
        shared,
        parent_id: parent ?? null,
        references: refs.map(
          ({ document_id, revision_id, point_id, page }) => ({
            document_id,
            revision_id,
            point_id,
            page,
          }),
        ),
        attachments: files.map((f) => f.id),
      });
      draft.current = crypto.randomUUID();
      setBody("");
      setRefs([]);
      setFiles([]);
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("error"));
    } finally {
      setBusy(false);
      void client.invalidateQueries({ queryKey: ["message-uploads", project] });
    }
  }
  return (
    <form
      className="message-composer"
      onSubmit={(e) => void send(e)}
      onKeyDown={(e) => {
        if (
          e.key === "Enter" &&
          !e.shiftKey &&
          !e.nativeEvent.isComposing &&
          e.target instanceof HTMLTextAreaElement
        ) {
          e.preventDefault();
          e.currentTarget.requestSubmit();
        }
      }}
    >
      <label>
        {t(parent ? "writeReply" : "writeMessage")}
        <textarea
          value={body}
          maxLength={8000}
          rows={3}
          disabled={busy}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t("messageHint")}
        />
      </label>
      <div className="message-references">
        {refs.map((r, i) => (
          <span key={i} className="reference-chip">
            {r.label}
            <button
              type="button"
              disabled={busy}
              aria-label={t("removeReference")}
              onClick={() => setRefs((old) => old.filter((_, n) => n !== i))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      {files.map((f) => (
        <div className="message-transfer" key={f.id}>
          <span>{f.file.name}</span>
          <progress value={f.progress} max={100} />
          <span>{f.ready ? t("attachmentReady") : t("attachmentPending")}</span>
          {!f.ready && (
            <button type="button" disabled={busy} onClick={() => void retry(f)}>
              {t("retry")}
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void remove(f)}>
            {t("remove")}
          </button>
        </div>
      ))}
      <div className="toolbar">
        <button
          type="button"
          disabled={busy || refs.length >= 8}
          onClick={() => setPicker(true)}
        >
          {t("insertReference")}
        </button>
        <label className="button attachment-button">
          {t("attachFile")}
          <input
            type="file"
            aria-label={t("attachFile")}
            disabled={busy || files.length >= 5}
            accept={Object.keys(fileTypes)
              .map((x) => `.${x}`)
              .join(",")}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = "";
            }}
          />
        </label>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={shared}
            disabled={busy}
            onChange={(e) => setShared(e.target.checked)}
          />
          {t("shareMessage")}
        </label>
        <button
          className="primary"
          disabled={
            busy ||
            (!body.trim() && !refs.length && !files.length) ||
            files.some((f) => !f.ready)
          }
        >
          {t(busy ? "sendingMessage" : "sendMessage")}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {picker && (
        <ReferencePicker
          project={project}
          onAdd={(r) => setRefs((old) => [...old, r])}
          onClose={() => setPicker(false)}
        />
      )}
    </form>
  );
}
