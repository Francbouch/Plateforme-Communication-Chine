import { test, expect, type Page } from "@playwright/test";
test.use({ actionTimeout: 10000, navigationTimeout: 15000 });
import { PDFDocument } from "@cantoo/pdf-lib";
const origin = "http://127.0.0.1:4191";
async function post(page: Page, path: string, data: unknown) {
  const res = await page.request.post(`/api/v1/${path}`, {
    data,
    headers: { Origin: origin },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}
async function fixture(page: Page, suffix: string) {
  await page.goto("/admin");
  const org = await post(page, "organizations", { name: `Messages ${suffix}` });
  const project = await post(page, "projects", {
    organization_id: org.id,
    code: `MSG-${suffix}`,
    name: `Communications ${suffix}`,
  });
  await page.evaluate(
    (id) => localStorage.setItem("forgebridge.organization", id),
    org.id,
  );
  await page.goto(`/projects/${project.id}/messages`);
  return project.id as string;
}
async function conversation(page: Page, title: string) {
  await page
    .getByRole("button", { name: "Nouvelle conversation", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Titre de la conversation", exact: true })
    .fill(title);
  await page.getByRole("button", { name: "Créer", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Conversation", exact: true })
      .getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  return new URL(page.url()).searchParams.get("conversation")!;
}
function pane(page: Page) {
  return page.getByRole("region", { name: "Conversation", exact: true });
}
async function send(page: Page, body: string) {
  await pane(page)
    .getByRole("textbox", { name: "Rédiger un message", exact: true })
    .fill(body);
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      /\/conversations\/[^/]+\/messages$/.test(new URL(r.url()).pathname),
  );
  await pane(page)
    .getByRole("button", { name: "Envoyer", exact: true })
    .click();
  const r = await response;
  expect(r.status(), await r.text()).toBe(201);
  const m = await r.json();
  await expect(page.getByTestId(`message-${m.id}`)).toBeVisible();
  return m;
}
function audit(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400)
      errors.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  return errors;
}
test("project conversations persist, reply, edit, rename, archive, isolate and search through the real UI", async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors = audit(page),
    project = await fixture(page, "CORE");
  const c = await conversation(page, "Mécanisme principal");
  const first = await send(page, "Le support métallique doit être renforcé.");
  const dbList = await page.request.get(`/api/v1/conversations/${c}/messages`);
  expect((await dbList.json()).items[0].id).toBe(first.id);
  await page.reload();
  await expect(page.getByTestId(`message-${first.id}`)).toContainText(
    "Le support métallique doit être renforcé.",
  );
  await page
    .getByTestId(`message-${first.id}`)
    .getByRole("button", { name: "Ouvrir le fil (0)", exact: true })
    .click();
  const thread = page.getByRole("region", {
    name: "Fil de discussion",
    exact: true,
  });
  await thread
    .getByRole("textbox", { name: "Rédiger une réponse", exact: true })
    .fill("Nous proposons une épaisseur de 3 mm.");
  await thread.getByRole("button", { name: "Envoyer", exact: true }).click();
  await expect(thread).toContainText("Nous proposons une épaisseur de 3 mm.");
  await thread
    .getByRole("button", { name: "Fermer le fil", exact: true })
    .click();
  const card = page.getByTestId(`message-${first.id}`);
  await card
    .getByRole("button", { name: "Modifier le message", exact: true })
    .click();
  await card
    .getByRole("textbox", { name: "Modifier le message", exact: true })
    .fill("Support approuvé pour le prototype renforcé.");
  await card.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(card).toContainText(
    "Support approuvé pour le prototype renforcé.",
  );
  await pane(page)
    .getByRole("button", { name: "Renommer la conversation", exact: true })
    .click();
  await pane(page)
    .getByRole("textbox", { name: "Titre de la conversation", exact: true })
    .fill("Prototype 1");
  await pane(page)
    .getByRole("button", { name: "Enregistrer", exact: true })
    .click();
  await expect(
    pane(page).getByRole("heading", { name: "Prototype 1", exact: true }),
  ).toBeVisible();
  await pane(page)
    .getByRole("button", { name: "Archiver la conversation", exact: true })
    .click();
  await expect(pane(page)).toContainText("Conversation archivée");
  await expect(
    pane(page).getByRole("textbox", {
      name: "Rédiger un message",
      exact: true,
    }),
  ).toHaveCount(0);
  const b = await conversation(page, "Matériaux et finitions");
  await expect(pane(page)).not.toContainText("Support approuvé");
  const second = await send(page, "Anodisation bleue pour le boîtier.");
  await page
    .getByRole("searchbox", {
      name: "Rechercher dans les messages",
      exact: true,
    })
    .fill("épaisseur de 3 mm");
  const results = page.getByRole("region", {
    name: "Résultats de recherche",
    exact: true,
  });
  await expect(results).toContainText("Nous proposons une épaisseur de 3 mm.");
  await results
    .getByRole("button")
    .filter({ hasText: "Nous proposons une épaisseur de 3 mm." })
    .click();
  await expect(
    page.getByRole("region", { name: "Fil de discussion", exact: true }),
  ).toContainText("Nous proposons une épaisseur de 3 mm.");
  expect(new URL(page.url()).searchParams.get("conversation")).toBe(c);
  await page.goto(`/projects/${project}/messages?conversation=${b}`);
  await expect(page.getByTestId(`message-${second.id}`)).toBeVisible();
  await expect(pane(page)).not.toContainText("Support approuvé");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: "/tmp/forgebridge-phase4-messages.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("document references open the exact historical revision and PDF page; files and requests persist", async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors = audit(page),
    project = await fixture(page, "LINKS");
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 3; i++) pdf.addPage([300, 300]);
  const bytes = Buffer.from(await pdf.save());
  const sha256 = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Buffer.from(sha256).toString("hex");
  const uploaded = await post(page, `projects/${project}/uploads`, {
    name: "Plan du mécanisme",
    number: "LC-001",
    filename: "plan.pdf",
    size: bytes.length,
    sha256: hash,
    label: "A",
  });
  const content = await page.request.put(
    `/api/v1/uploads/${uploaded.id}/content`,
    {
      data: bytes,
      headers: { Origin: origin, "Content-Length": String(bytes.length) },
    },
  );
  expect(content.ok()).toBeTruthy();
  const doc = await post(page, `uploads/${uploaded.id}/complete`, {});
  const second = await post(page, `projects/${project}/uploads`, {
    name: "Plan du mécanisme",
    document_id: doc.id,
    filename: "plan.pdf",
    size: bytes.length,
    sha256: hash,
    label: "B",
  });
  await page.request.put(`/api/v1/uploads/${second.id}/content`, {
    data: bytes,
    headers: { Origin: origin, "Content-Length": String(bytes.length) },
  });
  await post(page, `uploads/${second.id}/complete`, {});
  const pointId = crypto.randomUUID();
  await post(page, `revisions/${doc.revision_id}/review-items`, {
    id: pointId,
    title: "Résistance du mécanisme",
    type: "discussion",
    page: 2,
    geometry: { points: [] },
  });
  const c = await conversation(page, "Références documentaires");
  await pane(page)
    .getByRole("button", { name: "Insérer une référence", exact: true })
    .click();
  const picker = page.getByRole("region", {
    name: "Insérer une référence",
    exact: true,
  });
  await picker
    .getByRole("combobox", { name: "Document", exact: true })
    .selectOption(doc.id);
  await picker
    .getByRole("combobox", { name: "Révision", exact: true })
    .selectOption(doc.revision_id);
  await picker
    .getByRole("combobox", { name: "Point technique", exact: true })
    .selectOption(pointId);
  await expect(
    picker.getByRole("spinbutton", { name: "Page", exact: true }),
  ).toHaveValue("2");
  await picker
    .getByRole("button", { name: "Ajouter la référence", exact: true })
    .click();
  const referenced = await send(page, "Vérifier la révision A, page 2.");
  await page
    .getByTestId(`message-${referenced.id}`)
    .getByRole("link")
    .filter({ hasText: "LC-001" })
    .click();
  const viewer = page.getByRole("dialog", {
    name: "Détails du document",
    exact: true,
  });
  await expect(
    viewer.getByRole("combobox", {
      name: "Historique des révisions",
      exact: true,
    }),
  ).toHaveValue(doc.revision_id);
  await expect(
    viewer.getByRole("spinbutton", { name: "Page", exact: true }),
  ).toHaveValue("2");
  await expect(viewer.locator("canvas")).toBeVisible();
  await expect(
    viewer.getByRole("heading", {
      name: "Résistance du mécanisme",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    viewer.getByRole("combobox", {
      name: "Historique des révisions",
      exact: true,
    }),
  ).toHaveValue(doc.revision_id);
  await expect(
    viewer.getByRole("spinbutton", { name: "Page", exact: true }),
  ).toHaveValue("2");
  await page.goto(`/projects/${project}/messages?conversation=${c}`);
  const evidencePdf = await PDFDocument.create();
  evidencePdf.addPage([220, 220]);
  const evidenceBytes = Buffer.from(await evidencePdf.save());
  await pane(page)
    .getByLabel("Joindre un fichier", { exact: true })
    .setInputFiles({
      name: "preuve.pdf",
      mimeType: "application/pdf",
      buffer: evidenceBytes,
    });
  await expect(pane(page)).toContainText("Pièce jointe prête");
  const attached = await send(page, "Résultat du contrôle qualité.");
  const card = page.getByTestId(`message-${attached.id}`);
  await expect(card).toContainText("preuve.pdf");
  const download = page.waitForEvent("download");
  await card
    .getByRole("link", { name: "Télécharger la pièce jointe", exact: true })
    .click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("preuve.pdf");
  const downloaded = await page.request.get(
    `/api/v1/message-attachments/${attached.attachments[0].id}/content?download=1`,
  );
  expect(Buffer.compare(await downloaded.body(), evidenceBytes)).toBe(0);
  await page
    .getByTestId(`message-${referenced.id}`)
    .getByRole("button", { name: "Créer une demande", exact: true })
    .click();
  const form = page.getByRole("dialog", {
    name: "Créer une demande",
    exact: true,
  });
  await form
    .getByRole("textbox", { name: "Titre de la demande", exact: true })
    .fill("Vérifier la résistance du support");
  await form
    .getByRole("combobox", { name: "Priorité", exact: true })
    .selectOption("high");
  await form.getByLabel("Échéance", { exact: true }).fill("2026-11-12");
  await form.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.goto(`/projects/${project}/requests`);
  await expect(page.getByRole("table")).toContainText(
    "Vérifier la résistance du support",
  );
  await page
    .getByRole("button", { name: "Modifier la demande", exact: true })
    .click();
  const edit = page.getByRole("dialog", {
    name: "Modifier la demande",
    exact: true,
  });
  await edit
    .getByRole("combobox", { name: "Statut", exact: true })
    .selectOption("in_progress");
  await edit.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page.getByRole("table")).toContainText("En cours");
  await page.reload();
  await expect(page.getByRole("table")).toContainText("En cours");
  await page
    .getByRole("combobox", { name: "Priorité", exact: true })
    .selectOption("low");
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Priorité", exact: true })
    .selectOption("high");
  await page
    .getByRole("link", { name: "Ouvrir la discussion d’origine", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Fil de discussion", exact: true }),
  ).toContainText("Vérifier la révision A, page 2.");
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Fil de discussion", exact: true }),
  ).toContainText("Vérifier la révision A, page 2.");
  await page.goto(`/projects/${project}/messages?conversation=${c}`);
  await expect(page.getByTestId(`message-${attached.id}`)).toContainText(
    "preuve.pdf",
  );
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5f8AAAAASUVORK5CYII=",
    "base64",
  );
  await pane(page)
    .getByLabel("Joindre un fichier", { exact: true })
    .setInputFiles({
      name: "apercu.png",
      mimeType: "image/png",
      buffer: image,
    });
  await expect(pane(page)).toContainText("Pièce jointe prête");
  const picture = await send(page, "Image du prototype");
  const pictureCard = page.getByTestId(`message-${picture.id}`);
  await expect(pictureCard.getByRole("img")).toHaveCount(0);
  await pictureCard
    .getByRole("button", { name: "Prévisualiser la pièce jointe", exact: true })
    .click();
  await expect(
    pictureCard.getByRole("img", { name: "apercu.png" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      pictureCard
        .getByRole("img")
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(1);
  expect(errors).toEqual([]);
});
test("failed sends preserve drafts, Enter sends once, Shift+Enter inserts a line, and private deletions retain history", async ({
  page,
}) => {
  test.setTimeout(60000);
  const project = await fixture(page, "RETRY");
  await conversation(page, "Gestion des erreurs");
  let fail = true;
  await page.route("**/api/v1/conversations/*/messages", async (route) => {
    if (route.request().method() === "POST" && fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Simulated temporary outage" }),
      });
    } else await route.continue();
  });
  const input = pane(page).getByRole("textbox", {
    name: "Rédiger un message",
    exact: true,
  });
  await input.fill("Décision à conserver");
  await input.press("Shift+Enter");
  await input.pressSequentially("Deuxième ligne");
  await input.press("Enter");
  await expect(pane(page).getByRole("alert")).toHaveText(
    "Simulated temporary outage",
  );
  await expect(input).toHaveValue("Décision à conserver\nDeuxième ligne");
  await input.press("Enter");
  await expect(
    pane(page).locator(".message-timeline .message-card"),
  ).toHaveCount(1);
  await expect(input).toHaveValue("");
  page.on("dialog", (dialog) => void dialog.accept());
  await pane(page)
    .getByRole("button", { name: "Supprimer le message", exact: true })
    .click();
  await expect(pane(page)).toContainText("Message privé supprimé");
  await pane(page)
    .getByRole("button", { name: "Historique des changements", exact: true })
    .click();
  await expect(pane(page)).toContainText("Message supprimé");
  await page
    .getByRole("searchbox", {
      name: "Rechercher dans les messages",
      exact: true,
    })
    .fill("Décision à conserver");
  await expect(
    page.getByRole("region", { name: "Résultats de recherche" }),
  ).toContainText("Aucun élément accessible pour le moment.");
  const api = await page.request.get(
    `/api/v1/projects/${project}/message-search?q=D%C3%A9cision`,
  );
  expect((await api.json()).items).toHaveLength(0);
});
