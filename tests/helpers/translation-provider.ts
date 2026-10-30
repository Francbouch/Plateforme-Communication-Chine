/** Deterministic TEST provider transport. Never imported by application builds.
 * Exercises the real DeepL adapter without transmitting any data externally. */
export const simulatedDeepLFetch: typeof fetch = async (input, init) => {
  if (String(input) !== "https://api-free.deepl.com/v2/translate")
    throw new Error("Unexpected test destination");
  const body = JSON.parse(String(init?.body)) as {
    text: string[];
    target_lang: string;
  };
  let text = body.text[0];
  if (text.includes("providererror"))
    return new Response("unavailable", { status: 503 });
  if (text.includes("providerinvalid"))
    return new Response("not json", { status: 200 });
  if (text.includes("providerquota"))
    return new Response("quota", { status: 456 });
  const dictionary: Record<string, [string, string, string]> = {
    "Veuillez augmenter l'épaisseur de cette pièce à": [
      "Please increase this part thickness to",
      "请将此零件厚度增加至",
      "Veuillez augmenter l'épaisseur de cette pièce à",
    ],
    "et conserver une tolérance de": [
      "and keep a tolerance of",
      "并保持公差为",
      "et conserver une tolérance de",
    ],
    "Le trou doit être déplacé de": [
      "The hole must move by",
      "孔必须移动",
      "Le trou doit être déplacé de",
    ],
    "vers la gauche": ["to the left", "向左", "vers la gauche"],
    请将厚度增加至: [
      "Please increase thickness to",
      "请将厚度增加至",
      "Veuillez augmenter l’épaisseur à",
    ],
    Bonjour: ["Hello", "你好", "Bonjour"],
    "Refus technique": ["Technical rejection", "技术拒绝", "Refus technique"],
    "Déplacer le trou": ["Move the hole", "移动孔", "Déplacer le trou"],
    Charnière: ["Hinge", "铰链", "Charnière"],
  };
  const index =
    body.target_lang === "ZH-HANS" ? 1 : body.target_lang === "FR" ? 2 : 0;
  for (const [from, to] of Object.entries(dictionary))
    text = text.replaceAll(from.replaceAll("'", "&apos;"), to[index]);
  if (text.includes("brokentoken"))
    text = text.replace(/FB[a-f0-9]+K0Z/, "999 mm");
  const detected = /[\u4e00-\u9fff]/.test(body.text[0]) ? "ZH" : "FR";
  return Response.json({
    translations: [{ text, detected_source_language: detected }],
  });
};
