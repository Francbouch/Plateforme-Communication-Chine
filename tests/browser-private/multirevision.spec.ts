import { test, expect, type Page, type Locator } from "@playwright/test";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import type { ReviewItem } from "../../packages/shared/src/review";
const origin = "http://127.0.0.1:4191";
async function makePdf(label: string, pages: number) {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++)
    doc
      .addPage([300, 300])
      .drawText(`${label} page ${i + 1}`, { x: 20, y: 240, font, size: 16 });
  return Buffer.from(await doc.save());
}
async function post(page: Page, path: string, body: unknown) {
  const response = await page.request.post(`/api/v1/${path}`, {
    headers: { Origin: origin },
    data: body,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function upload(
  page: Page,
  project: string,
  label: string,
  pages: number,
  document?: string,
) {
  const bytes = await makePdf(label, pages),
    sha = await import("node:crypto").then((m) =>
      m.createHash("sha256").update(bytes).digest("hex"),
    );
  const reserved = await post(page, `projects/${project}/uploads`, {
    document_id: document ?? null,
    name: "Multi-revisions.pdf",
    filename: `${label}.pdf`,
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
  expect(content.ok(), await content.text()).toBe(true);
  const result = await post(page, `uploads/${reserved.id}/complete`, {});
  return { ...result, bytes };
}
async function setup(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/");
  const org = await post(page, "organizations", {
      name: "Multi-revision regression",
    }),
    project = await post(page, "projects", {
      organization_id: org.id,
      code: "MULTI",
      name: "Multi-revision test",
    });
  const a = await upload(page, project.id, "A", 3),
    b = await upload(page, project.id, "B", 1, a.id),
    c = await upload(page, project.id, "C", 2, a.id);
  await page.goto(`/projects/${project.id}/documents`);
  await page
    .getByRole("combobox", { name: "Organisation", exact: true })
    .selectOption(org.id);
  await page
    .getByRole("button", { name: "Multi-revisions.pdf", exact: true })
    .click();
  return {
    org,
    project,
    a,
    b,
    c,
    viewer: page.getByRole("dialog", { name: "Détails du document" }),
  };
}
async function select(viewer: Locator, id: string, pages: number) {
  await viewer
    .getByRole("combobox", { name: "Historique des révisions", exact: true })
    .selectOption(id);
  await expect(
    viewer.getByRole("spinbutton", { name: "Page", exact: true }),
  ).toBeEnabled();
  await expect(
    viewer.getByRole("spinbutton", { name: "Page", exact: true }),
  ).toHaveAttribute("max", String(pages));
  await expect(viewer.getByTestId("annotation-layer")).toBeVisible();
  await expect(
    viewer.locator(".viewer[data-revision-id]").first(),
  ).toHaveAttribute("data-revision-id", id);
  const metadata = await (
    await viewer.page().request.get(`/api/v1/revisions/${id}`)
  ).json();
  await expect(viewer.getByTestId("active-review-revision")).toHaveText(
    `Annotations — révision ${metadata.label}`,
  );
}
async function marker(
  page: Page,
  viewer: Locator,
  revision: string,
  text: string,
) {
  await viewer.getByRole("button", { name: "Marqueur", exact: true }).click();
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith(`/revisions/${revision}/review-items`),
  );
  await viewer
    .getByTestId("annotation-layer")
    .click({ position: { x: 70, y: 70 } });
  const result = await response;
  expect(result.status(), await result.text()).toBe(201);
  const item = (await result.json()) as ReviewItem;
  expect(item.revision_id).toBe(revision);
  await viewer
    .getByRole("textbox", { name: "Commentaire du point", exact: true })
    .fill(text);
  await viewer
    .getByRole("button", { name: "Enregistrer le point", exact: true })
    .click();
  await expect(
    viewer
      .getByRole("region", { name: "Points techniques et commentaires" })
      .getByTestId(`point-${item.id}`),
  ).toContainText(text);
  return item;
}
async function ids(page: Page, revision: string) {
  return (
    (
      await (
        await page.request.get(
          `/api/v1/revisions/${revision}/annotations?page_number=1`,
        )
      ).json()
    ).items as ReviewItem[]
  ).map((i) => i.id);
}

test("A/B/C/D: every revision supports isolated persistent annotations and discussions", async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { viewer, a, b, c } = await setup(page);
  await select(viewer, a.revision_id, 3);
  const ma = await marker(page, viewer, a.revision_id, "Comment A");
  await select(viewer, b.revision_id, 1);
  await expect(viewer.getByTestId(`annotation-${ma.id}`)).toHaveCount(0);
  const mb = await marker(page, viewer, b.revision_id, "Comment B");
  await select(viewer, c.revision_id, 2);
  await expect(viewer.getByTestId(`annotation-${ma.id}`)).toHaveCount(0);
  await expect(viewer.getByTestId(`annotation-${mb.id}`)).toHaveCount(0);
  const mc = await marker(page, viewer, c.revision_id, "Comment C");
  for (const [revision, count, item] of [
    [b.revision_id, 1, mb],
    [a.revision_id, 3, ma],
    [c.revision_id, 2, mc],
  ] as const) {
    await select(viewer, revision, count);
    await expect(viewer.getByTestId(`annotation-${item.id}`)).toBeVisible();
    expect(await ids(page, revision)).toEqual([item.id]);
  }
  await page.reload();
  await page
    .getByRole("button", { name: "Multi-revisions.pdf", exact: true })
    .click();
  for (const [revision, count, item] of [
    [a.revision_id, 3, ma],
    [b.revision_id, 1, mb],
    [c.revision_id, 2, mc],
  ] as const) {
    await select(viewer, revision, count);
    await expect(viewer.getByTestId(`annotation-${item.id}`)).toBeVisible();
    await viewer.getByTestId(`annotation-${item.id}`).click();
    await expect(
      viewer.getByRole("textbox", {
        name: "Commentaire du point",
        exact: true,
      }),
    ).toHaveValue(
      `Comment ${revision === a.revision_id ? "A" : revision === b.revision_id ? "B" : "C"}`,
    );
  }
  for (const [revision, count, item] of [
    [b.revision_id, 1, mb],
    [c.revision_id, 2, mc],
  ] as const) {
    await select(viewer, revision, count);
    await viewer.getByTestId(`annotation-${item.id}`).click();
    await viewer
      .getByRole("combobox", { name: "Couleur", exact: true })
      .selectOption("green");
    await viewer
      .getByRole("button", { name: "Enregistrer le point", exact: true })
      .click();
    await expect(
      viewer.getByTestId(`annotation-${item.id}`).locator("circle"),
    ).toHaveAttribute("stroke", "#16a34a");
    const extra = await marker(page, viewer, revision, "Annotation to remove");
    page.once("dialog", (d) => d.accept());
    await viewer
      .getByRole("button", { name: "Supprimer l’annotation", exact: true })
      .click();
    await expect(viewer.getByTestId(`annotation-${extra.id}`)).toHaveCount(0);
    await viewer.getByTestId(`annotation-${item.id}`).click();
    await viewer
      .getByRole("textbox", { name: "Réponse", exact: true })
      .fill(`Reply ${item.id}`);
    await viewer
      .getByRole("button", { name: "Envoyer la réponse", exact: true })
      .click();
    await expect(
      viewer.getByText(`Reply ${item.id}`, { exact: true }),
    ).toBeVisible();
    await viewer
      .getByRole("combobox", { name: "Statut du point", exact: true })
      .selectOption("in_progress");
    await viewer
      .getByRole("button", { name: "Enregistrer le point", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(`/api/v1/review-items/${item.id}`)
            ).json()
          ).item.status,
      )
      .toBe("in_progress");
  }
  await viewer
    .getByRole("textbox", { name: "Révision", exact: true })
    .fill("D");
  const completed = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/complete"),
  );
  await viewer
    .getByLabel("Importer une nouvelle révision", { exact: true })
    .setInputFiles({
      name: "D.pdf",
      mimeType: "application/pdf",
      buffer: await makePdf("D", 4),
    });
  const d = await (await completed).json();
  await select(viewer, d.revision_id, 4);
  const md = await marker(page, viewer, d.revision_id, "Comment D");
  expect(await ids(page, d.revision_id)).toEqual([md.id]);
  expect(await ids(page, a.revision_id)).toEqual([ma.id]);
  expect(await ids(page, b.revision_id)).toEqual([mb.id]);
  expect(await ids(page, c.revision_id)).toEqual([mc.id]);
  expect(errors).toEqual([]);
});

test("rapid switches and late saves cannot lock or contaminate the next revision", async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { viewer, a, b, c } = await setup(page);
  await select(viewer, a.revision_id, 3);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const requestStarted = new Promise<void>((r) => (started = r));
  await page.route(
    `**/api/v1/revisions/${a.revision_id}/review-items`,
    async (route) => {
      if (route.request().method() === "POST") {
        started();
        await held;
      }
      await route.continue();
    },
  );
  await viewer.getByRole("button", { name: "Marqueur", exact: true }).click();
  await viewer
    .getByTestId("annotation-layer")
    .click({ position: { x: 80, y: 80 } });
  await requestStarted;
  await select(viewer, b.revision_id, 1);
  // A's outstanding save must not disable or select a point on B.
  await expect(
    viewer.getByRole("button", { name: "Marqueur", exact: true }),
  ).toBeEnabled({ timeout: 2000 });
  const mb = await marker(page, viewer, b.revision_id, "B while A is saving");
  release();
  await expect.poll(() => ids(page, a.revision_id)).toHaveLength(1);
  expect(await ids(page, b.revision_id)).toEqual([mb.id]);
  await page.route(
    `**/api/v1/revisions/${b.revision_id}/content`,
    async (route) => {
      await new Promise((r) => setTimeout(r, 150));
      await route.continue();
    },
  );
  const selector = viewer.getByRole("combobox", {
    name: "Historique des révisions",
    exact: true,
  });
  for (const revision of [
    a.revision_id,
    b.revision_id,
    c.revision_id,
    a.revision_id,
    c.revision_id,
  ])
    await selector.selectOption(revision);
  await select(viewer, c.revision_id, 2);
  const mc = await marker(page, viewer, c.revision_id, "C after fast switches");
  expect(await ids(page, c.revision_id)).toEqual([mc.id]);
  await select(viewer, b.revision_id, 1);
  await expect(viewer.getByTestId(`annotation-${mb.id}`)).toBeVisible();
  await expect(
    viewer.getByRole("textbox", { name: "Commentaire du point", exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
