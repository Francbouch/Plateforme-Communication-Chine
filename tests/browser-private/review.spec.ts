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
      /\/revisions\/[^/]+\/review-items$/.test(new URL(r.url()).pathname),
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
async function ratio(page: Page, id: string) {
  return page.getByTestId(`annotation-${id}`).evaluate((node) => {
    const circle = node.querySelector("circle")!.getBoundingClientRect(),
      svg = node.closest("svg")!.getBoundingClientRect();
    return [
      (circle.x + circle.width / 2 - svg.x) / svg.width,
      (circle.y + circle.height / 2 - svg.y) / svg.height,
    ];
  });
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
test("PDF technical review: annotations, discussions, geometry, persistence, revisions and save retry", async ({
  page,
}) => {
  test.setTimeout(120000);
  const audit = checkNetwork(page),
    original = await pdf(["Page one", "Page two", "Page three rotated"], true),
    { viewer, document, revision } = await setup(page, original, "ANNOTATIONS");
  await viewer.getByRole("spinbutton", { name: "Page", exact: true }).fill("3");
  await expect(
    viewer.getByRole("spinbutton", { name: "Page", exact: true }),
  ).toHaveValue("3");
  // Wait for page-specific SVG aspect ratio, including intrinsic crop and rotation.
  await expect
    .poll(async () => {
      const b = await viewer.getByTestId("annotation-layer").boundingBox();
      return b!.width / b!.height;
    })
    .toBeCloseTo(380 / 260, 1);
  const marker = await createShape(page, "Marqueur", [0.22, 0.22]);
  expect(marker.page).toBe(3);
  expect(marker.number).toBe(1);
  const panel = viewer.getByRole("region", {
    name: "Points techniques et commentaires",
  });
  await panel
    .getByRole("textbox", { name: "Commentaire du point", exact: true })
    .fill("Increase this hole to 8 mm");
  await panel
    .getByRole("button", { name: "Enregistrer le point", exact: true })
    .click();
  await expect(panel.getByTestId(`point-${marker.id}`)).toContainText(
    "Increase this hole to 8 mm",
  );
  await viewer
    .getByRole("button", { name: "Retour à la bibliothèque" })
    .click();
  await page.reload();
  await page
    .getByRole("button", { name: "review-plan.pdf", exact: true })
    .click();
  await viewer.getByRole("spinbutton", { name: "Page", exact: true }).fill("3");
  await expect(viewer.getByTestId(`annotation-${marker.id}`)).toBeVisible();
  await panel.getByTestId(`point-${marker.id}`).getByRole("button").click();
  await expect(
    panel.getByRole("textbox", { name: "Commentaire du point", exact: true }),
  ).toHaveValue("Increase this hole to 8 mm");
  const before = await ratio(page, marker.id);
  const oldWidth = (await viewer.getByTestId("annotation-layer").boundingBox())!
    .width;
  await viewer.getByRole("button", { name: "Zoom avant", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await viewer.getByTestId("annotation-layer").boundingBox())!.width,
    )
    .toBeGreaterThan(oldWidth * 1.1);
  const after = await ratio(page, marker.id);
  expect(after[0]).toBeCloseTo(before[0], 2);
  expect(after[1]).toBeCloseTo(before[1], 2);
  await viewer
    .getByRole("button", { name: "Ajuster à la page", exact: true })
    .click();
  await viewer
    .getByRole("button", { name: "Plein écran", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => !!window.document.fullscreenElement))
    .toBe(true);
  const full = await ratio(page, marker.id);
  expect(full[0]).toBeCloseTo(before[0], 2);
  expect(full[1]).toBeCloseTo(before[1], 2);
  await viewer
    .getByRole("button", { name: "Quitter le plein écran", exact: true })
    .click();
  const rectangle = await createShape(
    page,
    "Rectangle",
    [0.35, 0.35],
    [0.55, 0.55],
  );
  await expect(
    panel.getByRole("heading", {
      name: `#${String(rectangle.number).padStart(3, "0")}`,
      exact: true,
    }),
  ).toBeVisible();
  let rectangleWrites = 0;
  page.on("request", (r) => {
    if (
      r.method() === "PATCH" &&
      r.url().endsWith(`/review-items/${rectangle.id}`)
    )
      rectangleWrites++;
  });
  const rect = viewer.getByTestId(`annotation-${rectangle.id}`).locator("rect"),
    box = (await rect.boundingBox())!;
  const movedResponse = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      r.url().endsWith(`/review-items/${rectangle.id}`),
  );
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 35,
    box.y + box.height / 2 + 25,
    { steps: 6 },
  );
  await page.mouse.up();
  const moved = (await (await movedResponse).json()) as ReviewItem;
  expect(moved.geometry).not.toEqual(rectangle.geometry);
  expect(rectangleWrites).toBe(1);
  await viewer.getByTestId("annotation-resize").scrollIntoViewIfNeeded();
  const handle = (await viewer.getByTestId("annotation-resize").boundingBox())!;
  const resizedResponse = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      r.url().endsWith(`/review-items/${rectangle.id}`),
  );
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2 + 18,
    handle.y + handle.height / 2 + 15,
    { steps: 4 },
  );
  await page.mouse.up();
  const resized = (await (await resizedResponse).json()) as ReviewItem;
  expect(resized.geometry).not.toEqual(moved.geometry);
  expect(rectangleWrites).toBe(2);
  await page.reload();
  await page
    .getByRole("button", { name: "review-plan.pdf", exact: true })
    .click();
  await viewer.getByRole("spinbutton", { name: "Page", exact: true }).fill("3");
  await expect(viewer.getByTestId(`annotation-${rectangle.id}`)).toBeVisible();
  const saved = await (
    await page.request.get(`/api/v1/review-items/${rectangle.id}`)
  ).json();
  expect(saved.item.geometry).toEqual(resized.geometry);
  await createShape(page, "Flèche", [0.1, 0.62], [0.22, 0.72]);
  const text = await createShape(page, "Texte", [0.6, 0.22]);
  await panel
    .getByRole("textbox", { name: "Note sur le plan", exact: true })
    .fill("CHECK TOLERANCE");
  await panel
    .getByRole("button", { name: "Enregistrer le point", exact: true })
    .click();
  await expect(viewer.getByTestId(`annotation-${text.id}`)).toContainText(
    "CHECK TOLERANCE",
  );
  await createShape(page, "Dessin libre", [0.6, 0.62], [0.76, 0.75]);
  await createShape(page, "Surlignage", [0.1, 0.8], [0.24, 0.86]);
  await panel.getByTestId(`point-${marker.id}`).getByRole("button").click();
  await viewer.getByTestId(`annotation-${marker.id}`).click();
  await expect(
    panel.getByRole("textbox", { name: "Commentaire du point", exact: true }),
  ).toHaveValue("Increase this hole to 8 mm");
  await panel
    .getByRole("textbox", { name: "Réponse", exact: true })
    .fill("Modified in revision B");
  await panel
    .getByRole("button", { name: "Envoyer la réponse", exact: true })
    .click();
  await expect(
    panel.getByText("Modified in revision B", { exact: true }),
  ).toBeVisible();
  await panel
    .getByRole("button", { name: "Modifier la réponse", exact: true })
    .click();
  const reply = panel.locator(".review-message");
  await reply
    .getByRole("textbox", { name: "Réponse", exact: true })
    .fill("Modified and verified in revision B");
  await reply.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(
    panel.getByText("Modified and verified in revision B", { exact: true }),
  ).toBeVisible();
  await panel
    .getByRole("combobox", { name: "Couleur", exact: true })
    .selectOption("blue");
  await panel
    .getByRole("button", { name: "Enregistrer le point", exact: true })
    .click();
  await expect(
    viewer.getByTestId(`annotation-${marker.id}`).locator("circle"),
  ).toHaveAttribute("stroke", "#2563eb");
  await panel
    .getByRole("combobox", { name: "Statut du point", exact: true })
    .selectOption("resolved");
  await panel
    .getByRole("button", { name: "Enregistrer le point", exact: true })
    .click();
  await expect(panel.getByTestId(`point-${marker.id}`)).toHaveCount(0);
  await panel
    .getByRole("checkbox", { name: "Masquer les points résolus", exact: true })
    .uncheck();
  await expect(panel.getByTestId(`point-${marker.id}`)).toBeVisible();
  await viewer.getByRole("spinbutton", { name: "Page", exact: true }).fill("1");
  await panel.getByTestId(`point-${marker.id}`).getByRole("button").click();
  await expect(
    viewer.getByRole("spinbutton", { name: "Page", exact: true }),
  ).toHaveValue("3");
  await expect(viewer.getByTestId(`annotation-${marker.id}`)).toBeVisible();
  await panel
    .getByText("Nouveau commentaire sans annotation", { exact: true })
    .click();
  await panel
    .getByRole("textbox", { name: "Commentaire", exact: true })
    .fill("General note on page two");
  await panel
    .getByRole("spinbutton", { name: "Page du commentaire", exact: true })
    .fill("2");
  await panel
    .getByRole("button", { name: "Ajouter le commentaire", exact: true })
    .click();
  await expect(panel.locator(".review-list")).toContainText(
    "General note on page two",
  );
  await panel
    .getByRole("spinbutton", { name: "Filtrer par page", exact: true })
    .fill("3");
  await expect(panel.locator(".review-list")).not.toContainText(
    "General note on page two",
  );
  await panel
    .getByRole("spinbutton", { name: "Filtrer par page", exact: true })
    .fill("");
  await panel.getByTestId(`point-${marker.id}`).getByRole("button").click();
  await panel.getByText("Historique du point", { exact: true }).click();
  await expect(
    panel.locator(".review-event").filter({ hasText: "Résolue" }),
  ).toBeVisible();
  const rotateGeometry = (
    await (await page.request.get(`/api/v1/review-items/${marker.id}`)).json()
  ).item.geometry;
  await viewer
    .getByRole("button", { name: "Tourner de 90°", exact: true })
    .click();
  expect(
    (await (await page.request.get(`/api/v1/review-items/${marker.id}`)).json())
      .item.geometry,
  ).toEqual(rotateGeometry);
  await page.screenshot({
    path: "test-results/phase3-annotations.png",
    fullPage: true,
  });
  await viewer
    .getByRole("textbox", { name: "Révision", exact: true })
    .fill("B");
  const complete = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/complete"),
  );
  await viewer
    .getByLabel("Importer une nouvelle révision", { exact: true })
    .setInputFiles({
      name: "review-B.pdf",
      mimeType: "application/pdf",
      buffer: await pdf(["New one", "New two", "New three"]),
    });
  const b = await (await complete).json();
  await expect(
    viewer.getByRole("combobox", { name: "Historique des révisions" }),
  ).toHaveValue(b.revision_id);
  await expect(viewer.locator("[data-review-id]")).toHaveCount(0);
  expect(
    (
      await (
        await page.request.get(
          `/api/v1/revisions/${b.revision_id}/annotations?page_number=3`,
        )
      ).json()
    ).items,
  ).toHaveLength(0);
  await viewer
    .getByRole("combobox", { name: "Historique des révisions" })
    .selectOption(revision);
  await viewer.getByRole("spinbutton", { name: "Page", exact: true }).fill("3");
  await expect(viewer.getByTestId(`annotation-${marker.id}`)).toBeVisible();
  expect(
    (await (await page.request.get(`/api/v1/review-items/${marker.id}`)).json())
      .messages[0].body,
  ).toBe("Modified and verified in revision B");
  expect(
    Buffer.from(
      await (
        await page.request.get(`/api/v1/revisions/${revision}/content`)
      ).body(),
    ),
  ).toEqual(original);
  await viewer
    .getByRole("combobox", { name: "Historique des révisions" })
    .selectOption(b.revision_id);
  let fail = true;
  await page.route("**/api/v1/revisions/*/review-items", async (route) => {
    if (fail && route.request().method() === "POST") {
      fail = false;
      audit.expected.add(route.request().url());
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Deliberate isolated save failure" }),
      });
    } else await route.continue();
  });
  await viewer.getByRole("button", { name: "Marqueur", exact: true }).click();
  await viewer
    .getByTestId("annotation-layer")
    .click({ position: { x: 50, y: 50 } });
  await expect(
    viewer.getByText("Annotation non enregistrée.", { exact: false }),
  ).toBeVisible();
  expect(
    (
      await (
        await page.request.get(
          `/api/v1/documents/${document}/review-items?revision_id=${b.revision_id}`,
        )
      ).json()
    ).items,
  ).toHaveLength(0);
  await viewer.getByRole("button", { name: "Réessayer", exact: true }).click();
  await expect(viewer.getByTestId("annotation-draft")).toHaveCount(0);
  expect(
    (
      await (
        await page.request.get(
          `/api/v1/documents/${document}/review-items?revision_id=${b.revision_id}`,
        )
      ).json()
    ).items,
  ).toHaveLength(1);
  const newPoint = (
    await (
      await page.request.get(
        `/api/v1/documents/${document}/review-items?revision_id=${b.revision_id}`,
      )
    ).json()
  ).items[0] as ReviewItem;
  page.once("dialog", (d) => d.accept());
  await panel
    .getByRole("button", { name: "Supprimer l’annotation", exact: true })
    .click();
  await expect(viewer.getByTestId(`annotation-${newPoint.id}`)).toHaveCount(0);
  expect(
    (
      await (
        await page.request.get(`/api/v1/review-items/${newPoint.id}`)
      ).json()
    ).item.annotation_deleted_at,
  ).toBeTruthy();
  const subsequent = await createShape(page, "Marqueur", [0.45, 0.25]);
  expect(subsequent.number).toBe(newPoint.number + 1);
  expect(audit.injected).toBe(1);
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
