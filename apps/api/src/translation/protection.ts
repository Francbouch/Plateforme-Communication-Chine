import type { GlossaryEntry } from "../../../../packages/shared/src/translations";
// Longest alternatives first: preserve complete engineering expressions, then every number.
const criticalPattern =
  /(?:\b(?:ISO|AISI|ASTM|DIN|EN|ANSI|JIS)\s*[-\w.]+|\bM\d+(?:[.,]\d+)?\s*[×x]\s*\d+(?:[.,]\d+)?|\b(?:Révision|Revision|Rev\.)\s+[A-Z0-9.-]+|\b[A-Z][A-Z0-9]*[-_][A-Z0-9._-]+|\b[A-Z]{1,12}\d+[A-Z0-9._-]*\b|[±+−-]?\d+(?:[.,]\d+)?(?:\s*(?:mm|cm|µm|μm|nm|m²|m³|m|kg|mg|g|N·m|Nm|MPa|kPa|Pa|bar|psi|°C|°F|°|%|V|A|W|Hz)(?![\p{L}\p{N}_]))?)/gu;
export function critical(text: string) {
  return text.match(criticalPattern) ?? [];
}
export function verifyTechnical(
  original: string,
  translated: string,
): string[] {
  const a = critical(original),
    b = critical(translated),
    counts = (v: string[]) =>
      v.reduce(
        (m, x) => m.set(x, (m.get(x) ?? 0) + 1),
        new Map<string, number>(),
      );
  const ac = counts(a),
    bc = counts(b);
  return [...new Set([...ac.keys(), ...bc.keys()])].filter(
    (k) => ac.get(k) !== bc.get(k),
  );
}
export function protect(
  text: string,
  glossary: GlossaryEntry[],
  source: string,
  target: "fr" | "en" | "zh-CN",
  nonce: string,
) {
  const candidates: { start: number; end: number; value: string }[] = [];
  for (const match of text.matchAll(criticalPattern))
    candidates.push({
      start: match.index,
      end: match.index + match[0].length,
      value: match[0],
    });
  for (const entry of glossary)
    for (const lang of ["fr", "en", "zh-CN"] as const) {
      if (source !== "auto" && source !== lang) continue;
      const term = entry[lang];
      let offset = 0;
      while (offset < text.length) {
        const start = text
          .toLocaleLowerCase()
          .indexOf(term.toLocaleLowerCase(), offset);
        if (start < 0) break;
        const end = start + term.length;
        // Avoid matching a glossary term inside a longer word.
        const word = /[\p{L}\p{N}]/u;
        if (
          (lang === "zh-CN" ||
            ((!text[start - 1] || !word.test(text[start - 1])) &&
              (!text[end] || !word.test(text[end])))) &&
          !critical(term).length
        )
          candidates.push({ start, end, value: entry[target] });
        offset = end;
      }
    }
  const selected: typeof candidates = [];
  for (const c of candidates.sort(
    (a, b) => b.end - b.start - (a.end - a.start),
  ))
    if (!selected.some((s) => c.start < s.end && c.end > s.start))
      selected.push(c);
  selected.sort((a, b) => a.start - b.start);
  const tokens = selected.map((c, i) => ({ ...c, token: `FB${nonce}K${i}Z` }));
  let cursor = 0,
    protectedText = "";
  for (const c of tokens) {
    protectedText += text.slice(cursor, c.start) + c.token;
    cursor = c.end;
  }
  protectedText += text.slice(cursor);
  return {
    text: protectedText,
    tokens,
    restore(output: string) {
      let translated = output;
      const warnings: string[] = [];
      for (const c of tokens) {
        const n = translated.split(c.token).length - 1;
        if (n !== 1) warnings.push("protected_segment_changed");
        translated = translated.split(c.token).join(c.value);
      }
      if (verifyTechnical(text, translated).length)
        warnings.push("technical_values_changed");
      return { text: translated, warnings: [...new Set(warnings)] };
    },
  };
}
