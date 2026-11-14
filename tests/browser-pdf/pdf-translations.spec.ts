import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { technicalPdf } from "../helpers/technical-pdf";
const origin = "http://127.0.0.1:4191";
async function post(page: Page, path: string, data: unknown, method = "POST") {
  const r = await page.request.fetch(`/api/v1/${path}`, {
    method,
    headers: { Origin: origin },
    data,
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}
async function upload(
  page: Page,
  project: string,
  label: string,
  document?: string,
) {
  const bytes = await technicalPdf(label),
    sha = createHash("sha256").update(bytes).digest("hex");
  const reserved = await post(page, `projects/${project}/uploads`, {
    document_id: document ?? null,
    name: "Synthetic SolidWorks.pdf",
    filename: `Sheet-${label}.pdf`,
    label,
    size: bytes.length,
    sha256: sha,
  });
  const content = await page.request.put(
    `/api/v1/uploads/${reserved.id}/content`,
    {
      headers: { Origin: origin, "Content-Type": "application/octet-stream" },
      data: bytes,
    },
  );
  expect(content.ok(), await content.text()).toBeTruthy();
  const result = await post(page, `uploads/${reserved.id}/complete`, {});
  return { ...result, sha };
}
async function setup(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/admin");
  const org = await post(page, "organizations", {
      name: "PDF translation synthetic",
    }),
    project = await post(page, "projects", {
      organization_id: org.id,
      code: "PDFTR",
      name: "PDF translation synthetic",
    });
  await page.evaluate(
    (id) => localStorage.setItem("forgebridge.organization", id),
    org.id,
  );
  const a = await upload(page, project.id, "A");
  await page.goto(`/projects/${project.id}/documents`);
  await page
    .getByRole("button", { name: "Synthetic SolidWorks.pdf", exact: true })
    .click();
  await expect(page.locator(".pdf-sheet canvas")).toBeVisible();
  return { org, project, a };
}
const panel = (page: Page) => page.locator(".pdf-translation-panel");
async function target(page: Page, lang = "zh-CN", source = "en") {
  await page
    .getByLabel("Langue du document", { exact: true })
    .selectOption(lang);
  await page
    .getByLabel("Langue source du dessin", { exact: true })
    .selectOption(source);
  await expect(panel(page).locator(".pdf-note-list li").first()).toBeVisible();
}
async function translate(page: Page) {
  await panel(page)
    .getByRole("checkbox", { name: /J’autorise/ })
    .check();
  await panel(page)
    .getByRole("button", { name: "Traduire les notes manquantes", exact: true })
    .click();
  await expect(
    panel(page).getByRole("button", {
      name: "Traduire les notes manquantes",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(panel(page)).toContainText("去除锐边");
}
function audit(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (r.url().includes("/api/v1/") && r.status() >= 500)
      errors.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  return errors;
}
test("real PDF.js extracts a synthetic drawing, translates without altering bytes, aligns after zoom/rotation/resize, keeps annotations working, and restores original instantly", async ({
  page,
}, testInfo) => {
  const errors = audit(page),
    f = await setup(page);
  let calls = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/pdf-translate")) calls++;
  });
  await target(page);
  expect(calls).toBe(0);
  await expect(panel(page).locator(".pdf-note-list")).toContainText(
    "SURFACE FINISH 3 mm",
  );
  await translate(page);
  expect(calls).toBe(4);
  const badge = page.getByTestId("pdf-note-0");
  await expect(badge).toBeVisible();
  async function anchor() {
    return badge.evaluate((el) => {
      const sheet = el.closest(".pdf-sheet") as HTMLElement;
      return {
        left: parseFloat((el as HTMLElement).style.left),
        top: parseFloat((el as HTMLElement).style.top),
        w: parseFloat(sheet.style.width),
        h: parseFloat(sheet.style.height),
        angle: (el as HTMLElement).style.transform,
      };
    });
  }
  const first = await anchor();
  expect(first.left / first.w).toBeCloseTo(40 / 600, 2);
  expect(first.top / first.h).toBeCloseTo(80 / 400, 2);
  await page.getByRole("button", { name: "Zoom avant", exact: true }).click();
  await expect.poll(async () => (await anchor()).w).toBeGreaterThan(first.w);
  const zoom = await anchor();
  expect(zoom.left / zoom.w).toBeCloseTo(first.left / first.w, 3);
  await page
    .getByRole("button", { name: "Tourner de 90°", exact: true })
    .click();
  await expect.poll(async () => (await anchor()).angle).toContain("90deg");
  const rotated = await anchor();
  expect(rotated.left / rotated.w).toBeCloseTo(0.8, 2);
  expect(rotated.top / rotated.h).toBeCloseTo(40 / 600, 2);
  await page.setViewportSize({ width: 1200, height: 1000 });
  await expect.poll(async () => (await anchor()).w).not.toBe(rotated.w);
  await panel(page)
    .getByRole("checkbox", { name: /Afficher les étiquettes/ })
    .check();
  await expect(badge).toContainText("去除锐边");
  await page.locator(".pdf-sheet").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("synthetic-translated-rotated.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Rectangle", exact: true }).click();
  expect(await badge.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe(
    "none",
  );
  const box = await page.locator(".pdf-sheet").boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.3, box!.y + box!.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.4, box!.y + box!.height * 0.4);
  await page.mouse.up();
  await expect(
    page.getByTestId("annotation-layer").locator("[data-review-id]"),
  ).toHaveCount(1);
  const savedAnnotations = await (
    await page.request.get(
      `/api/v1/revisions/${f.a.revision_id}/annotations?page_number=1&page=0`,
    )
  ).json();
  expect(savedAnnotations.items).toHaveLength(1);
  await page
    .getByLabel("Langue du document", { exact: true })
    .selectOption("original");
  await expect(page.getByTestId("pdf-translation-layer")).toHaveCount(0);
  await target(page);
  await expect(badge).toBeVisible();
  expect(calls).toBe(4);
  const downloaded = await page.request.get(
    `/api/v1/revisions/${f.a.revision_id}/content`,
  );
  expect(
    createHash("sha256")
      .update(await downloaded.body())
      .digest("hex"),
  ).toBe(f.a.sha);
  const afterAnnotations = await (
    await page.request.get(
      `/api/v1/revisions/${f.a.revision_id}/annotations?page_number=1&page=0`,
    )
  ).json();
  expect(afterAnnotations.items).toEqual(savedAnnotations.items);
  await page
    .getByRole("button", { name: "Masquer les commentaires", exact: true })
    .click();
  for (let i = 0; i < 3; i++)
    await page
      .getByRole("button", { name: "Tourner de 90°", exact: true })
      .click();
  await page
    .getByRole("button", { name: "Ajuster à la page", exact: true })
    .click();
  await expect
    .poll(() => badge.evaluate((e) => (e as HTMLElement).style.transform))
    .toContain("0deg");
  await page
    .locator(".pdf-translation-layout")
    .screenshot({ path: testInfo.outputPath("synthetic-safe-side-panel.png") });

  await page.locator(".pdf-sheet").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("synthetic-original-and-annotations.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("verified corrections, personal offsets and cached translations survive reload without provider calls", async ({
  page,
}) => {
  const errors = audit(page);
  await setup(page);
  await target(page);
  await translate(page);
  await panel(page)
    .getByRole("textbox", { name: "Correction de la note", exact: true })
    .fill("清除锐边");
  await panel(page)
    .getByRole("button", {
      name: "Enregistrer une traduction vérifiée",
      exact: true,
    })
    .click();
  await expect(panel(page).locator(".pdf-note-list").first()).toContainText(
    "清除锐边",
  );
  const first = await page
    .getByTestId("pdf-note-0")
    .evaluate((e) => parseFloat((e as HTMLElement).style.left));
  await panel(page)
    .getByRole("group", { name: "Repositionner mon repère", exact: true })
    .getByRole("button", { name: "→", exact: true })
    .click();
  await expect
    .poll(() =>
      page
        .getByTestId("pdf-note-0")
        .evaluate((e) => parseFloat((e as HTMLElement).style.left)),
    )
    .toBeGreaterThan(first);
  await page.reload();
  await page
    .getByRole("button", { name: "Synthetic SolidWorks.pdf", exact: true })
    .click();
  await page.locator(".pdf-sheet canvas").waitFor();
  let providerCalls = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/pdf-translate")) providerCalls++;
  });
  await target(page);
  await expect(panel(page)).toContainText("清除锐边");
  expect(providerCalls).toBe(0);
  await panel(page)
    .getByRole("button", { name: "Historique des corrections", exact: true })
    .click();
  await expect(panel(page)).toContainText("1 correction(s) conservée(s)");
  expect(
    await page
      .getByTestId("pdf-note-0")
      .evaluate((e) => parseFloat((e as HTMLElement).style.left)),
  ).toBeGreaterThan(first);
  expect(errors).toEqual([]);
});
test("pages, intrinsic rotation, scanned pages, languages and revisions remain independent during rapid changes", async ({
  page,
}, testInfo) => {
  const errors = audit(page),
    f = await setup(page);
  await target(page);
  await translate(page);
  await page.getByRole("spinbutton", { name: "Page", exact: true }).fill("2");
  await expect(panel(page).locator(".pdf-note-list")).toContainText(
    "Enlever les arêtes",
  );
  await target(page, "en", "fr");
  await panel(page)
    .getByRole("button", { name: "Traduire les notes manquantes", exact: true })
    .click();
  await expect(panel(page).locator(".pdf-note-list")).toContainText(
    "REMOVE SHARP EDGES",
  );
  await page.getByRole("spinbutton", { name: "Page", exact: true }).fill("3");
  await expect(panel(page)).toContainText("Aucune note numérique exploitable");
  await expect(page.getByTestId("pdf-note-0")).toHaveCount(0);
  await page.getByRole("spinbutton", { name: "Page", exact: true }).fill("4");
  await target(page, "zh-CN", "en");
  await translate(page);
  await expect
    .poll(() =>
      page
        .getByTestId("pdf-note-0")
        .evaluate((e) => (e as HTMLElement).style.transform),
    )
    .toContain("90deg");
  await page.locator(".pdf-sheet").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("intrinsic-rotation.png"),
    fullPage: true,
  });
  const b = await upload(page, f.project.id, "B", f.a.id);
  await page.reload();
  await page
    .getByRole("button", { name: "Synthetic SolidWorks.pdf", exact: true })
    .click();
  await page.getByLabel("Langue du document", { exact: true }).waitFor();
  await target(page);
  await expect(panel(page).locator(".pdf-note-list")).not.toContainText(
    "去除锐边",
  );
  await expect(page.getByTestId("pdf-note-0")).toHaveCount(0);
  await page
    .getByLabel("Langue du document", { exact: true })
    .selectOption("fr");
  await page
    .getByLabel("Langue du document", { exact: true })
    .selectOption("zh-CN");
  await page
    .getByLabel("Langue du document", { exact: true })
    .selectOption("original");
  await expect(page.getByTestId("pdf-translation-layer")).toHaveCount(0);
  expect(b.revision_id).not.toBe(f.a.revision_id);
  expect(errors).toEqual([]);
});
test("supplier sees only the shared layer, proposes a correction for internal review and loses cached API/R2 access after withdrawal", async ({
  page,
  browser,
}) => {
  const errors = audit(page),
    f = await setup(page);
  await target(page);
  await page
    .getByLabel("Visibilité de la couche", { exact: true })
    .selectOption("shared");
  await expect(panel(page).locator(".pdf-note-list li").first()).toBeVisible();
  await translate(page);
  const sp = await post(page, "suppliers", {
    organization_id: f.org.id,
    name: "Synthetic PDF supplier",
    country: "CN",
    language: "zh-CN",
  });
  await post(page, `projects/${f.project.id}/suppliers`, {
    supplier_id: sp.id,
  });
  const invite = await post(
    page,
    `access/organizations/${f.org.id}/invitations`,
    {
      email: "pdf-supplier@example.test",
      role: "supplier_engineer",
      project_ids: [f.project.id],
      supplier_id: sp.id,
    },
  );
  await post(
    page,
    `access/documents/${f.a.id}/sharing`,
    { shared: true, revision_ids: [f.a.revision_id] },
    "PATCH",
  );
  const context = await browser.newContext({
      baseURL: origin,
      viewport: { width: 1600, height: 1200 },
    }),
    guest = await context.newPage();
  await context.request.post("/__test__/auth", {
    data: { actor: "pdf-supplier" },
  });
  await post(guest, "access/invitations/accept", {
    token: new URL(invite.invitation_url).hash.slice("#invitation=".length),
  });
  await guest.goto("/");
  await guest
    .getByRole("button", { name: /Synthetic SolidWorks.pdf.*A/ })
    .click();
  await expect(guest.locator(".pdf-sheet canvas")).toBeVisible();
  await target(guest);
  await expect(panel(guest)).toContainText("去除锐边");
  await expect(
    guest.getByLabel("Visibilité de la couche", { exact: true }),
  ).toHaveCount(0);
  await expect(
    panel(guest).getByRole("button", {
      name: "Enregistrer une traduction vérifiée",
      exact: true,
    }),
  ).toHaveCount(0);
  await panel(guest)
    .getByRole("textbox", { name: "Correction de la note", exact: true })
    .fill("建议去除锐边");
  await panel(guest)
    .getByRole("button", { name: "Proposer une correction", exact: true })
    .click();
  await expect(panel(guest)).toContainText("Correction proposée");
  await panel(page)
    .getByRole("button", { name: "Actualiser les notes", exact: true })
    .click();
  await expect(
    panel(page).getByRole("button", {
      name: "Valider cette proposition",
      exact: true,
    }),
  ).toBeVisible();
  await panel(page)
    .getByRole("button", { name: "Valider cette proposition", exact: true })
    .click();
  await panel(guest)
    .getByRole("button", { name: "Actualiser les notes", exact: true })
    .click();
  await expect(panel(guest).locator(".pdf-note-list")).toContainText(
    "建议去除锐边",
  );
  await expect(panel(guest)).toContainText("Traduction vérifiée");
  await post(
    page,
    `access/documents/${f.a.id}/sharing`,
    { shared: false, revision_ids: [] },
    "PATCH",
  );
  await panel(guest)
    .getByRole("button", { name: "Actualiser les notes", exact: true })
    .click();
  await expect(panel(guest).getByRole("alert")).toBeVisible();
  await expect(guest.getByTestId("pdf-note-0")).toHaveCount(0);
  expect(
    (
      await context.request.get(
        `/api/v1/collaboration/revisions/${f.a.revision_id}/content`,
      )
    ).status(),
  ).toBe(404);
  await context.close();
  expect(errors).toEqual([]);
});
