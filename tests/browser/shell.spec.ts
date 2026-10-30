import { test, expect } from "@playwright/test";
test("configuration state, language switching and persistent theme", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Accès privé requis" }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Langue", exact: true })
    .selectOption("en");
  await expect(
    page.getByRole("heading", { name: "Private access required" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  await expect(
    page.getByRole("heading", { name: "需要私有访问权限" }),
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

test("SPA entry points load directly and expose real JavaScript assets", async ({
  page,
}) => {
  for (const route of ["/", "/projects", "/admin", "/documents"]) {
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Accès privé requis" }),
    ).toBeVisible();
  }
  const script = page.locator('script[type="module"]').first();
  const src = await script.getAttribute("src");
  expect(src).toBeTruthy();
  const asset = await page.request.get(src!);
  expect(asset.ok()).toBe(true);
  expect(asset.headers()["content-type"]).toMatch(/javascript/);
});

test("public demo renders existing UI without any backend request", async ({
  page,
}) => {
  const apiCalls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/")) apiCalls.push(request.url());
  });
  await page.goto("/demo");
  await expect(
    page.getByText("Aperçu de démonstration", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Collection mobilier" }),
  ).toBeVisible();
  await page.goto("/demo/projects");
  await expect(page.getByText("FB-001", { exact: true }).first()).toBeVisible();
  await page.goto("/demo/admin");
  await expect(
    page.getByText("Visiteur démo", { exact: true }).first(),
  ).toBeVisible();
  expect(apiCalls).toEqual([]);
});
