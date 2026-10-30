import { z } from "zod";
export const translationLanguages = ["fr", "en", "zh-CN"] as const;
export type TranslationLanguage = (typeof translationLanguages)[number];
export const translationSource = z.object({
  kind: z.enum([
    "message",
    "review_item",
    "review_message",
    "request",
    "approval",
    "approval_event",
  ]),
  id: z.uuid(),
  field: z.enum([
    "body",
    "title",
    "summary",
    "description",
    "decision_comment",
    "comment",
  ]),
});
export type TranslationSource = z.infer<typeof translationSource>;
export const translationRequest = translationSource.extend({
  source_language: z.enum(["auto", ...translationLanguages]).default("auto"),
  target_language: z.enum(translationLanguages),
  force: z.boolean().default(false),
});
export const glossaryFields = z.object({
  fr: z.string().trim().min(1).max(160),
  en: z.string().trim().min(1).max(160),
  "zh-CN": z.string().trim().min(1).max(160),
  definition: z.string().trim().max(1000).default(""),
  domain: z.string().trim().max(100).default(""),
  notes: z.string().trim().max(1000).default(""),
});
export type GlossaryFields = z.infer<typeof glossaryFields>;
export interface GlossaryEntry extends GlossaryFields {
  id: string;
  version: number;
}
export interface TranslationResult {
  id: string;
  original: string;
  machine: string;
  corrected: string | null;
  correction_version: number;
  corrected_at: string | null;
  corrector: string | null;
  target_language: TranslationLanguage;
  source_language: string;
  detected_language: string | null;
  provider: string;
  warnings: string[];
  created_at: string;
  cached: boolean;
}
