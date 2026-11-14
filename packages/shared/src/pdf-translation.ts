import { z } from "zod";
import { translationLanguages } from "./translations";
export const extractionVersion = "pdfjs-notes-v1";
const finite = z.number().finite();
export const pdfSegment = z
  .object({
    text: z.string().min(1).max(600),
    x: finite.min(0).max(1),
    y: finite.min(0).max(1),
    width: finite.positive().max(4),
    height: finite.positive().max(1),
    angle: finite.min(-180).max(180),
    font_size: finite.positive().max(500),
    transform: z.array(finite.min(-100000).max(100000)).length(6),
    order: z.number().int().min(0).max(10000),
  })
  .strict();
export type PdfSegment = z.infer<typeof pdfSegment>;
export const pdfLanguage = z.enum(["auto", ...translationLanguages]);
export const pdfLookup = z.object({
  page: z.number().int().min(1).max(10000),
  segments: z.array(pdfSegment).min(1).max(6),
  source_language: pdfLanguage.default("auto"),
  target_language: z.enum(translationLanguages),
  audience: z.enum(["internal", "shared"]).default("internal"),
});
export async function pdfHash(text: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}
export function segmentKey(
  revision: string,
  checksum: string,
  page: number,
  segment: PdfSegment,
) {
  return pdfHash(
    JSON.stringify([
      extractionVersion,
      revision,
      checksum,
      page,
      pdfSegment.parse(segment),
    ]),
  );
}
/** Deliberately conservative. Codes/dimensions alone are never language evidence. */
export function detectNote(text: string): "en" | "fr" | "zh-CN" | "uncertain" {
  if (/[\u3400-\u9fff]{2}/u.test(text)) return "zh-CN";
  if (
    /\b(?:enlever|éliminer|arêtes|matière|acier|dimensions en|ne pas|tolérance|générales|toutes les|finition|trou de)\b/iu.test(
      text,
    )
  )
    return "fr";
  if (
    /\b(?:remove|sharp edges|material|dimensions in|bent steel|mounting hole|surface finish|general notes|do not|stainless steel|cold rolled|all dimensions|tolerance)\b/iu.test(
      text,
    )
  )
    return "en";
  return "uncertain";
}
export function linguisticNote(text: string) {
  const cleaned = text
    .replace(/\b(?:rev\.?|revision|révision)\s+[A-Z0-9.-]+/gi, " ")
    .replace(/\b(?:ISO|AISI|ASTM|DIN|EN|ANSI|JIS)\s*[\w.-]+/g, " ")
    .replace(
      /\b(?=[A-Za-z0-9._-]*\d)[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)+\b/g,
      " ",
    )
    .replace(/\b\w+\.(?:pdf|dwg|dxf|sldprt|sldasm)\b/gi, " ")
    .replace(/\b(?:M\d+|UNC|UNF|mm|cm|MPa|REV|AISI)\b/g, " ");
  return /[\p{L}]{3,}/u.test(cleaned) || /[\u3400-\u9fff]{2}/u.test(cleaned);
}
export interface PdfTranslationRow {
  id: string;
  segment_id: string;
  original: string;
  machine: string;
  body: string;
  status: "automatic" | "verified";
  warnings: string[];
  provider: string;
  reused_from?: string | null;
  correction_version: number;
  proposals: { id: string; body: string; author: string; created_at: string }[];
}
