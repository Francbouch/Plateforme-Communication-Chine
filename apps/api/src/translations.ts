import { Hono } from "hono";
import { z } from "zod";
import { Store } from "./database";
import { HttpError, type Bindings, type Principal } from "./types";
import {
  translationRequest,
  glossaryFields,
  type TranslationSource,
  type GlossaryEntry,
  type TranslationResult,
} from "../../../packages/shared/src/translations";
import {
  DeepLFreeProvider,
  type TranslationProvider,
} from "./translation/provider";
import { protect, verifyTechnical } from "./translation/protection";
type Vars = { store: Store; principal: Principal; requestId: string };
const time = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const v = schema.safeParse(input);
  if (!v.success) throw new HttpError(400, "translation_invalid");
  return v.data;
}
async function hash(text: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
/** Resolve canonical server text and recheck its original access on every cache/correction request. */
export async function sourceText(s: Store, ref: TranslationSource) {
  let row: {
    text: string;
    project_id: string;
    private_author?: string | null;
    requester_id?: string;
    status?: string;
  } | null = null;
  if (ref.kind === "message" && ref.field === "body")
    row = await s
      .statement(
        "SELECT m.body AS text,c.project_id,CASE WHEN m.shared=0 THEN m.author_id END AS private_author FROM conversation_messages m JOIN project_conversations c ON c.id=m.conversation_id WHERE m.id=? AND m.deleted_at IS NULL",
        ref.id,
      )
      .first();
  if (ref.kind === "review_item" && ["title", "summary"].includes(ref.field))
    row = await s
      .statement(
        `SELECT i.${ref.field} AS text,d.project_id FROM review_items i JOIN documents d ON d.id=i.document_id WHERE i.id=? AND i.is_point=1 AND i.point_deleted_at IS NULL`,
        ref.id,
      )
      .first();
  if (ref.kind === "review_message" && ref.field === "body")
    row = await s
      .statement(
        "SELECT m.body AS text,d.project_id FROM review_messages m JOIN review_items i ON i.id=m.item_id JOIN documents d ON d.id=i.document_id WHERE m.id=? AND i.point_deleted_at IS NULL",
        ref.id,
      )
      .first();
  if (ref.kind === "request" && ["title", "description"].includes(ref.field))
    row = await s
      .statement(
        `SELECT t.${ref.field} AS text,t.project_id,CASE WHEN m.shared=0 THEN m.author_id END AS private_author FROM technical_requests t JOIN conversation_messages m ON m.id=t.message_id WHERE t.id=? AND m.deleted_at IS NULL`,
        ref.id,
      )
      .first();
  if (
    ref.kind === "approval" &&
    ["title", "description", "decision_comment"].includes(ref.field)
  )
    row = await s
      .statement(
        `SELECT a.${ref.field} AS text,a.project_id,a.requester_id,a.status FROM approval_requests a WHERE a.id=? AND a.deleted_at IS NULL`,
        ref.id,
      )
      .first();
  if (ref.kind === "approval_event" && ref.field === "comment")
    row = await s
      .statement(
        "SELECT json_extract(e.payload,'$.comment') AS text,a.project_id,a.requester_id,a.status FROM approval_events e JOIN approval_requests a ON a.id=e.approval_id WHERE e.id=? AND a.deleted_at IS NULL",
        ref.id,
      )
      .first();
  if (!row) throw new HttpError(404, "translation_source_unavailable");
  const p = await s.requireProject(row.project_id, true);
  if (
    (row.private_author && row.private_author !== s.userId) ||
    (row.status === "draft" && row.requester_id !== s.userId)
  )
    throw new HttpError(403, "translation_source_unavailable");
  if (
    typeof row.text !== "string" ||
    !row.text.trim() ||
    row.text.length > 8000
  )
    throw new HttpError(400, "translation_source_length");
  return { text: row.text, organization_id: p.organization_id };
}
type Stored = {
  id: string;
  original: string;
  machine: string;
  warnings: string;
  source_kind: TranslationSource["kind"];
  source_id: string;
  source_field: TranslationSource["field"];
  source_hash: string;
  organization_id: string;
} & Omit<TranslationResult, "warnings" | "cached">;
async function result(
  s: Store,
  t: Stored,
  cached: boolean,
): Promise<TranslationResult> {
  const c = await s
    .statement(
      "SELECT c.body,c.version,c.created_at,p.name,c.warnings FROM translation_corrections c JOIN profiles p ON p.id=c.actor_id WHERE c.translation_id=? ORDER BY c.version DESC LIMIT 1",
      t.id,
    )
    .first<{
      body: string;
      version: number;
      created_at: string;
      name: string;
      warnings: string;
    }>();
  return {
    id: t.id,
    original: t.original,
    machine: t.machine,
    corrected: c?.body ?? null,
    correction_version: c?.version ?? 0,
    corrected_at: c?.created_at ?? null,
    corrector: c?.name ?? null,
    target_language: t.target_language,
    source_language: t.source_language,
    detected_language: t.detected_language,
    provider: t.provider,
    warnings: JSON.parse(c?.warnings ?? t.warnings),
    created_at: t.created_at,
    cached,
  };
}
function limit(value: string | undefined, fallback: number, max: number) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}
export function translationRoutes(
  providerFactory: (env: Bindings) => TranslationProvider = (env) =>
    new DeepLFreeProvider(env.DEEPL_API_KEY!),
) {
  const app = new Hono<{ Bindings: Bindings; Variables: Vars }>();
  app.get("/translations/config", (c) =>
    c.json({
      enabled: c.env.TRANSLATION_ENABLED === "true" && !!c.env.DEEPL_API_KEY,
      provider: "deepl-api-free",
      languages: ["fr", "en", "zh-CN"],
    }),
  );
  app.post("/translations", async (c) => {
    const v = parse(translationRequest, await c.req.json().catch(() => null)),
      s = c.get("store"),
      src = await sourceText(s, v);
    if (v.source_language === v.target_language)
      throw new HttpError(400, "translation_same_language");
    const glossary = await s.all<GlossaryEntry>(
      `SELECT id,fr,en,zh_cn AS 'zh-CN',definition,domain,notes,version FROM translation_glossary WHERE organization_id=? AND project_id IS NULL AND deleted_at IS NULL AND (instr(?,fr_fold)>0 OR instr(?,en_fold)>0 OR instr(?,zh_cn_fold)>0) ORDER BY id LIMIT 31`,
      src.organization_id,
      src.text.toLowerCase(),
      src.text.toLowerCase(),
      src.text.toLowerCase(),
    );
    if (glossary.length > 30)
      throw new HttpError(400, "translation_too_many_terms");
    const glossaryHash = await hash(
        JSON.stringify(
          glossary.map((g) => [g.id, g.version, g.fr, g.en, g["zh-CN"]]),
        ),
      ),
      sourceHash = await hash(src.text);
    const provider = providerFactory(c.env);
    const providerVersion = provider.version,
      instructions = "technical-preservation-v1";
    const key = await hash(
      JSON.stringify([
        src.organization_id,
        v.kind,
        v.id,
        v.field,
        sourceHash,
        v.source_language,
        v.target_language,
        providerVersion,
        glossaryHash,
        instructions,
      ]),
    );
    if (!v.force) {
      const cached = await s
        .statement(
          "SELECT * FROM translations WHERE organization_id=? AND cache_key=? ORDER BY sequence DESC LIMIT 1",
          src.organization_id,
          key,
        )
        .first<Stored>();
      if (cached) return c.json(await result(s, cached, true));
    }
    if (c.env.TRANSLATION_ENABLED !== "true" || !c.env.DEEPL_API_KEY)
      throw new HttpError(503, "translation_not_configured");
    const attempt = crypto.randomUUID();
    const locked = await s
      .statement(
        "INSERT INTO translation_locks(cache_key,token,expires) VALUES(?,?,unixepoch()+45) ON CONFLICT(cache_key) DO UPDATE SET token=excluded.token,expires=excluded.expires WHERE translation_locks.expires<unixepoch()",
        key,
        attempt,
      )
      .run();
    if (!locked.meta.changes)
      throw new HttpError(409, "translation_in_progress");
    try {
      // Another request may have completed between the first cache read and lock acquisition.
      if (!v.force) {
        const cached = await s
          .statement(
            "SELECT * FROM translations WHERE organization_id=? AND cache_key=? ORDER BY sequence DESC LIMIT 1",
            src.organization_id,
            key,
          )
          .first<Stored>();
        if (cached) return c.json(await result(s, cached, true));
      }
      const protectedText = protect(
        src.text,
        glossary,
        v.source_language,
        v.target_language,
        crypto.randomUUID().replaceAll("-", "").slice(0, 8),
      );
      const chargedCharacters = protectedText.text.length;
      const reserve = await s
        .statement(
          `INSERT INTO translation_attempts(id,organization_id,actor_id,characters) SELECT ?,?,?,? WHERE (SELECT count(*) FROM translation_attempts WHERE organization_id=? AND created>=unixepoch('now','start of day'))<? AND (SELECT COALESCE(sum(characters),0) FROM translation_attempts WHERE organization_id=? AND created>=unixepoch('now','start of day'))+?<=? AND (SELECT count(*) FROM translation_attempts WHERE actor_id=? AND created>unixepoch()-60)<?`,
          attempt,
          src.organization_id,
          s.userId,
          chargedCharacters,
          src.organization_id,
          limit(c.env.TRANSLATION_DAILY_REQUESTS, 100, 1000),
          src.organization_id,
          chargedCharacters,
          limit(c.env.TRANSLATION_DAILY_CHARACTERS, 10000, 500000),
          s.userId,
          limit(c.env.TRANSLATION_PER_MINUTE, 5, 30),
        )
        .run();
      if (!reserve.meta.changes)
        throw new HttpError(429, "translation_local_quota");
      const translated = await provider.translate(
        protectedText.text,
        protectedText.tokens.map((t) => t.token),
        v.source_language,
        v.target_language,
      );
      const restored = protectedText.restore(translated.text);
      if (restored.text.length > 16000)
        throw new HttpError(502, "translation_provider_invalid");
      // Do not publish a result for a source that changed during the provider call.
      const current = await sourceText(s, v);
      if (current.text !== src.text)
        throw new HttpError(409, "translation_source_changed");
      const id = crypto.randomUUID();
      await s.write(
        [
          s.statement(
            "INSERT INTO translations(id,organization_id,source_kind,source_id,source_field,source_hash,original,source_language,target_language,detected_language,provider,instructions_version,glossary_hash,cache_key,machine,warnings,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            id,
            src.organization_id,
            v.kind,
            v.id,
            v.field,
            sourceHash,
            src.text,
            v.source_language,
            v.target_language,
            translated.detected,
            providerVersion,
            instructions,
            glossaryHash,
            key,
            restored.text,
            JSON.stringify(restored.warnings),
            s.userId,
          ),
        ],
        src.organization_id,
        "translation.generated",
        id,
      );
      return c.json(
        await result(
          s,
          (await s
            .statement("SELECT * FROM translations WHERE id=?", id)
            .first<Stored>())!,
          false,
        ),
        201,
      );
    } finally {
      await s
        .statement(
          "DELETE FROM translation_locks WHERE cache_key=? AND token=?",
          key,
          attempt,
        )
        .run();
    }
  });
  app.patch("/translations/:id", async (c) => {
    const s = c.get("store"),
      id = parse(z.uuid(), c.req.param("id"));
    const v = parse(
      z.object({
        body: z.string().trim().min(1).max(16000),
        version: z.number().int().min(0),
      }),
      await c.req.json().catch(() => null),
    );
    const t = await s
      .statement("SELECT * FROM translations WHERE id=?", id)
      .first<Stored>();
    if (!t) throw new HttpError(404, "translation_source_unavailable");
    const src = await sourceText(s, {
      kind: t.source_kind,
      id: t.source_id,
      field: t.source_field,
    });
    if ((await hash(src.text)) !== t.source_hash)
      throw new HttpError(409, "translation_source_changed");
    const warnings = verifyTechnical(t.original, v.body).length
      ? ["technical_values_changed"]
      : [];
    await s.write(
      [
        s.statement(
          `INSERT INTO translation_corrections(id,translation_id,version,body,warnings,actor_id) SELECT ?,?,?,?,?,? WHERE COALESCE((SELECT MAX(version) FROM translation_corrections WHERE translation_id=?),0)=?`,
          crypto.randomUUID(),
          id,
          v.version + 1,
          v.body,
          JSON.stringify(warnings),
          s.userId,
          id,
          v.version,
        ),
      ],
      src.organization_id,
      "translation.corrected",
      id,
      true,
    );
    return c.json(await result(s, t, true));
  });
  app.get("/organizations/:org/glossary", async (c) => {
    const s = c.get("store"),
      org = parse(z.uuid(), c.req.param("org"));
    await s.requireOrg(org);
    const q = (c.req.query("q") ?? "").slice(0, 160),
      domain = (c.req.query("domain") ?? "").slice(0, 100),
      page = parse(
        z.coerce.number().int().min(0).max(10000),
        c.req.query("page") ?? 0,
      );
    const rows = await s.all<GlossaryEntry>(
      `SELECT id,fr,en,zh_cn AS 'zh-CN',definition,domain,notes,version FROM translation_glossary WHERE organization_id=? AND project_id IS NULL AND deleted_at IS NULL AND (?='' OR instr(search_fold,?)>0) AND (?='' OR domain=?) ORDER BY fr,id LIMIT 31 OFFSET ?`,
      org,
      q,
      q.toLowerCase(),
      domain,
      domain,
      page * 30,
    );
    return c.json({ items: rows.slice(0, 30), hasMore: rows.length > 30 });
  });
  app.post("/organizations/:org/glossary", async (c) => {
    const s = c.get("store"),
      org = parse(z.uuid(), c.req.param("org"));
    await s.requireOrg(org, true);
    const v = parse(glossaryFields, await c.req.json().catch(() => null)),
      id = crypto.randomUUID();
    await s.write(
      [
        s.statement(
          "INSERT INTO translation_glossary(id,organization_id,fr,en,zh_cn,definition,domain,notes,fr_fold,en_fold,zh_cn_fold,search_fold,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
          id,
          org,
          v.fr,
          v.en,
          v["zh-CN"],
          v.definition,
          v.domain,
          v.notes,
          v.fr.toLowerCase(),
          v.en.toLowerCase(),
          v["zh-CN"].toLowerCase(),
          [v.fr, v.en, v["zh-CN"], v.definition].join(" ").toLowerCase(),
          s.userId,
        ),
      ],
      org,
      "glossary.created",
      id,
    );
    return c.json({ id }, 201);
  });
  for (const method of ["patch", "delete"] as const)
    app[method]("/organizations/:org/glossary/:id", async (c) => {
      const s = c.get("store"),
        org = parse(z.uuid(), c.req.param("org")),
        id = parse(z.uuid(), c.req.param("id"));
      await s.requireOrg(org, true);
      const input = await c.req.json().catch(() => null),
        v = parse(
          method === "patch"
            ? glossaryFields.extend({ version: z.number().int().positive() })
            : z.object({ version: z.number().int().positive() }),
          input,
        );
      const fields = method === "patch" ? parse(glossaryFields, input) : null;
      const statement = fields
        ? s.statement(
            `UPDATE translation_glossary SET fr=?,en=?,zh_cn=?,definition=?,domain=?,notes=?,fr_fold=?,en_fold=?,zh_cn_fold=?,search_fold=?,version=version+1,updated_by=?,updated_at=${time} WHERE id=? AND organization_id=? AND version=? AND deleted_at IS NULL`,
            fields.fr,
            fields.en,
            fields["zh-CN"],
            fields.definition,
            fields.domain,
            fields.notes,
            fields.fr.toLowerCase(),
            fields.en.toLowerCase(),
            fields["zh-CN"].toLowerCase(),
            [fields.fr, fields.en, fields["zh-CN"], fields.definition]
              .join(" ")
              .toLowerCase(),
            s.userId,
            id,
            org,
            v.version,
          )
        : s.statement(
            `UPDATE translation_glossary SET deleted_at=${time},version=version+1,updated_by=?,updated_at=${time} WHERE id=? AND organization_id=? AND version=? AND deleted_at IS NULL`,
            s.userId,
            id,
            org,
            v.version,
          );
      await s.write(
        [statement],
        org,
        fields ? "glossary.updated" : "glossary.deleted",
        id,
        true,
      );
      return c.json({ ok: true });
    });
  return app;
}
