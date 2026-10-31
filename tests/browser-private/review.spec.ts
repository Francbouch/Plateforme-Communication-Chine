import { test, expect, type Page } from "@playwright/test";
import {
  PDFDocument,
  StandardFonts,
  PDFArray,
  PDFRawStream,
  decodePDFRawStream,
  degrees,
} from "@cantoo/pdf-lib";
import { readFile } from "node:fs/promises";
import type { ReviewItem } from "../../packages/shared/src/review";
test.use({ actionTimeout: 10000 });
async function pdf(labels: string[], varied = false) {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  labels.forEach((text, i) => {
    const p = doc.addPage(varied && i === 2 ? [300, 400] : [300, 300]);
    if (varied && i === 2) {
      p.setCropBox(20, 10, 260, 380);
      p.setRotation(degrees(90));
    }
    p.drawText(text, { x: 30, y: 240, font, size: 14 });
  });
  return Buffer.from(await doc.save());
}
function contentText(doc: PDFDocument, page: number) {
  const streams = doc.getPage(page).node.Contents();
  return (streams instanceof PDFArray ? streams.asArray() : [streams])
    .map((ref) => doc.context.lookup(ref))
    .filter((s): s is PDFRawStream => s instanceof PDFRawStream)
    .map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString())
    .join("\n");
}
async function setup(page: Page, bytes: Buffer, suffix: string) {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/admin");
  const organization = page.locator("section").filter({
    has: page.getByRole("heading", {
      name: "Créer une organisation",
      exact: true,
    }),
  });
  await organization
    .getByRole("textbox", { name: "Nom", exact: true })
    .fill(`Review test ${suffix}`);
  await organization
    .getByRole("button", { name: "Créer", exact: true })
    .click();
  const selector = page.getByRole("combobox", {
    name: "Organisation",
    exact: true,
  });
  await expect(selector).toContainText(`Review test ${suffix}`);
  await selector.selectOption({ label: `Review test ${suffix}` });
  await page.getByRole("link", { name: "Projets", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Projets", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Créer", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Code", exact: true })
    .fill(`REVIEW-${suffix}`);
  await page
    .getByRole("textbox", { name: "Nom", exact: true })
    .fill(`Review project ${suffix}`);
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await page.getByRole("link", { name: /Ouvrir les documents/ }).click();
  const finished = page.waitForResponse(
    (r) =>
      r.url().includes("/uploads/") &&
      r.url().endsWith("/complete") &&
      r.request().method() === "POST",
  );
  await expect(
    page.getByLabel("Importer des documents", { exact: true }),
  ).toBeEnabled();
  await page
    .getByLabel("Importer des documents", { exact: true })
    .setInputFiles({
      name: "review-plan.pdf",
      mimeType: "application/pdf",
      buffer: bytes,
    });
  const result = (await (await finished).json()) as {
    id: string;
    revision_id: string;
  };
  await page
    .getByRole("button", { name: "review-plan.pdf", exact: true })
    .click();
  const viewer = page.getByRole("dialog", { name: "Détails du document" });
  await expect(viewer.locator("canvas")).toBeVisible();
  await expect(
    viewer.getByRole("spinbutton", { name: "Page", exact: true }),
  ).toHaveAttribute("max", "3");
  await viewer
    .getByRole("button", { name: "Ajuster à la page", exact: true })
    .click();
  return { viewer, document: result.id, revision: result.revision_id };
}
async function createShape(
  page: Page,
  tool: string,
  a: [number, number],
  b?: [number, number],
) {
  const viewer = page.getByRole("dialog", { name: "Détails du document" });
  await viewer.getByRole("button", { name: tool, exact: true }).click();
  const layer = viewer.getByTestId("annotation-layer");
  await layer.scrollIntoViewIfNeeded();
  const box = (await layer.boundingBox())!;
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      /\/revisions\/[^/]+\/annotations$/.test(new URL(r.url()).pathname),
  );
  await page.mouse.move(box.x + box.width * a[0], box.y + box.height * a[1]);
  await page.mouse.down();
  if (b)
    await page.mouse.move(box.x + box.width * b[0], box.y + box.height * b[1], {
      steps: 8,
    });
  await page.mouse.up();
  const r = await response;
  expect(r.status(), await r.text()).toBe(201);
  return r.json() as Promise<ReviewItem>;
}
function checkNetwork(page: Page) {
  const errors: string[] = [],
    expected = new Set<string>();
  let injected = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      m.type() === "error" &&
      !(
        m.text().includes("Failed to load resource") &&
        expected.has(m.location().url)
      )
    )
      errors.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400) {
      if (expected.has(r.url()) && r.status() === 503) injected++;
      else errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
    }
  });
  return {
    errors,
    expected,
    get injected() {
      return injected;
    },
  };
}
test("free drawings, multi-selection, one point, publication and persistent discussion", async ({
  page,
}) => {
  test.setTimeout(120000);
  const audit = checkNetwork(page),
    { viewer, document, revision } = await setup(
      page,
      await pdf(["A", "B", "C"]),
      "SEPARATE",
    );
  const arrow = await createShape(page, "Flèche", [0.2, 0.2], [0.4, 0.4]);
  const rectangle = await createShape(
    page,
    "Rectangle",
    [0.5, 0.2],
    [0.7, 0.4],
  );
  const text = await createShape(page, "Texte", [0.3, 0.6]);
  await viewer
    .getByRole("textbox", { name: "Note sur le plan", exact: true })
    .fill("+2 mm");
  await viewer
    .getByRole("button", { name: "Enregistrer le dessin", exact: true })
    .click();
  await expect(viewer.getByTestId(`annotation-${text.id}`)).toContainText(
    "+2 mm",
  );
  const panel = viewer.getByRole("region", {
    name: "Points techniques et commentaires",
  });
  expect(
    (
      await (
        await page.request.get(`/api/v1/documents/${document}/review-items`)
      ).json()
    ).items,
  ).toHaveLength(0);
  await viewer.getByRole("button", { name: "Sélection", exact: true }).click();
  await viewer
    .getByTestId(`annotation-${arrow.id}`)
    .locator("line")
    .last()
    .click({ modifiers: ["Control"] });
  await viewer
    .getByTestId(`annotation-${rectangle.id}`)
    .locator("rect")
    .click({ position: { x: 1, y: 1 }, modifiers: ["Control"] });
  // Text was selected on creation; Ctrl-click adds the other two without moving any drawing.
  await expect(
    panel.getByText("3 annotation(s) sélectionnée(s) · page 1/3", {
      exact: true,
    }),
  ).toBeVisible();
  await panel.getByText("Créer un point technique", { exact: true }).click();
  await panel
    .getByRole("textbox", { name: "Titre du point", exact: true })
    .fill("Move hole 2 mm");
  await panel
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Check the drilling tolerance");
  const created = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith(`/revisions/${revision}/review-items`),
  );
  await panel
    .getByRole("button", { name: "Créer le brouillon", exact: true })
    .click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(201);
  const point = await response.json();
  expect(point.annotation_count).toBe(3);
  expect(point.number).toBe(1);
  await expect(panel.getByTestId(`point-${point.id}`)).toContainText(
    "3 annotations",
  );
  await panel
    .getByRole("textbox", { name: "Réponse", exact: true })
    .fill("Confirmed with manufacturing");
  await panel
    .getByRole("button", { name: "Envoyer la réponse", exact: true })
    .click();
  await expect(
    panel
      .locator(".review-message")
      .getByText("Confirmed with manufacturing", { exact: true }),
  ).toBeVisible();
  await panel
    .getByRole("button", { name: "Détacher", exact: true })
    .first()
    .click();
  await expect(panel.getByTestId(`point-${point.id}`)).toContainText(
    "2 annotations",
  );
  await panel
    .getByRole("button", { name: "Publier le point", exact: true })
    .click();
  await expect(panel.getByTestId(`point-${point.id}`)).toContainText("#001");
  page.once("dialog", (d) => d.accept());
  await panel
    .getByRole("button", { name: "Annuler le point", exact: true })
    .click();
  await expect(panel.getByTestId(`point-${point.id}`)).toContainText("Annulé");
  await panel.getByRole("button", { name: "Annotations", exact: true }).click();
  await panel
    .getByRole("button", { name: "Désélectionner", exact: true })
    .click();
  const free = await createShape(page, "Marqueur", [0.8, 0.6]);
  page.once("dialog", (d) => d.accept());
  await panel
    .getByRole("button", { name: "Supprimer l’annotation", exact: true })
    .click();
  await expect(viewer.getByTestId(`annotation-${free.id}`)).toHaveCount(0);
  await viewer.getByRole("button", { name: "Sélection", exact: true }).click();
  await viewer.getByTestId(`annotation-${text.id}`).click();
  await panel.getByRole("button", { name: "Annotations", exact: true }).click();
  page.once("dialog", (d) => d.accept());
  await panel
    .getByRole("button", { name: "Supprimer l’annotation", exact: true })
    .click();
  await expect(viewer.getByTestId(`annotation-${text.id}`)).toHaveCount(0);
  const detail = await (
    await page.request.get(`/api/v1/review-items/${point.id}`)
  ).json();
  expect(detail.messages).toHaveLength(1);
  expect(detail.annotations).toHaveLength(1);
  await panel
    .getByRole("button", { name: "Désélectionner", exact: true })
    .click();
  await panel
    .getByRole("textbox", { name: "Titre du point", exact: true })
    .fill("Accidental draft");
  await panel
    .getByRole("button", { name: "Créer le brouillon", exact: true })
    .click();
  page.once("dialog", (d) => d.accept());
  await panel
    .getByRole("button", { name: "Supprimer le brouillon", exact: true })
    .click();
  await expect(
    panel.getByText("Accidental draft", { exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await page
    .getByRole("button", { name: "review-plan.pdf", exact: true })
    .click();
  await expect(page.getByTestId(`annotation-${arrow.id}`)).toBeVisible();
  await expect(page.getByTestId(`annotation-${free.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`point-${point.id}`)).toContainText("Annulé");
  expect(audit.errors).toEqual([]);
});

test("PDF page replacement: preview, validation, full new revision and preserved originals", async ({
  page,
}) => {
  test.setTimeout(90000);
  const audit = checkNetwork(page),
    original = await pdf(["ORIGINAL ONE", "ORIGINAL TWO", "ORIGINAL THREE"]),
    { viewer, revision } = await setup(page, original, "REPLACEMENT");
  await viewer.getByText("Remplacer des pages du PDF", { exact: true }).click();
  const replace = viewer.locator(".page-replacement");
  await replace
    .getByRole("textbox", { name: "Pages à remplacer", exact: true })
    .fill("2");
  await replace
    .getByLabel("PDF des nouvelles pages", { exact: true })
    .setInputFiles({
      name: "new-page.pdf",
      mimeType: "application/pdf",
      buffer: await pdf(["REPLACED SUPPORT 8 MM"]),
    });
  await replace
    .getByRole("button", { name: "Préparer l’aperçu", exact: true })
    .click();
  await expect(
    replace.getByRole("heading", {
      name: "Aperçu de la nouvelle révision",
      exact: true,
    }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await replace
    .getByRole("link", { name: "Télécharger l’original", exact: true })
    .click();
  const result = await download;
  const preview = await PDFDocument.load(
    await readFile((await result.path())!),
  );
  expect(preview.getPageCount()).toBe(3);
  expect(contentText(preview, 1)).toContain(
    Buffer.from("REPLACED SUPPORT 8 MM").toString("hex").toUpperCase(),
  );
  await replace
    .getByRole("textbox", {
      name: "Numéro de la nouvelle révision",
      exact: true,
    })
    .fill("PAGES-B");
  await replace
    .getByRole("textbox", {
      name: "Description des modifications",
      exact: true,
    })
    .fill("Only the support page was replaced");
  page.once("dialog", (d) => d.accept());
  const completed = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/complete"),
  );
  await replace
    .getByRole("button", {
      name: "Confirmer et enregistrer la nouvelle révision",
      exact: true,
    })
    .click();
  const latest = await (await completed).json();
  await expect(
    viewer.getByRole("combobox", { name: "Historique des révisions" }),
  ).toHaveValue(latest.revision_id);
  const stored = await PDFDocument.load(
    await (
      await page.request.get(`/api/v1/revisions/${latest.revision_id}/content`)
    ).body(),
  );
  const source = await PDFDocument.load(original);
  expect(stored.getPageCount()).toBe(3);
  expect(contentText(stored, 0)).toBe(contentText(source, 0));
  expect(contentText(stored, 2)).toBe(contentText(source, 2));
  expect(contentText(stored, 1)).toContain(
    Buffer.from("REPLACED SUPPORT 8 MM").toString("hex").toUpperCase(),
  );
  expect(
    Buffer.from(
      await (
        await page.request.get(`/api/v1/revisions/${revision}/content`)
      ).body(),
    ),
  ).toEqual(original);
  await page.reload();
  await page
    .getByRole("button", { name: "review-plan.pdf", exact: true })
    .click();
  await expect(
    viewer.getByRole("combobox", { name: "Historique des révisions" }),
  ).toHaveValue(latest.revision_id);
  await viewer.getByText("Remplacer des pages du PDF", { exact: true }).click();
  await replace
    .getByRole("textbox", { name: "Pages à remplacer", exact: true })
    .fill("1,3");
  await replace
    .getByLabel("PDF des nouvelles pages", { exact: true })
    .setInputFiles({
      name: "bad-count.pdf",
      mimeType: "application/pdf",
      buffer: await pdf(["Only one page"]),
    });
  await replace
    .getByRole("button", { name: "Préparer l’aperçu", exact: true })
    .click();
  await expect(replace.getByRole("alert")).toContainText("exactement une page");
  expect(audit.errors).toEqual([]);
});

test("drawing tools retain geometry across editing, zoom, rotation and a retryable save failure", async ({
  page,
}) => {
  test.setTimeout(90000);
  const { viewer, document, revision } = await setup(
    page,
    await pdf(["ONE", "TWO", "THREE"], true),
    "GEOMETRY",
  );
  const rectangle = await createShape(
    page,
    "Rectangle",
    [0.1, 0.1],
    [0.3, 0.3],
  );
  await createShape(page, "Surlignage", [0.5, 0.5], [0.7, 0.6]);
  await createShape(page, "Dessin libre", [0.3, 0.6], [0.4, 0.8]);
  const marker = await createShape(page, "Marqueur", [0.7, 0.2]);
  await viewer.getByRole("button", { name: "Sélection", exact: true }).click();
  const shape = viewer.getByTestId(`annotation-${marker.id}`);
  await shape.click();
  const circle = await shape.locator("circle").boundingBox();
  const moved = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      r.url().endsWith(`/annotations/${marker.id}`),
  );
  await page.mouse.move(
    circle!.x + circle!.width / 2,
    circle!.y + circle!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    circle!.x + circle!.width / 2 + 30,
    circle!.y + circle!.height / 2 + 20,
    { steps: 5 },
  );
  await page.mouse.up();
  const result = await moved;
  expect(result.ok(), await result.text()).toBe(true);
  const saved = await result.json();
  expect(saved.geometry).not.toEqual(marker.geometry);
  await viewer
    .getByTestId(`annotation-${rectangle.id}`)
    .locator("rect")
    .click({ position: { x: 1, y: 1 } });
  const handle = viewer.getByTestId("annotation-resize"),
    box = await handle.boundingBox();
  const resized = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      r.url().endsWith(`/annotations/${rectangle.id}`),
  );
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box!.x + box!.width / 2 + 25,
    box!.y + box!.height / 2 + 15,
    { steps: 5 },
  );
  await page.mouse.up();
  expect((await resized).ok()).toBe(true);
  await viewer.getByRole("button", { name: "Zoom avant", exact: true }).click();
  await viewer
    .getByRole("button", { name: "Tourner de 90°", exact: true })
    .click();
  await expect(shape).toBeVisible();
  const rows = await (
    await page.request.get(
      `/api/v1/revisions/${revision}/annotations?page_number=1`,
    )
  ).json();
  expect(
    rows.items.find((i: ReviewItem) => i.id === marker.id).geometry,
  ).toEqual(saved.geometry);
  let failed = false;
  await page.route(
    `**/api/v1/revisions/${revision}/annotations`,
    async (route) => {
      if (route.request().method() === "POST" && !failed) {
        failed = true;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Simulated save failure" }),
        });
      } else await route.continue();
    },
  );
  await viewer.getByRole("button", { name: "Marqueur", exact: true }).click();
  await viewer
    .getByTestId("annotation-layer")
    .click({ position: { x: 100, y: 100 } });
  await expect(
    viewer.getByText(
      "Annotation non enregistrée. Réessayez avant de quitter cette page.",
      { exact: true },
    ),
  ).toBeVisible();
  await viewer.getByRole("button", { name: "Réessayer", exact: true }).click();
  await expect(viewer.getByTestId("annotation-draft")).toHaveCount(0);
  const points = await (
    await page.request.get(`/api/v1/documents/${document}/review-items`)
  ).json();
  expect(points.items).toHaveLength(0);
  const after = await (
    await page.request.get(
      `/api/v1/revisions/${revision}/annotations?page_number=1`,
    )
  ).json();
  expect(after.items).toHaveLength(5);
  await page.reload();
  await page
    .getByRole("button", { name: "review-plan.pdf", exact: true })
    .click();
  await expect(page.getByTestId(`annotation-${marker.id}`)).toBeVisible();
});
