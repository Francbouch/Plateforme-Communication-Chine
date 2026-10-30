import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../client";
import { isDemo } from "../demo";
import type {
  GlossaryEntry,
  GlossaryFields,
} from "../../../../packages/shared/src/translations";
const blank: GlossaryFields = {
  fr: "",
  en: "",
  "zh-CN": "",
  definition: "",
  domain: "",
  notes: "",
};
export function Glossary({ org }: { org: string }) {
  const { t } = useTranslation(),
    [q, setQ] = useState(""),
    [domain, setDomain] = useState(""),
    [page, setPage] = useState(0),
    [editing, setEditing] = useState<GlossaryEntry | null>(null),
    [form, setForm] = useState<GlossaryFields>({ ...blank }),
    [show, setShow] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const list = useQuery({
    queryKey: ["glossary", org, q, domain, page],
    queryFn: () =>
      api<{ items: GlossaryEntry[]; hasMore: boolean }>(
        `organizations/${org}/glossary?${new URLSearchParams({ q, domain, page: String(page) })}`,
      ),
    enabled: !!org && !isDemo,
  });
  async function save(remove = false) {
    setBusy(true);
    setError("");
    try {
      await api(
        `organizations/${org}/glossary${editing ? `/${editing.id}` : ""}`,
        remove
          ? { version: editing!.version }
          : { ...form, ...(editing ? { version: editing.version } : {}) },
        remove ? "DELETE" : editing ? "PATCH" : "POST",
      );
      setShow(false);
      setEditing(null);
      setForm({ ...blank });
      await list.refetch();
    } catch {
      setError(t("translation_glossary_error"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel translation-glossary"
      aria-label={t("translation_glossary")}
    >
      <h2>{t("translation_glossary")}</h2>
      <p>{t("translation_glossary_notice")}</p>
      {isDemo ? (
        <p>{t("realLibraryOnly")}</p>
      ) : (
        <>
          <div className="toolbar">
            <label>
              {t("search")}
              <input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(0);
                }}
              />
            </label>
            <label>
              {t("translation_domain_filter")}
              <input
                value={domain}
                onChange={(e) => {
                  setDomain(e.target.value);
                  setPage(0);
                }}
              />
            </label>
            <button
              onClick={() => {
                setEditing(null);
                setForm({ ...blank });
                setShow(true);
              }}
            >
              {t("translation_add_term")}
            </button>
          </div>
          {(list.isError || error) && (
            <p role="alert">{error || t("translation_glossary_error")}</p>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {["fr", "en", "zh-CN", "domain"].map((k) => (
                    <th key={k}>
                      {t(
                        k === "domain"
                          ? "translation_domain"
                          : `translation_lang_${k}`,
                      )}
                    </th>
                  ))}
                  <th>{t("edit")}</th>
                </tr>
              </thead>
              <tbody>
                {list.data?.items.map((e) => (
                  <tr key={e.id}>
                    <td>{e.fr}</td>
                    <td>{e.en}</td>
                    <td>{e["zh-CN"]}</td>
                    <td>{e.domain}</td>
                    <td>
                      <button
                        onClick={() => {
                          setEditing(e);
                          setForm({ ...e });
                          setShow(true);
                        }}
                      >
                        {t("edit")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.data?.items.length === 0 && <p>{t("empty")}</p>}
          <div className="toolbar">
            <button disabled={!page} onClick={() => setPage(page - 1)}>
              {t("previous")}
            </button>
            <button
              disabled={!list.data?.hasMore}
              onClick={() => setPage(page + 1)}
            >
              {t("next")}
            </button>
          </div>
          {show && (
            <form
              className="glossary-form"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              {(
                ["fr", "en", "zh-CN", "definition", "domain", "notes"] as const
              ).map((k) => (
                <label key={k}>
                  {t(
                    ["fr", "en", "zh-CN"].includes(k)
                      ? `translation_lang_${k}`
                      : `translation_${k}`,
                  )}
                  <input
                    required={["fr", "en", "zh-CN"].includes(k)}
                    maxLength={
                      k === "domain"
                        ? 100
                        : ["definition", "notes"].includes(k)
                          ? 1000
                          : 160
                    }
                    value={form[k]}
                    onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                  />
                </label>
              ))}
              <button disabled={busy}>{t("save")}</button>
              <button type="button" onClick={() => setShow(false)}>
                {t("cancel")}
              </button>
              {editing && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(t("translation_delete_term_confirm")))
                      void save(true);
                  }}
                >
                  {t("translation_delete_term")}
                </button>
              )}
            </form>
          )}
        </>
      )}
    </section>
  );
}
