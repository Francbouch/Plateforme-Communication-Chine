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
      r.url().endsWith(`/revisions/${revision}/annotations`),
  );
  await viewer
    .getByTestId("annotation-layer")
    .click({ position: { x: 70, y: 70 } });
  const result = await response;
  expect(result.status(), await result.text()).toBe(201);
  const item = (await result.json()) as ReviewItem;
  expect(item.revision_id).toBe(revision);
  void text;
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

test("A/B/C/D retain independent drawings and explicit points after reload", async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { viewer, a, b, c } = await setup(page),
    created = [];
  for (const [r, count] of [
    [a, 3],
    [b, 1],
    [c, 2],
  ] as const) {
    await select(viewer, r.revision_id, count);
    const ann = await marker(page, viewer, r.revision_id, "");
    const point = await post(page, `revisions/${r.revision_id}/review-items`, {
      id: crypto.randomUUID(),
      page: 1,
      type: "discussion",
      geometry: { points: [] },
      title: `Point ${r.revision_id}`,
      annotation_ids: [ann.id],
    });
    await post(page, `review-items/${point.id}/messages`, {
      id: crypto.randomUUID(),
      body: `Reply ${r.revision_id}`,
    });
    created.push({ r, count, ann, point });
  }
  await page.reload();
  await page
    .getByRole("button", { name: "Multi-revisions.pdf", exact: true })
    .click();
  for (const { r, count, ann, point } of created) {
    await select(viewer, r.revision_id, count);
    expect(await ids(page, r.revision_id)).toEqual([ann.id]);
    await expect(viewer.getByTestId(`annotation-${ann.id}`)).toBeVisible();
    await viewer.getByTestId(`point-${point.id}`).click();
    await expect(
      viewer
        .locator(".review-message")
        .getByText(`Reply ${r.revision_id}`, { exact: true }),
    ).toBeVisible();
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
  const ann = await marker(page, viewer, d.revision_id, "");
  expect(await ids(page, d.revision_id)).toEqual([ann.id]);
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
    `**/api/v1/revisions/${a.revision_id}/annotations`,
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
