import { test, expect, type Page, type Locator } from "@playwright/test";
import { PDFDocument } from "@cantoo/pdf-lib";
test.use({ actionTimeout: 10000, navigationTimeout: 15000 });
const origin = "http://127.0.0.1:4191";
async function post(page: Page, path: string, data: unknown) {
  const r = await page.request.post(`/api/v1/${path}`, {
    data,
    headers: { Origin: origin },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}
async function fixture(page: Page, name: string) {
  await page.goto("/admin");
  const org = await post(page, "organizations", {
      name: `Translation ${name}`,
    }),
    project = await post(page, "projects", {
      organization_id: org.id,
      code: `TR-${name}`,
      name: `Translation ${name}`,
    });
  const conversation = await post(
    page,
    `projects/${project.id}/conversations`,
    { title: "Translation test discussion" },
  );
  await page.evaluate((id) => {
    localStorage.setItem("forgebridge.organization", id);
    localStorage.setItem("forgebridge.language", "fr-CA");
    localStorage.removeItem("forgebridge.translation.target");
  }, org.id);
  return {
    org: org.id as string,
    project: project.id as string,
    conversation: conversation.id as string,
  };
}
async function message(page: Page, conversation: string, body: string) {
  const id = crypto.randomUUID();
  await post(page, `conversations/${conversation}/messages`, { id, body });
  return id;
}
const control = (page: Page, kind: string, id: string, field = "body") =>
  page.locator(`[data-translation-source="${kind}:${id}:${field}"]`);
async function generate(box: Locator, target = "en", source = "fr") {
  await box.getByRole("button", { name: "Traduire", exact: true }).click();
  await box
    .getByLabel("Langue originale", { exact: true })
    .selectOption(source);
  await box
    .getByLabel("Langue de traduction", { exact: true })
    .selectOption(target);
  await box
    .getByRole("button", { name: "Traduire ce texte", exact: true })
    .click();
}
test("messages translate three directions on demand, preserve tokens, copy, cache, correct, persist and invalidate an edited source", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const f = await fixture(page, "MESSAGES");
  const text =
    "Veuillez augmenter l'épaisseur de cette pièce à 3 mm et conserver une tolérance de ±0,1 mm. M8 × 1,25 AISI 304 ISO 2768 LC-001 Révision C";
  const id = await message(page, f.conversation, text),
    zh = await message(page, f.conversation, "请将厚度增加至 3 mm");
  let calls = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/v1/translations") && r.method() === "POST")
      calls++;
  });
  await page.goto(
    `/projects/${f.project}/messages?conversation=${f.conversation}`,
  );
  const box = control(page, "message", id);
  await expect(box).toContainText(text);
  expect(calls).toBe(0);
  await generate(box);
  await expect(box.locator(".translation-result")).toContainText(
    "Please increase",
  );
  for (const token of [
    "3 mm",
    "±0,1 mm",
    "M8 × 1,25",
    "AISI 304",
    "ISO 2768",
    "LC-001",
    "Révision C",
  ])
    await expect(box.locator(".translation-result")).toContainText(token);
  await box
    .getByRole("button", { name: "Copier la traduction", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("Please increase");
  await box
    .getByRole("button", { name: "Afficher l’original", exact: true })
    .click();
  await expect(box.locator(":scope > .message-body")).toHaveText(text);
  await box
    .getByRole("button", { name: "Afficher la traduction", exact: true })
    .click();
  await box
    .getByRole("button", { name: "Corriger la traduction", exact: true })
    .click();
  const corrected =
    "Verified test correction 3 mm ±0,1 mm M8 × 1,25 AISI 304 ISO 2768 LC-001 Révision C";
  await box.getByLabel("Texte corrigé", { exact: true }).fill(corrected);
  await box
    .getByRole("button", { name: "Enregistrer la correction", exact: true })
    .click();
  await expect(box.locator(".translation-result")).toContainText(
    "Traduction corrigée",
  );
  await page.reload();
  await generate(box);
  await expect(box.locator(".translation-result")).toContainText(corrected);
  await expect(box).toContainText("Réutilisée depuis le cache");
  await box
    .getByRole("combobox", { name: "Langue de traduction", exact: true })
    .selectOption("zh-CN");
  await expect(box.locator(":scope > .message-body")).toHaveText(text);
  await box
    .getByRole("button", { name: "Traduire ce texte", exact: true })
    .click();
  await expect(box.locator(".translation-result")).toContainText(
    "请将此零件厚度",
  );
  await generate(control(page, "message", zh), "fr", "auto");
  await expect(control(page, "message", zh)).toContainText(
    "Veuillez augmenter",
  );
  // Editing the real message invalidates and unmounts the previous translation state.
  const card = page.getByTestId(`message-${id}`);
  await card
    .getByRole("button", { name: "Modifier le message", exact: true })
    .click();
  await card
    .getByRole("textbox", { name: "Modifier le message", exact: true })
    .fill("Bonjour 4 mm LC-001");
  await card.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(box.locator(":scope > .message-body")).toHaveText(
    "Bonjour 4 mm LC-001",
  );
  await expect(box.locator(".translation-result")).toHaveCount(0);
  await generate(box);
  await expect(box.locator(".translation-result")).toContainText(
    "Hello 4 mm LC-001",
  );
  await expect(box.locator(".translation-result")).not.toContainText(
    "Verified test correction",
  );
});
test("organization glossary CRUD through the real UI influences only relevant on-demand translations", async ({
  page,
}) => {
  const f = await fixture(page, "GLOSSARY"),
    id = await message(page, f.conversation, "Charnière 3 mm");
  await page.goto("/admin");
  const glossary = page.getByRole("region", {
    name: "Glossaire technique de l’organisation",
    exact: true,
  });
  await glossary
    .getByRole("button", { name: "Ajouter un terme", exact: true })
    .click();
  const form = glossary.locator("form");
  for (const [label, value] of [
    ["Français", "Charnière"],
    ["Anglais", "Verified hinge"],
    ["Chinois simplifié", "已核实铰链"],
    ["Domaine", "Mécanique"],
    ["Définition", "Non confidential test fixture"],
  ])
    await form.getByRole("textbox", { name: label, exact: true }).fill(value);
  await form.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(
    glossary.getByRole("cell", { name: "Verified hinge", exact: true }),
  ).toBeVisible();
  await glossary
    .getByRole("textbox", { name: "Rechercher", exact: true })
    .fill("Charnière");
  await glossary
    .getByRole("textbox", { name: "Filtrer par domaine exact", exact: true })
    .fill("Mécanique");
  await glossary.getByRole("button", { name: "Modifier", exact: true }).click();
  await form
    .getByRole("textbox", { name: "Anglais", exact: true })
    .fill("Verified updated hinge");
  await form.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await page.goto(
    `/projects/${f.project}/messages?conversation=${f.conversation}`,
  );
  await generate(control(page, "message", id));
  await expect(control(page, "message", id)).toContainText(
    "Verified updated hinge 3 mm",
  );
  await page.goto("/admin");
  await glossary.getByRole("button", { name: "Modifier", exact: true }).click();
  page.once("dialog", (d) => d.accept());
  await form
    .getByRole("button", { name: "Supprimer le terme", exact: true })
    .click();
  await expect(
    glossary.getByRole("cell", { name: "Charnière", exact: true }),
  ).toHaveCount(0);
});
test("PDF points, replies, technical requests and immutable rejection reasons use the same translation controls", async ({
  page,
}) => {
  const f = await fixture(page, "PDF");
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 300]);
  const bytes = Buffer.from(await pdf.save());
  const upload = await post(page, `projects/${f.project}/uploads`, {
    name: "Translation PDF",
    number: "LC-001",
    filename: "fixture.pdf",
    size: bytes.length,
    sha256: Buffer.from(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ).toString("hex"),
    label: "C",
  });
  expect(
    (
      await page.request.put(`/api/v1/uploads/${upload.id}/content`, {
        data: bytes,
        headers: { Origin: origin, "Content-Length": String(bytes.length) },
      })
    ).ok(),
  ).toBeTruthy();
  const doc = await post(page, `uploads/${upload.id}/complete`, {}),
    point = crypto.randomUUID(),
    reply = crypto.randomUUID();
  await post(page, `revisions/${doc.revision_id}/review-items`, {
    id: point,
    page: 1,
    type: "discussion",
    title: "Déplacer le trou",
    summary: "Le trou doit être déplacé de 2 mm vers la gauche.",
    geometry: { points: [] },
  });
  await post(page, `review-items/${point}/messages`, {
    id: reply,
    body: "Bonjour 3 mm LC-001",
  });
  await page.goto(
    `/projects/${f.project}/documents?document=${doc.id}&revision=${doc.revision_id}&point=${point}&page=1`,
  );
  await generate(control(page, "review_item", point, "title"));
  await expect(control(page, "review_item", point, "title")).toContainText(
    "Move the hole",
  );
  await generate(control(page, "review_item", point, "summary"), "zh-CN");
  await expect(control(page, "review_item", point, "summary")).toContainText(
    "孔必须移动",
  );
  await expect(control(page, "review_item", point, "summary")).toContainText(
    "2 mm",
  );
  await generate(control(page, "review_message", reply));
  await expect(control(page, "review_message", reply)).toContainText(
    "Hello 3 mm LC-001",
  );
  const source = await message(page, f.conversation, "Bonjour 3 mm"),
    request = await post(page, `messages/${source}/requests`, {
      message_id: source,
      title: "Déplacer le trou",
      description: "Bonjour 3 mm",
      revision_id: doc.revision_id,
      document_id: doc.id,
    });
  await page.goto(`/projects/${f.project}/requests`);
  await generate(control(page, "request", request.id, "description"));
  await expect(
    control(page, "request", request.id, "description"),
  ).toContainText("Hello 3 mm");
  const a = crypto.randomUUID();
  await post(page, "approvals", {
    id: a,
    revision_id: doc.revision_id,
    title: "Internal test",
    description: "Bonjour 3 mm",
  });
  await post(page, `approvals/${a}/actions`, { action: "submit", version: 1 });
  await post(page, `approvals/${a}/actions`, {
    action: "reject",
    version: 2,
    comment: "Refus technique 3 mm LC-001",
  });
  await page.goto(`/projects/${f.project}/approvals?approval=${a}`);
  await generate(control(page, "approval", a, "decision_comment"), "zh-CN");
  await expect(control(page, "approval", a, "decision_comment")).toContainText(
    "技术拒绝",
  );
  await expect(control(page, "approval", a, "decision_comment")).toContainText(
    "Seule la décision originale fait référence",
  );
  const after = await (await page.request.get(`/api/v1/approvals/${a}`)).json();
  expect(after.approval.status).toBe("rejected");
  expect(after.approval.decision_comment).toBe("Refus technique 3 mm LC-001");
});
test("provider errors preserve original reading and suspicious values warn; no credentials are returned to the browser", async ({
  page,
}) => {
  const f = await fixture(page, "ERRORS"),
    bad = await message(page, f.conversation, "providererror Bonjour 3 mm"),
    suspect = await message(page, f.conversation, "brokentoken 3 mm LC-001");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(
    `/projects/${f.project}/messages?conversation=${f.conversation}`,
  );
  await generate(control(page, "message", bad));
  await expect(control(page, "message", bad).getByRole("alert")).toContainText(
    "fournisseur",
  );
  await expect(
    control(page, "message", bad).locator(":scope > .message-body"),
  ).toContainText("Bonjour 3 mm");
  await generate(control(page, "message", suspect));
  await expect(
    control(page, "message", suspect).getByRole("alert"),
  ).toContainText("valeurs ou références techniques");
  expect(
    await (await page.request.get("/api/v1/translations/config")).text(),
  ).not.toContain("test-fixture-only");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "/tmp/forgebridge-phase6-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
