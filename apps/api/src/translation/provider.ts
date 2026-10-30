import { HttpError } from "../types";
export interface TranslationProvider {
  readonly version: string;
  translate(
    text: string,
    tokens: string[],
    source: string,
    target: string,
  ): Promise<{ text: string; detected: string | null }>;
}
const escapeXml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const decodeXml = (s: string) =>
  s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
/** Fixed API Free destination: no caller-supplied URL, Pro billing or fallback provider. */
export class DeepLFreeProvider implements TranslationProvider {
  readonly version = "deepl-api-free-v2-xml-v1";
  constructor(
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async translate(
    text: string,
    tokens: string[],
    source: string,
    target: string,
  ) {
    let xml = escapeXml(text);
    for (const token of tokens)
      xml = xml.replaceAll(token, `<keep>${token}</keep>`);
    const languages: Record<string, string> = {
      fr: "FR",
      en: "EN",
      "zh-CN": "ZH-HANS",
    };
    let response: Response;
    try {
      response = await this.fetcher("https://api-free.deepl.com/v2/translate", {
        method: "POST",
        headers: {
          Authorization: `DeepL-Auth-Key ${this.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: [`<text>${xml}</text>`],
          target_lang: languages[target],
          ...(source === "auto"
            ? {}
            : { source_lang: source === "zh-CN" ? "ZH" : languages[source] }),
          tag_handling: "xml",
          ignore_tags: ["keep"],
          preserve_formatting: true,
        }),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
    } catch {
      throw new HttpError(502, "translation_provider_unavailable");
    }
    if (!response.ok)
      throw new HttpError(
        response.status === 429 || response.status === 456 ? 429 : 502,
        response.status === 456
          ? "translation_provider_quota"
          : "translation_provider_unavailable",
      );
    if (Number(response.headers.get("content-length")) > 131072)
      throw new HttpError(502, "translation_provider_invalid");
    const raw = await response.text();
    if (raw.length > 131072)
      throw new HttpError(502, "translation_provider_invalid");
    let result: {
      translations?: { text?: unknown; detected_source_language?: unknown }[];
    };
    try {
      result = JSON.parse(raw);
    } catch {
      throw new HttpError(502, "translation_provider_invalid");
    }
    const r = result.translations?.[0];
    if (
      !r ||
      typeof r.text !== "string" ||
      !r.text.trim() ||
      r.text.length > 64000
    )
      throw new HttpError(502, "translation_provider_invalid");
    const detected =
      typeof r.detected_source_language === "string"
        ? r.detected_source_language.slice(0, 20)
        : null;
    return {
      text: decodeXml(r.text.replace(/<\/?(?:text|keep)(?:\s[^>]*)?>/g, "")),
      detected,
    };
  }
}
