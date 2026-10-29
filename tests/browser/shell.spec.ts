import { test, expect } from "@playwright/test";
test("configuration state, language switching and persistent theme", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Configuration Supabase requise" }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Langue", exact: true })
    .selectOption("en");
  await expect(
    page.getByRole("heading", { name: "Supabase configuration required" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  await expect(
    page.getByRole("heading", { name: "需要配置 Supabase" }),
  ).toBeVisible();
});
test("mobile shell has no horizontal document overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
