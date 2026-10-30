import { test, expect } from "@playwright/test";
function samplePdf(text: string) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 16 Tf 25 150 Td (${text}) Tj ET`;
  objects.push(
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  );
  objects.push(objects[2]);
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
      .join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
test("private library persists folders, R2 PDF originals and revisions through real UI", async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/admin");
  const org = page.locator("section").filter({
    has: page.getByRole("heading", {
      name: "Créer une organisation",
      exact: true,
    }),
  });
  await org
    .getByRole("textbox", { name: "Nom", exact: true })
    .fill("Document browser workspace");
  await org.getByRole("button", { name: "Créer", exact: true }).click();
  const orgSelector = page.getByRole("combobox", {
    name: "Organisation",
    exact: true,
  });
  await expect(orgSelector).toContainText("Document browser workspace");
  await orgSelector.selectOption({ label: "Document browser workspace" });
  await page.getByRole("link", { name: "Projets", exact: true }).click();
  await page.getByRole("button", { name: "Créer", exact: true }).click();
  await page.getByRole("textbox", { name: "Code", exact: true }).fill("DOCS-1");
  await page
    .getByRole("textbox", { name: "Nom", exact: true })
    .fill("Document project");
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await page.getByRole("link", { name: /Ouvrir les documents/ }).click();
  await page
    .getByRole("button", { name: "Nouveau dossier", exact: true })
    .click();
  const folderDialog = page.getByRole("dialog", {
    name: "Dossier",
    exact: true,
  });
  await folderDialog
    .getByRole("textbox", { name: "Nom", exact: true })
    .fill("Plans techniques");
  await folderDialog
    .getByRole("button", { name: "Enregistrer", exact: true })
    .click();
  await expect(folderDialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "Plans techniques", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole("navigation", { name: "Chemin du dossier" }),
  ).toContainText("Plans techniques");
  const pdf = samplePdf("Non confidential test - revision A");
  await page
    .getByLabel("Importer des documents", { exact: true })
    .setInputFiles({
      name: "mechanism.pdf",
      mimeType: "application/pdf",
      buffer: pdf,
    });
  await expect(
    page.getByRole("button", { name: "mechanism.pdf", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "mechanism.pdf", exact: true })
    .click();
  const detail = page.getByRole("dialog", { name: "Détails du document" });
  await expect(detail.locator("canvas")).toBeVisible();
  await expect
    .poll(() =>
      detail
        .locator("canvas")
        .evaluate((node: HTMLCanvasElement) => node.width),
    )
    .toBeGreaterThan(0);
  await expect(detail.getByRole("alert")).toHaveCount(0);
  await detail.getByRole("button", { name: "→", exact: true }).click();
  await expect(
    detail.getByRole("spinbutton", { name: "Page", exact: true }),
  ).toHaveValue("2");
  await detail.getByRole("button", { name: "←", exact: true }).click();
  await detail.getByRole("button", { name: "Zoom avant", exact: true }).click();
  await detail
    .getByRole("button", { name: "Ajuster à la page", exact: true })
    .click();
  await detail
    .getByRole("button", { name: "Ajuster à la largeur", exact: true })
    .click();
  await page.screenshot({ path: "test-results/phase2-pdf.png" });
  const download = page.waitForEvent("download");
  await detail.getByRole("link", { name: "Télécharger l’original" }).click();
  expect((await download).suggestedFilename()).toBe("mechanism.pdf");
  await detail
    .getByRole("textbox", { name: "Révision", exact: true })
    .fill("B");
  await detail
    .getByRole("textbox", { name: "Description des modifications" })
    .fill("Updated supports");
  await detail
    .getByLabel("Importer une nouvelle révision", { exact: true })
    .setInputFiles({
      name: "mechanism-B.pdf",
      mimeType: "application/pdf",
      buffer: samplePdf("Revision B"),
    });
  await expect(
    detail.getByRole("combobox", { name: "Historique des révisions" }),
  ).toContainText("B — Révision actuelle");
  await detail
    .getByRole("combobox", { name: "Historique des révisions" })
    .selectOption({ index: 1 });
  await expect(detail.getByRole("alert")).toHaveCount(0);
  await detail
    .getByRole("button", { name: "Retour à la bibliothèque" })
    .click();
  await page.reload();
  await page
    .getByRole("button", { name: "mechanism.pdf", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Historique des révisions" }),
  ).toContainText("mechanism-B.pdf");
  await detail
    .getByRole("button", { name: "Retour à la bibliothèque" })
    .click();
  await page
    .getByLabel("Importer des documents", { exact: true })
    .setInputFiles([
      {
        name: "test-image.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=",
          "base64",
        ),
      },
      {
        name: "test-part.step",
        mimeType: "application/step",
        buffer: Buffer.from(
          "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;",
        ),
      },
    ]);
  await expect(
    page.getByRole("button", { name: "test-image.png", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "test-part.step", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "test-image.png", exact: true })
    .click();
  await expect
    .poll(() =>
      detail
        .getByRole("img")
        .evaluate((node: HTMLImageElement) => node.naturalWidth),
    )
    .toBeGreaterThan(0);
  await detail.getByRole("button", { name: "Zoom avant", exact: true }).click();
  await detail
    .getByRole("button", { name: "Retour à la bibliothèque" })
    .click();
  await page
    .getByRole("button", { name: "test-part.step", exact: true })
    .click();
  await expect(
    detail.getByText(/Aperçu indisponible pour ce format technique/),
  ).toBeVisible();
  await detail
    .getByRole("button", { name: "Retour à la bibliothèque" })
    .click();
  let fail = true;
  await page.route("**/api/v1/uploads/*/content", async (route) => {
    if (fail) {
      fail = false;
      await route.abort();
    } else await route.continue();
  });
  await page
    .getByLabel("Importer des documents", { exact: true })
    .setInputFiles({
      name: "retry-plan.pdf",
      mimeType: "application/pdf",
      buffer: pdf,
    });
  await expect(
    page.getByRole("button", { name: "Réessayer", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Réessayer", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "retry-plan.pdf", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/phase2-library.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
