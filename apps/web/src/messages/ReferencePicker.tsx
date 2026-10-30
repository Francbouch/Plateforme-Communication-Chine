import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../client";
import type {
  DocumentRow,
  DocumentDetail,
  Page,
  Revision,
} from "../../../../packages/shared/src/documents";
import type { ReviewItem } from "../../../../packages/shared/src/review";
import type { MessageReference } from "../../../../packages/shared/src/messages";
export function ReferencePicker({
  project,
  onAdd,
  onClose,
  initialDocument = "",
  initialRevision = "",
}: {
  project: string;
  initialDocument?: string;
  initialRevision?: string;
  onAdd: (r: MessageReference) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [document, setDocument] = useState(initialDocument),
    [revision, setRevision] = useState(initialRevision),
    [revPage, setRevPage] = useState(0),
    [point, setPoint] = useState(""),
    [pointPage, setPointPage] = useState(0),
    [page, setPage] = useState("");
  const docs = useQuery({
    queryKey: ["reference-docs", project, query, offset],
    queryFn: () =>
      api<Page<DocumentRow>>(
        `projects/${project}/documents?folder_id=all&q=${encodeURIComponent(query)}&page=${offset}`,
      ),
  });
  const detail = useQuery({
    queryKey: ["reference-revisions", document, revPage],
    queryFn: () =>
      api<DocumentDetail>(`documents/${document}?revision_page=${revPage}`),
    enabled: !!document,
  });
  const points = useQuery({
    queryKey: ["reference-points", revision, pointPage],
    queryFn: () =>
      api<{ items: ReviewItem[]; hasMore: boolean }>(
        `documents/${document}/review-items?revision_id=${revision}&page=${pointPage}`,
      ),
    enabled: !!revision,
  });
  const selected: Revision | undefined = detail.data?.revisions.find(
    (r) => r.id === revision,
  );
  const chosen = points.data?.items.find((p) => p.id === point);
  return (
    <section
      className="panel reference-picker"
      aria-label={t("insertReference")}
    >
      <h3>{t("insertReference")}</h3>
      <label>
        {t("search")}
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOffset(0);
          }}
        />
      </label>
      <label>
        {t("document")}
        <select
          value={document}
          onChange={(e) => {
            setDocument(e.target.value);
            setRevision("");
            setRevPage(0);
            setPoint("");
            setPage("");
          }}
        >
          <option value="">{t("projectReference")}</option>
          {docs.data?.items.map((d) => (
            <option key={d.id} value={d.id}>
              {d.number} · {d.name}
            </option>
          ))}
        </select>
      </label>
      <div className="toolbar">
        <button
          type="button"
          disabled={!offset}
          onClick={() => setOffset(offset - 1)}
        >
          {t("previous")}
        </button>
        <button
          type="button"
          disabled={!docs.data?.hasMore}
          onClick={() => setOffset(offset + 1)}
        >
          {t("next")}
        </button>
      </div>
      {document && (
        <>
          <label>
            {t("revision")}
            <select
              value={revision}
              onChange={(e) => {
                setRevision(e.target.value);
                setPoint("");
                setPointPage(0);
                setPage("");
              }}
            >
              <option value="">{t("documentOnly")}</option>
              {detail.data?.revisions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label} · {r.filename}
                </option>
              ))}
            </select>
          </label>
          <div className="toolbar">
            <button
              type="button"
              disabled={!revPage}
              onClick={() => {
                setRevPage(revPage - 1);
                setRevision("");
              }}
            >
              {t("previous")}
            </button>
            <button
              type="button"
              disabled={!detail.data?.hasMoreRevisions}
              onClick={() => {
                setRevPage(revPage + 1);
                setRevision("");
              }}
            >
              {t("next")}
            </button>
          </div>
        </>
      )}
      {selected?.extension === "pdf" && (
        <>
          <label>
            {t("technicalPoint")}
            <select
              value={point}
              onChange={(e) => {
                setPoint(e.target.value);
                const p = points.data?.items.find(
                  (p) => p.id === e.target.value,
                );
                setPage(p ? String(p.page) : "");
              }}
            >
              <option value="">—</option>
              {points.data?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  #{p.number} · {p.title}
                </option>
              ))}
            </select>
          </label>
          <div className="toolbar">
            <button
              type="button"
              disabled={!pointPage}
              onClick={() => {
                setPointPage(pointPage - 1);
                setPoint("");
              }}
            >
              {t("previous")}
            </button>
            <button
              type="button"
              disabled={!points.data?.hasMore}
              onClick={() => {
                setPointPage(pointPage + 1);
                setPoint("");
              }}
            >
              {t("next")}
            </button>
          </div>
          <label>
            {t("page")}
            <input
              type="number"
              min="1"
              max="10000"
              value={page}
              disabled={!!point}
              onChange={(e) => setPage(e.target.value)}
            />
          </label>
        </>
      )}
      {(docs.isError ||
        detail.isError ||
        (selected?.extension === "pdf" && points.isError)) && (
        <p role="alert">{t("error")}</p>
      )}
      <div className="actions">
        <button
          type="button"
          onClick={() => {
            onAdd({
              document_id: document || null,
              revision_id: revision || null,
              point_id: point || null,
              page: page ? Number(page) : null,
              label: [
                detail.data?.document.number ||
                  detail.data?.document.name ||
                  t("projectReference"),
                selected?.label,
                page ? `p. ${page}` : "",
                chosen ? `#${chosen.number}` : "",
              ]
                .filter(Boolean)
                .join(" · "),
            });
            onClose();
          }}
          disabled={
            (!!document && !detail.data) ||
            (!!revision && !selected) ||
            (!!page &&
              (!Number.isInteger(Number(page)) ||
                Number(page) < 1 ||
                Number(page) > 10000))
          }
        >
          {t("addReference")}
        </button>
        <button type="button" onClick={onClose}>
          {t("cancel")}
        </button>
      </div>
    </section>
  );
}
