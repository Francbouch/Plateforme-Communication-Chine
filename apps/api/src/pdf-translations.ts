import { Hono } from "hono";
import { z } from "zod";
import { revisionAccess } from "./access-control";
import { Store } from "./database";
import { HttpError, type Bindings, type Principal } from "./types";
import {
  pdfLookup,
  pdfSegment,
  segmentKey,
  pdfHash,
  detectNote,
  linguisticNote,
  extractionVersion,
  type PdfTranslationRow,
} from "../../../packages/shared/src/pdf-translation";
import { protect, verifyTechnical } from "./translation/protection";
import { relevantGlossary, glossaryFingerprint, limit } from "./translations";
import {
  DeepLFreeProvider,
  type TranslationProvider,
} from "./translation/provider";
type Vars = { store: Store; principal: Principal; requestId: string };
type Stored = {
  id: string;
  segment_id: string;
  machine: string;
  warnings: string;
  provider: string;
  audience: string;
  source_language: string;
  target_language: string;
  glossary_hash: string;
  cache_key: string;
  original: string;
  revision_id: string;
  reused_from?: string | null;
};
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const v = schema.safeParse(input);
  if (!v.success) throw new HttpError(400, "pdf_translation_invalid");
  return v.data;
}
async function access(
  s: Store,
  revision: string,
  permission: "translate" | "correct_translations" = "translate",
) {
  const r = await s
    .statement(
      "SELECT r.*,d.project_id FROM document_revisions r JOIN documents d ON d.id=r.document_id WHERE r.id=? AND r.extension='pdf'",
      revision,
    )
    .first<{
      id: string;
      sha256: string;
      project_id: string;
      document_id: string;
    }>();
  if (!r) throw new HttpError(404, "pdf_translation_unavailable");
  if (s.multiuser) {
    const a = (await revisionAccess(s, revision, permission)).access;
    return {
      r,
      org: a.organization_id,
      external: a.external,
      canVerify: !a.external && a.permissions.correct_translations,
      canPropose: a.permissions.correct_translations,
    };
  }
  const p = await s.requireProject(r.project_id);
  let canVerify = false;
  try {
    await s.requireProject(r.project_id, true);
    canVerify = true;
  } catch {
    /* readers cannot approve */
  }
  return {
    r,
    org: p.organization_id,
    external: false,
    canVerify,
    canPropose: canVerify,
  };
}
async function result(s: Store, t: Stored): Promise<PdfTranslationRow> {
  const state = await s
    .statement(
      `SELECT
    (SELECT json_object('body',c.body,'version',c.version) FROM pdf_translation_corrections c LEFT JOIN pdf_translation_reviews r ON r.correction_id=c.id WHERE c.translation_id=? AND (c.verified=1 OR r.approved=1) ORDER BY c.version DESC LIMIT 1) AS verified,
    (SELECT json_group_array(json_object('id',q.id,'body',q.body,'author',q.author,'created_at',q.created_at)) FROM (SELECT c.id,c.body,p.name AS author,c.created_at FROM pdf_translation_corrections c JOIN profiles p ON p.id=c.author_id LEFT JOIN pdf_translation_reviews r ON r.correction_id=c.id WHERE c.translation_id=? AND c.verified=0 AND r.id IS NULL ORDER BY c.version DESC LIMIT 20) q) AS proposals,
    COALESCE((SELECT max(version) FROM pdf_translation_corrections WHERE translation_id=?),0) AS version`,
      t.id,
      t.id,
      t.id,
    )
    .first<{ verified: string | null; proposals: string; version: number }>();
  const verified = state?.verified
    ? (JSON.parse(state.verified) as { body: string; version: number })
    : null;
  const proposals = JSON.parse(
    state?.proposals ?? "[]",
  ) as PdfTranslationRow["proposals"];
  return {
    id: t.id,
    segment_id: t.segment_id,
    original: t.original,
    machine: t.machine,
    body: verified?.body ?? t.machine,
    status: verified ? "verified" : "automatic",
    warnings: verified ? [] : JSON.parse(t.warnings),
    provider: t.provider,
    reused_from: t.reused_from ?? null,
    correction_version: state?.version ?? 0,
    proposals,
  };
}
export function pdfTranslationRoutes(
  factory: (env: Bindings) => TranslationProvider = (env) =>
    new DeepLFreeProvider(env.DEEPL_API_KEY!),
) {
  const app = new Hono<{ Bindings: Bindings; Variables: Vars }>();
  app.post("/revisions/:revision/pdf-text", async (c) => {
    const s = c.get("store"),
      a = await access(s, parse(z.uuid(), c.req.param("revision"))),
      v = parse(pdfLookup, await c.req.json());
    const audience = a.external ? "shared" : v.audience;
    const exists = await s
      .statement(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='pdf_translations'",
      )
      .first();
    if (!exists) throw new HttpError(503, "pdf_translation_migration_required");
    // Extracted text is untrusted client input. Fingerprints include text AND geometry;
    // readers independently recompute them from their own authorized PDF bytes.
    const items = [];
    for (const segment of v.segments) {
      const detectedSource = detectNote(segment.text);
      const sourceLanguage =
        v.source_language === "auto" && detectedSource !== "uncertain"
          ? detectedSource
          : v.source_language;
      const id = await segmentKey(a.r.id, a.r.sha256, v.page, segment);
      const glossary = await relevantGlossary(s, {
        text: segment.text,
        organization_id: a.org,
        external: audience === "shared",
      });
      const gh = await glossaryFingerprint(glossary);
      const t = await s
        .statement(
          "SELECT t.*,g.original,g.revision_id FROM pdf_translations t JOIN pdf_text_segments g ON g.id=t.segment_id WHERE t.segment_id=? AND t.audience=? AND t.source_language=? AND t.target_language=? AND ((t.glossary_hash=? AND (t.provider=? OR t.reused_from IS NOT NULL)) OR EXISTS(SELECT 1 FROM pdf_translation_corrections c LEFT JOIN pdf_translation_reviews r ON r.correction_id=c.id WHERE c.translation_id=t.id AND (c.verified=1 OR r.approved=1))) ORDER BY EXISTS(SELECT 1 FROM pdf_translation_corrections c LEFT JOIN pdf_translation_reviews r ON r.correction_id=c.id WHERE c.translation_id=t.id AND (c.verified=1 OR r.approved=1)) DESC,t.created_at DESC LIMIT 1",
          id,
          audience,
          sourceLanguage,
          v.target_language,
          gh,
          factory(c.env).version,
        )
        .first<Stored>();
      const pos = await s
        .statement(
          "SELECT dx,dy FROM pdf_translation_positions WHERE segment_id=? AND user_id=?",
          id,
          s.userId,
        )
        .first<{ dx: number; dy: number }>();
      items.push({
        segment_id: id,
        translation: t ? await result(s, t) : null,
        position: pos ?? { dx: 0, dy: 0 },
        detected: detectNote(segment.text),
      });
    }
    return c.json({
      items,
      audience,
      can_verify: a.canVerify,
      can_propose: a.canPropose,
      enabled: c.env.TRANSLATION_ENABLED === "true" && !!c.env.DEEPL_API_KEY,
    });
  });
  app.post("/revisions/:revision/pdf-translate", async (c) => {
    const s = c.get("store"),
      a = await access(s, parse(z.uuid(), c.req.param("revision"))),
      v = parse(
        pdfLookup.extend({
          segments: z.array(pdfSegment).length(1),
          consent: z.literal(true),
        }),
        await c.req.json(),
      );
    const audience = a.external ? "shared" : v.audience,
      segment = v.segments[0];
    if (!linguisticNote(segment.text))
      throw new HttpError(400, "pdf_translation_not_linguistic");
    const detected = detectNote(segment.text);
    const sourceLanguage =
      v.source_language === "auto" && detected !== "uncertain"
        ? detected
        : v.source_language;
    if (v.source_language === "auto" && detected === "uncertain")
      throw new HttpError(409, "pdf_translation_language_uncertain");
    if (
      v.target_language ===
      (v.source_language === "auto" ? detected : v.source_language)
    )
      throw new HttpError(400, "translation_same_language");
    const id = await segmentKey(a.r.id, a.r.sha256, v.page, segment);
    const glossary = await relevantGlossary(s, {
      text: segment.text,
      organization_id: a.org,
      external: audience === "shared",
    });
    const gh = await glossaryFingerprint(glossary),
      provider = factory(c.env);
    const key = await pdfHash(
      JSON.stringify([
        id,
        audience,
        sourceLanguage,
        v.target_language,
        gh,
        provider.version,
        "pdf-protection-v1",
      ]),
    );
    const existing = await s
      .statement(
        "SELECT t.*,g.original,g.revision_id FROM pdf_translations t JOIN pdf_text_segments g ON g.id=t.segment_id WHERE t.segment_id=? AND t.audience=? AND t.source_language=? AND t.target_language=? AND (t.cache_key=? OR EXISTS(SELECT 1 FROM pdf_translation_corrections c LEFT JOIN pdf_translation_reviews r ON r.correction_id=c.id WHERE c.translation_id=t.id AND (c.verified=1 OR r.approved=1))) ORDER BY EXISTS(SELECT 1 FROM pdf_translation_corrections c LEFT JOIN pdf_translation_reviews r ON r.correction_id=c.id WHERE c.translation_id=t.id AND (c.verified=1 OR r.approved=1)) DESC,t.created_at DESC LIMIT 1",
        id,
        audience,
        sourceLanguage,
        v.target_language,
        key,
      )
      .first<Stored>();
    if (existing) return c.json(await result(s, existing));
    // Reuse reviewed TEXT only; new geometry always comes from this revision.
    // Reuse remains automatic/unverified until someone reviews the new context.
    const candidates = await s.all<Stored>(
      "SELECT t.*,g.original,g.revision_id FROM pdf_translations t JOIN pdf_text_segments g ON g.id=t.segment_id JOIN document_revisions old ON old.id=g.revision_id WHERE old.document_id=? AND g.original=? AND t.audience=? AND t.source_language=? AND t.target_language=? AND EXISTS(SELECT 1 FROM pdf_translation_corrections c LEFT JOIN pdf_translation_reviews review ON review.correction_id=c.id WHERE c.translation_id=t.id AND (c.verified=1 OR review.approved=1)) ORDER BY t.created_at DESC LIMIT 10",
      a.r.document_id,
      segment.text,
      audience,
      sourceLanguage,
      v.target_language,
    );
    for (const previous of candidates) {
      try {
        await access(s, previous.revision_id);
      } catch (error) {
        if (error instanceof HttpError && [403, 404].includes(error.status))
          continue;
        throw error;
      }
      const reviewed = await result(s, previous);
      if (
        reviewed.status !== "verified" ||
        verifyTechnical(segment.text, reviewed.body).length
      )
        continue;
      const reuseAccess = await access(s, a.r.id);
      if (reuseAccess.external && audience !== "shared")
        throw new HttpError(404, "pdf_translation_unavailable");
      await s.db.batch([
        s.statement(
          "INSERT OR IGNORE INTO pdf_text_segments(id,revision_id,page,original,geometry,extraction_version,created_by) VALUES(?,?,?,?,?,?,?)",
          id,
          a.r.id,
          v.page,
          segment.text,
          JSON.stringify(segment),
          extractionVersion,
          s.userId,
        ),
        s.statement(
          "INSERT OR IGNORE INTO pdf_translations(id,segment_id,audience,source_language,target_language,provider,glossary_hash,cache_key,machine,warnings,created_by,reused_from) VALUES(?,?,?,?,?,'verified-text-reuse-v1',?,?,?,'[]',?,?)",
          crypto.randomUUID(),
          id,
          audience,
          sourceLanguage,
          v.target_language,
          gh,
          key,
          reviewed.body,
          s.userId,
          previous.id,
        ),
      ]);
      const reused = await s
        .statement(
          "SELECT t.*,g.original,g.revision_id FROM pdf_translations t JOIN pdf_text_segments g ON g.id=t.segment_id WHERE t.cache_key=?",
          key,
        )
        .first<Stored>();
      return c.json(await result(s, reused!), 201);
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
      const completed = await s
        .statement(
          "SELECT t.*,g.original,g.revision_id FROM pdf_translations t JOIN pdf_text_segments g ON g.id=t.segment_id WHERE t.cache_key=?",
          key,
        )
        .first<Stored>();
      if (completed) return c.json(await result(s, completed));
      const protectedText = protect(
        segment.text,
        glossary,
        sourceLanguage,
        v.target_language,
        crypto.randomUUID().replaceAll("-", "").slice(0, 8),
      );
      const chars = protectedText.text.length;
      const reserve = await s
        .statement(
          "INSERT INTO translation_attempts(id,organization_id,actor_id,characters) SELECT ?,?,?,? WHERE (SELECT count(*) FROM translation_attempts WHERE organization_id=? AND created>=unixepoch('now','start of day'))<? AND (SELECT COALESCE(sum(characters),0) FROM translation_attempts WHERE organization_id=? AND created>=unixepoch('now','start of day'))+?<=? AND (SELECT count(*) FROM translation_attempts WHERE actor_id=? AND created>unixepoch()-60)<?",
          attempt,
          a.org,
          s.userId,
          chars,
          a.org,
          limit(c.env.TRANSLATION_DAILY_REQUESTS, 100, 1000),
          a.org,
          chars,
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
          v.source_language === "auto" ? detected : v.source_language,
          v.target_language,
        ),
        restored = protectedText.restore(translated.text);
      if (!restored.text.trim() || restored.text.length > 2400)
        throw new HttpError(502, "translation_provider_invalid");
      const currentAccess = await access(s, a.r.id);
      if (currentAccess.external && audience !== "shared")
        throw new HttpError(404, "pdf_translation_unavailable");
      const translation = crypto.randomUUID();
      await s.db.batch([
        s.statement(
          "INSERT OR IGNORE INTO pdf_text_segments(id,revision_id,page,original,geometry,extraction_version,created_by) VALUES(?,?,?,?,?,?,?)",
          id,
          a.r.id,
          v.page,
          segment.text,
          JSON.stringify(segment),
          extractionVersion,
          s.userId,
        ),
        s.statement(
          "INSERT INTO pdf_translations(id,segment_id,audience,source_language,target_language,provider,glossary_hash,cache_key,machine,warnings,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          translation,
          id,
          audience,
          sourceLanguage,
          v.target_language,
          provider.version,
          gh,
          key,
          restored.text,
          JSON.stringify(restored.warnings),
          s.userId,
        ),
      ]);
      return c.json(
        await result(s, {
          id: translation,
          segment_id: id,
          machine: restored.text,
          warnings: JSON.stringify(restored.warnings),
          provider: provider.version,
          audience,
          source_language: sourceLanguage,
          target_language: v.target_language,
          glossary_hash: gh,
          cache_key: key,
          original: segment.text,
          revision_id: a.r.id,
        }),
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
  async function translation(s: Store, id: string, correction = false) {
    const t = await s
      .statement(
        "SELECT t.*,g.original,g.revision_id FROM pdf_translations t JOIN pdf_text_segments g ON g.id=t.segment_id WHERE t.id=?",
        id,
      )
      .first<Stored>();
    if (!t) throw new HttpError(404, "pdf_translation_unavailable");
    const a = await access(
      s,
      t.revision_id,
      correction ? "correct_translations" : "translate",
    );
    if (a.external && t.audience !== "shared")
      throw new HttpError(404, "pdf_translation_unavailable");
    return { t, a };
  }
  app.get("/pdf-translations/:id/history", async (c) => {
    const s = c.get("store"),
      { t } = await translation(s, parse(z.uuid(), c.req.param("id")));
    const items = await s.all(
      "SELECT c.*,p.name AS author,r.approved,r.created_at AS reviewed_at,r.reviewer_id,reviewer.name AS reviewer FROM pdf_translation_corrections c JOIN profiles p ON p.id=c.author_id LEFT JOIN pdf_translation_reviews r ON r.correction_id=c.id LEFT JOIN profiles reviewer ON reviewer.id=r.reviewer_id WHERE c.translation_id=? ORDER BY c.version DESC LIMIT 100",
      t.id,
    );
    return c.json({ original: t.original, machine: t.machine, items });
  });
  app.post("/pdf-translations/:id/corrections", async (c) => {
    const s = c.get("store"),
      { t, a } = await translation(s, parse(z.uuid(), c.req.param("id")), true);
    const v = parse(
      z.object({
        body: z.string().trim().min(1).max(2400),
        version: z.number().int().min(0),
        verify: z.boolean().default(false),
      }),
      await c.req.json(),
    );
    if (v.verify && !a.canVerify)
      throw new HttpError(403, "pdf_translation_review_denied");
    if (verifyTechnical(t.original, v.body).length)
      throw new HttpError(400, "pdf_translation_technical_changed");
    const id = crypto.randomUUID();
    const r = await s
      .statement(
        "INSERT INTO pdf_translation_corrections(id,translation_id,body,version,author_id,verified) SELECT ?,?,?,?,?,? WHERE COALESCE((SELECT max(version) FROM pdf_translation_corrections WHERE translation_id=?),0)=?",
        id,
        t.id,
        v.body,
        v.version + 1,
        s.userId,
        v.verify ? 1 : 0,
        t.id,
        v.version,
      )
      .run();
    if (!r.meta.changes)
      throw new HttpError(409, "pdf_translation_correction_conflict");
    return c.json(await result(s, t), 201);
  });
  app.post("/pdf-translations/:id/reviews", async (c) => {
    const s = c.get("store"),
      { t, a } = await translation(s, parse(z.uuid(), c.req.param("id")), true);
    if (!a.canVerify) throw new HttpError(403, "pdf_translation_review_denied");
    const v = parse(
      z.object({ correction_id: z.uuid(), approved: z.boolean() }),
      await c.req.json(),
    );
    const r = await s
      .statement(
        "INSERT OR IGNORE INTO pdf_translation_reviews(id,correction_id,reviewer_id,approved) SELECT ?,id,?,? FROM pdf_translation_corrections WHERE id=? AND translation_id=? AND verified=0",
        crypto.randomUUID(),
        s.userId,
        v.approved ? 1 : 0,
        v.correction_id,
        t.id,
      )
      .run();
    if (!r.meta.changes)
      throw new HttpError(409, "pdf_translation_correction_conflict");
    return c.json(await result(s, t));
  });
  app.post("/pdf-translations/:id/position", async (c) => {
    const s = c.get("store"),
      { t } = await translation(s, parse(z.uuid(), c.req.param("id")));
    const v = parse(
      z.object({
        dx: z.number().finite().min(-1).max(1),
        dy: z.number().finite().min(-1).max(1),
      }),
      await c.req.json(),
    );
    await s
      .statement(
        "INSERT INTO pdf_translation_positions(segment_id,user_id,dx,dy) VALUES(?,?,?,?) ON CONFLICT(segment_id,user_id) DO UPDATE SET dx=excluded.dx,dy=excluded.dy",
        t.segment_id,
        s.userId,
        v.dx,
        v.dy,
      )
      .run();
    return c.json(v);
  });
  return app;
}
