import { test, expect } from "@playwright/test";
test("real API/D1 workspace creates and persists an edited project across reloads", async ({
  page,
}) => {
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
  const organization = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Créer une organisation" }),
  });
  await organization
    .getByRole("textbox", { name: "Nom", exact: true })
    .fill("Persistent browser workspace");
  await organization
    .getByRole("button", { name: "Créer", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Organisation", exact: true }),
  ).toContainText("Persistent browser workspace");
  await page
    .getByRole("combobox", { name: "Organisation", exact: true })
    .selectOption({ label: "Persistent browser workspace" });
  await page.getByRole("link", { name: "Projets", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Projets", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Créer", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Code", exact: true })
    .fill("BROWSER-1");
  await page
    .getByRole("textbox", { name: "Nom", exact: true })
    .fill("Engineering enclosure");
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page.getByRole("table")).toContainText("Engineering enclosure");
  await page.reload();
  await expect(page.getByRole("table")).toContainText("Engineering enclosure");
  await page.getByRole("button", { name: "Modifier", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Nom", exact: true })
    .fill("Updated enclosure");
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page.getByRole("table")).toContainText("Updated enclosure");
  await page.reload();
  await expect(page.getByRole("table")).toContainText("Updated enclosure");
  await page
    .getByRole("combobox", { name: "Langue", exact: true })
    .selectOption("en");
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
});
