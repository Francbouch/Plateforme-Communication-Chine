import fr from "../../apps/web/src/locales/fr-CA.json";
import { test, expect, type Page } from "@playwright/test";
import { PDFDocument } from "@cantoo/pdf-lib";
import type { ApprovalDetail } from "../../packages/shared/src/approvals";
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
async function upload(
  page: Page,
  project: string,
  bytes: Buffer,
  label: string,
  document_id?: string,
) {
  const u = await post(page, `projects/${project}/uploads`, {
    name: "Mécanisme certifié en interne",
    number: "APR-DOC",
    filename: "mechanism.pdf",
    size: bytes.length,
    sha256: Buffer.from(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ).toString("hex"),
    label,
    document_id: document_id ?? null,
  });
  const r = await page.request.put(`/api/v1/uploads/${u.id}/content`, {
    data: bytes,
    headers: { Origin: origin, "Content-Length": String(bytes.length) },
  });
  expect(r.ok()).toBeTruthy();
  return post(page, `uploads/${u.id}/complete`, {});
}
async function fixture(page: Page, suffix: string) {
  await page.goto("/admin");
  const org = await post(page, "organizations", {
    name: `Approvals ${suffix}`,
  });
  const project = await post(page, "projects", {
    organization_id: org.id,
    code: `AP-${suffix}`,
    name: `Approval project ${suffix}`,
  });
  await page.evaluate(
    (id) => localStorage.setItem("forgebridge.organization", id),
    org.id,
  );
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 3; i++) pdf.addPage([300, 300]);
  const bytes = Buffer.from(await pdf.save());
  const a = await upload(page, project.id, bytes, "A");
  const b = await upload(page, project.id, bytes, "B", a.id);
  return {
    project: project.id as string,
    document: a.id as string,
    a: a.revision_id as string,
    b: b.revision_id as string,
    bytes,
  };
}
function detail(page: Page) {
  return page.getByRole("region", {
    name: "Détails de l’approbation",
    exact: true,
  });
}
async function load(page: Page) {
  const id = new URL(page.url()).searchParams.get("approval")!;
  return (await (
    await page.request.get(`/api/v1/approvals/${id}`)
  ).json()) as ApprovalDetail;
}
async function saveDraft(
  page: Page,
  title: string,
  purpose = "internal_review",
) {
  const form = page.getByRole("dialog", {
    name: "Demander une approbation",
    exact: true,
  });
  await form
    .getByRole("textbox", { name: "Objet de l’approbation", exact: true })
    .fill(title);
  await form
    .getByRole("combobox", { name: "Usage de l’approbation", exact: true })
    .selectOption(purpose);
  await form
    .getByRole("button", { name: "Enregistrer le brouillon", exact: true })
    .click();
  await expect(detail(page).getByRole("heading").first()).toContainText(title);
  return (await load(page)).approval.id;
}
async function confirm(page: Page, comment = "") {
  const action = detail(page).locator("form.approval-action");
  if (comment)
    await action
      .getByRole("textbox", {
        name: "Commentaire ou justification",
        exact: true,
      })
      .fill(comment);
  await action.getByRole("checkbox").check();
  await action
    .getByRole("button", { name: "Confirmer et enregistrer", exact: true })
    .click();
  await expect(action).toHaveCount(0);
}
async function createFromRegister(
  page: Page,
  project: string,
  doc: string,
  revision: string,
  title: string,
) {
  await page.goto(`/projects/${project}/approvals`);
  await page
    .getByRole("button", { name: "Demander une approbation", exact: true })
    .click();
  const form = page.getByRole("dialog", {
    name: "Demander une approbation",
    exact: true,
  });
  await form
    .getByRole("button", { name: "Choisir une révision précise", exact: true })
    .click();
  const picker = form.getByRole("region", {
    name: "Insérer une référence",
    exact: true,
  });
  await picker
    .getByRole("combobox", { name: "Document", exact: true })
    .selectOption(doc);
  await picker
    .getByRole("combobox", { name: "Révision", exact: true })
    .selectOption(revision);
  await picker
    .getByRole("button", { name: "Ajouter la référence", exact: true })
    .click();
  return saveDraft(page, title);
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
test("approves exact B from the viewer, preserves it after reload, marks new C unsubmitted and old B historical", async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors = audit(page),
    f = await fixture(page, "MANUFACTURING");
  await page.goto(
    `/projects/${f.project}/documents?document=${f.document}&revision=${f.b}`,
  );
  const viewer = page.getByRole("dialog", {
    name: "Détails du document",
    exact: true,
  });
  await expect(viewer.locator("canvas")).toBeVisible();
  await viewer
    .getByRole("button", { name: "Demander une approbation", exact: true })
    .click();
  const approval = await saveDraft(
    page,
    "Validation du mécanisme avant prototype",
    "manufacturing",
  );
  await expect(detail(page)).toContainText("Brouillon");
  await detail(page)
    .getByRole("button", { name: "Soumettre la demande", exact: true })
    .click();
  await confirm(page);
  await expect(detail(page).locator(".badge").first()).toHaveText(
    "En attente d’approbation",
  );
  await detail(page)
    .getByRole("button", { name: "Approuver", exact: true })
    .click();
  await confirm(page, "Validation interne pour le prototype");
  await expect(detail(page).locator(".badge").first()).toHaveText("Approuvée");
  await page.reload();
  await expect(detail(page).locator(".badge").first()).toHaveText("Approuvée");
  const saved = await load(page);
  expect(saved.approval.revision_id).toBe(f.b);
  expect(saved.approval.decided_by).toBeTruthy();
  expect(saved.events.some((e) => e.action === "approval.approve")).toBe(true);
  await detail(page)
    .getByRole("link", { name: "Ouvrir la révision examinée", exact: true })
    .click();
  await expect(
    viewer.getByRole("combobox", {
      name: "Historique des révisions",
      exact: true,
    }),
  ).toHaveValue(f.b);
  await expect(viewer).toContainText(
    "Cette révision courante est approuvée en interne pour fabrication.",
  );
  const c = await upload(page, f.project, f.bytes, "C", f.document);
  await page.goto(
    `/projects/${f.project}/documents?document=${f.document}&revision=${c.revision_id}`,
  );
  const badge = page.getByRole("region", {
    name: "Approbation de cette révision",
    exact: true,
  });
  await expect(badge.getByText("Non soumise", { exact: true })).toHaveCount(2);
  await expect(badge).not.toContainText(
    "approuvée en interne pour fabrication",
  );
  await viewer
    .getByRole("combobox", { name: "Historique des révisions", exact: true })
    .selectOption(f.b);
  await expect(badge).toContainText("Une révision plus récente existe");
  await expect(badge).not.toContainText(
    "Cette révision courante est approuvée",
  );
  await page.goto(`/projects/${f.project}/approvals`);
  await expect(page.getByRole("table")).toContainText(
    "Validation du mécanisme avant prototype",
  );
  await page
    .getByRole("searchbox", { name: "Rechercher", exact: true })
    .fill("prototype");
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Approbations", exact: false })
    .filter({ hasText: "1" })
    .first()
    .click();
  await expect(page.getByRole("table")).toContainText("Approuvée");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: "/tmp/forgebridge-phase5-approvals.png",
    fullPage: true,
  });
  expect(
    (await (await page.request.get(`/api/v1/approvals/${approval}`)).json())
      .approval.status,
  ).toBe("approved");
  expect(errors).toEqual([]);
});
test("requires refusal reasons, cancels explicitly, resubmits a new cycle, links a point and requests changes without closing it", async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors = audit(page),
    f = await fixture(page, "CYCLES");
  const pointId = crypto.randomUUID();
  await post(page, `revisions/${f.b}/review-items`, {
    id: pointId,
    title: "Déplacer le trou",
    type: "discussion",
    page: 2,
    geometry: { points: [] },
  });
  const first = await createFromRegister(
    page,
    f.project,
    f.document,
    f.b,
    "Vérification des tolérances",
  );
  await detail(page)
    .getByRole("button", { name: "Soumettre la demande", exact: true })
    .click();
  await confirm(page);
  await detail(page)
    .getByRole("button", { name: "Refuser", exact: true })
    .click();
  const action = detail(page).locator("form.approval-action");
  await action.getByRole("checkbox").check();
  await action
    .getByRole("button", { name: "Confirmer et enregistrer", exact: true })
    .click();
  expect(
    await action
      .getByRole("textbox")
      .evaluate((e: HTMLTextAreaElement) => e.validity.valueMissing),
  ).toBe(true);
  expect((await load(page)).approval.status).toBe("pending");
  await confirm(page, "La tolérance ne respecte pas le besoin");
  await expect(detail(page).locator(".badge").first()).toHaveText("Refusée");
  await detail(page)
    .getByRole("button", { name: "Annuler avec justification", exact: true })
    .click();
  await confirm(page, "Réexamen requis après correction");
  await expect(detail(page).locator(".badge").first()).toHaveText("Annulée");
  await detail(page)
    .getByRole("button", { name: "Créer une nouvelle soumission", exact: true })
    .click();
  const successor = await saveDraft(page, "Deuxième cycle de contrôle");
  expect(successor).not.toBe(first);
  await detail(page)
    .getByRole("button", { name: "Soumettre la demande", exact: true })
    .click();
  await confirm(page);
  await detail(page)
    .getByRole("button", { name: "Demander des modifications", exact: true })
    .click();
  await detail(page)
    .locator("form.approval-action")
    .getByRole("button", { name: "Associer des points existants", exact: true })
    .click();
  const picker = page.getByRole("region", {
    name: "Insérer une référence",
    exact: true,
  });
  await picker
    .getByRole("combobox", { name: "Point technique", exact: true })
    .selectOption(pointId);
  await picker
    .getByRole("button", { name: "Ajouter la référence", exact: true })
    .click();
  await confirm(page, "Déplacer le trou de fixation de 2 mm");
  await expect(detail(page).locator(".badge").first()).toHaveText(
    "Modifications demandées",
  );
  await expect(detail(page)).toContainText("Déplacer le trou");
  const current = await load(page);
  expect(current.points.map((p) => p.id)).toEqual([pointId]);
  expect(current.approval.previous_id).toBe(first);
  const point = await (
    await page.request.get(`/api/v1/review-items/${pointId}`)
  ).json();
  expect(point.item.status).toBe("open");
  await detail(page)
    .locator(":scope > .message-references")
    .getByRole("link")
    .filter({ hasText: "#1 · Déplacer le trou" })
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
  ).toHaveValue(f.b);
  await expect(
    viewer.getByRole("spinbutton", { name: "Page", exact: true }),
  ).toHaveValue("2");
  await expect(
    viewer.getByRole("heading", { name: "Déplacer le trou", exact: true }),
  ).toBeVisible();
  await page.goto(`/projects/${f.project}/approvals`);
  await page
    .getByRole("button")
    .filter({ hasText: "Modifications demandées" })
    .first()
    .click();
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(1);
  await expect(page.getByRole("table")).toContainText("Deuxième cycle");
  await page.goto(`/projects/${f.project}/approvals?approval=${first}`);
  await expect(detail(page)).toContainText("Révision refusée");
  await expect(detail(page)).toContainText("Annulation avec justification");
  await expect(detail(page)).toContainText(
    "La tolérance ne respecte pas le besoin",
  );
  expect(errors).toEqual([]);
});
test("uses existing conversation and technical request context, displays decisions and preserves pending status after an API outage", async ({
  page,
}) => {
  test.setTimeout(120000);
  const f = await fixture(page, "CONTEXT");
  const conv = await post(page, `projects/${f.project}/conversations`, {
    title: "Préparation du prototype",
  });
  const message = await post(page, `conversations/${conv.id}/messages`, {
    id: crypto.randomUUID(),
    body: "Ça semble correct, vérifier avant fabrication.",
    references: [{ document_id: f.document, revision_id: f.b }],
  });
  const task = await post(page, `messages/${message.id}/requests`, {
    title: "Action technique existante",
  });
  await page.goto(`/projects/${f.project}/messages?conversation=${conv.id}`);
  const card = page.getByTestId(`message-${message.id}`);
  await card.locator(".message-approvals summary").click();
  await expect(card).toContainText(
    "Une discussion seule ne constitue pas une approbation officielle.",
  );
  await card
    .getByRole("button")
    .filter({ hasText: "Demander une approbation" })
    .click();
  const a = await saveDraft(page, "Décision formelle du prototype");
  await detail(page)
    .getByRole("button", { name: "Soumettre la demande", exact: true })
    .click();
  await confirm(page);
  let fail = true;
  await page.route(`**/api/v1/approvals/${a}/actions`, async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Simulated approval outage" }),
      });
    } else await route.continue();
  });
  await detail(page)
    .getByRole("button", { name: "Approuver", exact: true })
    .click();
  const form = detail(page).locator("form.approval-action");
  await form.getByRole("textbox").fill("Décision interne explicite");
  await form.getByRole("checkbox").check();
  await form
    .getByRole("button", { name: "Confirmer et enregistrer", exact: true })
    .click();
  await expect(detail(page).getByRole("alert")).toHaveText(fr.requestFailed);
  expect((await load(page)).approval.status).toBe("pending");
  await expect(form.getByRole("textbox")).toHaveValue(
    "Décision interne explicite",
  );
  await form
    .getByRole("button", { name: "Confirmer et enregistrer", exact: true })
    .click();
  await expect(detail(page).locator(".badge").first()).toHaveText("Approuvée");
  await detail(page)
    .getByRole("link", { name: "Ouvrir la discussion d’origine", exact: true })
    .click();
  const thread = page.getByRole("region", {
    name: "Fil de discussion",
    exact: true,
  });
  await thread.locator(".message-approvals summary").click();
  await expect(thread.locator(".message-approvals")).toContainText("Approuvée");
  await page.goto(`/projects/${f.project}/requests`);
  await page
    .getByRole("button", { name: "Demander une approbation", exact: true })
    .click();
  const create = page.getByRole("dialog", {
    name: "Demander une approbation",
    exact: true,
  });
  await create
    .getByRole("button", { name: "Choisir une révision précise", exact: true })
    .click();
  const picker = create.getByRole("region", {
    name: "Insérer une référence",
    exact: true,
  });
  await picker
    .getByRole("combobox", { name: "Document", exact: true })
    .selectOption(f.document);
  await picker
    .getByRole("combobox", { name: "Révision", exact: true })
    .selectOption(f.b);
  await picker
    .getByRole("button", { name: "Ajouter la référence", exact: true })
    .click();
  await saveDraft(page, "Validation de l’action existante");
  const linked = await load(page);
  expect(linked.approval.technical_request_id).toBe(task.id);
  const requests = await (
    await page.request.get(`/api/v1/projects/${f.project}/requests`)
  ).json();
  expect(requests.items).toHaveLength(1);
});
