import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { PDFDocument } from "@cantoo/pdf-lib";
import { rolePermissions } from "../../packages/shared/src/access";
test.use({ actionTimeout: 10000, navigationTimeout: 20000 });
const origin = "http://127.0.0.1:4191";
async function post(page: Page, path: string, data: unknown, method = "POST") {
  const r = await page.request.fetch(`/api/v1/${path}`, {
    method,
    data,
    headers: { Origin: origin },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}
async function login(context: BrowserContext, actor: string) {
  const r = await context.request.post(`${origin}/__test__/auth`, {
    data: { actor },
  });
  expect(r.ok()).toBeTruthy();
}
async function fixture(page: Page) {
  await page.goto("/admin");
  const org = await post(page, "organizations", {
      name: "Security browser organization",
    }),
    p = await post(page, "projects", {
      organization_id: org.id,
      code: "SC-A",
      name: "Shared supplier project",
    }),
    privateProject = await post(page, "projects", {
      organization_id: org.id,
      code: "SC-B",
      name: "Other private project",
    });
  await page.evaluate(
    (id) => localStorage.setItem("forgebridge.organization", id),
    org.id,
  );
  const supplier = await post(page, "suppliers", {
    organization_id: org.id,
    name: "Browser supplier A",
    country: "CN",
    language: "zh-CN",
  });
  await post(page, `projects/${p.id}/suppliers`, { supplier_id: supplier.id });
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 300]);
  const bytes = Buffer.from(await pdf.save());
  async function upload(name: string, label: string, document_id?: string) {
    const u = await post(page, `projects/${p.id}/uploads`, {
      name,
      number: "SEC-001",
      filename: "fixture.pdf",
      size: bytes.length,
      sha256: Buffer.from(
        await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
      ).toString("hex"),
      label,
      document_id: document_id ?? null,
    });
    expect(
      (
        await page.request.put(`/api/v1/uploads/${u.id}/content`, {
          data: bytes,
          headers: { Origin: origin, "Content-Length": String(bytes.length) },
        })
      ).ok(),
    ).toBeTruthy();
    return post(page, `uploads/${u.id}/complete`, {});
  }
  const doc = await upload("Shared browser drawing", "B"),
    newRevision = await upload("Shared browser drawing", "C", doc.id),
    hidden = await upload("Internal confidential drawing", "A");
  const point = crypto.randomUUID(),
    draft = crypto.randomUUID();
  for (const [id, title] of [
    [point, "Published browser check"],
    [draft, "Secret draft check"],
  ])
    await post(page, `revisions/${doc.revision_id}/review-items`, {
      id,
      page: 1,
      type: "discussion",
      title,
      summary: "Non confidential 3 mm",
      geometry: { points: [] },
    });
  await post(
    page,
    `review-items/${point}`,
    { version: 1, publication: "published" },
    "PATCH",
  );
  const internal = await post(page, `projects/${p.id}/conversations`, {
      title: "Private internal conversation",
    }),
    shared = await post(page, `projects/${p.id}/conversations`, {
      title: "Shared supplier conversation",
    });
  await post(
    page,
    `access/conversations/${shared.id}/sharing`,
    { shared: true },
    "PATCH",
  );
  await post(page, `conversations/${shared.id}/messages`, {
    id: crypto.randomUUID(),
    body: "Shared message for supplier",
    shared: true,
  });
  await post(page, `conversations/${shared.id}/messages`, {
    id: crypto.randomUUID(),
    body: "Confidential private message",
    shared: false,
  });
  await page.goto("/admin");
  return {
    org: org.id as string,
    project: p.id as string,
    privateProject: privateProject.id as string,
    supplier: supplier.id as string,
    document: doc.id as string,
    revision: doc.revision_id as string,
    newRevision: newRevision.revision_id as string,
    hidden: hidden.id as string,
    point,
    internal: internal.id as string,
    shared: shared.id as string,
  };
}
async function inviteApi(
  page: Page,
  f: Awaited<ReturnType<typeof fixture>>,
  email: string,
  role = "reviewer",
) {
  return post(page, `access/organizations/${f.org}/invitations`, {
    email,
    role,
    project_ids: [f.project],
    supplier_id: role === "supplier_engineer" ? f.supplier : null,
  });
}
async function accept(page: Page, actor: string, link: string) {
  await login(page.context(), actor);
  await page.goto(link);
  await expect(
    page.getByRole("button", { name: "Accepter l’invitation", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  await page
    .getByRole("button", { name: "Accepter l’invitation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Mon espace de collaboration",
      exact: true,
    }),
  ).toBeVisible();
  return (await (await page.request.get("/api/v1/me")).json()).profile
    .id as string;
}
async function memberRow(page: Page, email: string) {
  const region = page.getByRole("region", {
    name: "Utilisateurs et accès",
    exact: true,
  });
  const row = region
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: email, exact: true }) })
    .filter({
      has: page.getByRole("button", {
        name: "Modifier les permissions",
        exact: true,
      }),
    });
  return row;
}
test("administrator creates an invitation and shares only B; supplier accepts, sees authorized PDF/points/messages, replies and signs out", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(page),
    access = page.getByRole("region", {
      name: "Utilisateurs et accès",
      exact: true,
    });
  await access.locator("summary").first().click();
  const form = access.locator(".access-invite-form");
  await form
    .getByRole("textbox", { name: "Courriel", exact: true })
    .fill("supplier-a@example.test");
  await form
    .getByRole("combobox", { name: "Rôle", exact: true })
    .selectOption("supplier_engineer");
  await form
    .getByRole("combobox", { name: "Fournisseur", exact: true })
    .selectOption(f.supplier);
  for (const box of await form.locator("input[type=checkbox]").all())
    await box.uncheck();
  await form.getByRole("checkbox", { name: /SC-A/ }).check();
  await form
    .getByRole("button", { name: "Créer l’invitation sécurisée", exact: true })
    .click();
  await expect(access.getByRole("status")).toContainText(
    "Aucun courriel envoyé",
  );
  const link = await access
    .getByRole("textbox", {
      name: "Lien d’invitation sécurisé à transmettre",
      exact: true,
    })
    .inputValue();
  await access
    .getByRole("combobox", {
      name: "Projet pour la gestion des membres",
      exact: true,
    })
    .selectOption(f.project);
  await access
    .getByRole("combobox", { name: "Document à partager", exact: true })
    .selectOption(f.document);
  const sharing = access.locator(".access-sharing");
  await sharing
    .getByRole("checkbox", {
      name: "Partager uniquement les révisions sélectionnées",
      exact: true,
    })
    .check();
  await sharing.getByRole("checkbox", { name: /Révision B/ }).check();
  await sharing
    .getByRole("button", { name: "Enregistrer le partage", exact: true })
    .click();
  const context = await browser.newContext({ baseURL: origin }),
    supplierPage = await context.newPage();
  const actor = await accept(supplierPage, "supplier-a", link);
  await expect(
    supplierPage.getByRole("button", { name: /Shared browser drawing.*B/ }),
  ).toBeVisible();
  await expect(
    supplierPage.getByText("Internal confidential drawing", { exact: true }),
  ).toHaveCount(0);
  await expect(
    supplierPage.getByRole("link", { name: "Administration", exact: true }),
  ).toHaveCount(0);
  await supplierPage
    .getByRole("button", { name: /Shared browser drawing.*B/ })
    .click();
  await expect(supplierPage.locator(".pdf-sheet canvas")).toBeVisible();
  await expect(
    supplierPage.getByRole("combobox", { name: "Révision", exact: true }),
  ).toHaveValue(f.revision);
  await expect(
    supplierPage.getByRole("option", { name: "C", exact: true }),
  ).toHaveCount(0);
  await expect(
    supplierPage.getByText("Secret draft check", { exact: true }),
  ).toHaveCount(0);
  await supplierPage
    .getByRole("button", { name: /Published browser check/ })
    .click();
  await supplierPage
    .getByRole("textbox", { name: "Réponse", exact: true })
    .fill("Supplier persistent reply 3 mm");
  await supplierPage
    .locator(".access-text-form")
    .getByRole("button", { name: "Envoyer", exact: true })
    .click();
  await expect(
    supplierPage.getByText("Supplier persistent reply 3 mm", { exact: true }),
  ).toBeVisible();
  await supplierPage.reload();
  await supplierPage
    .getByRole("button", { name: /Shared browser drawing.*B/ })
    .click();
  await supplierPage
    .getByRole("button", { name: /Published browser check/ })
    .click();
  await expect(
    supplierPage.getByText("Supplier persistent reply 3 mm", { exact: true }),
  ).toBeVisible();
  await supplierPage
    .getByRole("button", { name: "Messages", exact: true })
    .click();
  await supplierPage
    .getByRole("combobox", { name: "Conversations", exact: true })
    .selectOption(f.shared);
  await expect(
    supplierPage.getByText("Shared message for supplier", { exact: true }),
  ).toBeVisible();
  await expect(
    supplierPage.getByText("Confidential private message", { exact: true }),
  ).toHaveCount(0);
  await supplierPage
    .getByRole("textbox", { name: "Rédiger un message", exact: true })
    .fill("Supplier shared answer");
  await supplierPage
    .locator(".access-text-form")
    .getByRole("button", { name: "Envoyer", exact: true })
    .click();
  await expect(
    supplierPage.getByText("Supplier shared answer", { exact: true }),
  ).toBeVisible();
  for (const route of [
    `collaboration/revisions/${f.newRevision}/content`,
    `collaboration/documents/${f.hidden}`,
    `collaboration/projects/${f.privateProject}/summary`,
    `collaboration/conversations/${f.internal}/messages`,
    `projects/${f.project}/documents`,
  ])
    expect(
      (await supplierPage.request.get("/api/v1/" + route)).status(),
      route,
    ).toBe(404);
  await supplierPage.setViewportSize({ width: 390, height: 844 });
  await supplierPage.screenshot({
    path: "/tmp/forgebridge-phase7-supplier.png",
    fullPage: true,
  });
  await supplierPage
    .getByRole("button", { name: "Déconnexion", exact: true })
    .click();
  await expect(supplierPage).toHaveURL(/cdn-cgi\/access\/logout/);
  expect((await supplierPage.request.get("/api/v1/me")).status()).toBe(401);
  expect(
    (
      await (
        await page.request.get(`/api/v1/access/projects/${f.project}/members`)
      ).json()
    ).items.some((m: { user_id: string }) => m.user_id === actor),
  ).toBe(true);
  expect(errors).toEqual([]);
  await context.close();
});
test("reader, internal collaborator and a second supplier have distinct server-enforced views and permissions", async ({
  page,
  browser,
}) => {
  const f = await fixture(page);
  await post(
    page,
    `access/documents/${f.document}/sharing`,
    { shared: true, revision_ids: [f.revision] },
    "PATCH",
  );
  const contexts: BrowserContext[] = [];
  for (const [actor, role] of [
    ["reader", "reviewer"],
    ["internal", "designer"],
    ["supplier-b", "supplier_engineer"],
  ]) {
    const i = await inviteApi(page, f, `${actor}@example.test`, role),
      context = await browser.newContext({ baseURL: origin });
    contexts.push(context);
    const p = await context.newPage();
    await accept(p, actor, i.invitation_url);
    if (role === "designer") {
      await expect(
        p.getByRole("button", { name: /Internal confidential drawing/ }),
      ).toBeVisible();
      await p.getByRole("button", { name: "Messages", exact: true }).click();
      await expect(
        p
          .getByRole("combobox", { name: "Conversations", exact: true })
          .getByRole("option", {
            name: "Private internal conversation",
            exact: true,
          }),
      ).toHaveCount(1);
    } else {
      await expect(
        p.getByRole("button", { name: /Internal confidential drawing/ }),
      ).toHaveCount(0);
    }
    if (role === "reviewer") {
      await p
        .getByRole("button", { name: /Shared browser drawing.*B/ })
        .click();
      await p.getByRole("button", { name: /Published browser check/ }).click();
      await expect(
        p.getByRole("textbox", { name: "Réponse", exact: true }),
      ).toHaveCount(0);
      await expect(
        p.getByRole("toolbar", { name: "Outils d’annotation", exact: true }),
      ).toHaveCount(0);
      expect(
        (
          await p.request.post(`/api/v1/review-items/${f.point}/messages`, {
            headers: { Origin: origin },
            data: { id: crypto.randomUUID(), body: "Forbidden reader write" },
          })
        ).status(),
      ).toBe(404);
    }
    expect(
      (
        await p.request.get(
          `/api/v1/collaboration/projects/${f.privateProject}/summary`,
        )
      ).status(),
    ).toBe(404);
  }
  for (const context of contexts) await context.close();
});
test("changing permissions and revoking project access/session invalidate existing supplier sessions and private download links", async ({
  page,
  browser,
}) => {
  const f = await fixture(page);
  await post(
    page,
    `access/documents/${f.document}/sharing`,
    { shared: true, revision_ids: [f.revision] },
    "PATCH",
  );
  const i = await inviteApi(
      page,
      f,
      "supplier-revoke@example.test",
      "supplier_engineer",
    ),
    context = await browser.newContext({ baseURL: origin }),
    p = await context.newPage(),
    actor = await accept(p, "supplier-revoke", i.invitation_url);
  await p.getByRole("button", { name: /Shared browser drawing.*B/ }).click();
  await p.getByRole("button", { name: /Published browser check/ }).click();
  await p
    .getByRole("textbox", { name: "Réponse", exact: true })
    .fill("Preserved after permission denial");
  await page.goto("/admin");
  const access = page.getByRole("region", {
    name: "Utilisateurs et accès",
    exact: true,
  });
  await access.locator("summary").first().click();
  await access
    .getByRole("combobox", {
      name: "Projet pour la gestion des membres",
      exact: true,
    })
    .selectOption(f.project);
  await (
    await memberRow(page, "supplier-revoke@example.test")
  )
    .getByRole("button", { name: "Modifier les permissions", exact: true })
    .click();
  const form = access.locator(".access-permissions");
  await form
    .getByRole("checkbox", { name: "Répondre aux points", exact: true })
    .uncheck();
  await form
    .getByRole("checkbox", {
      name: "Télécharger les fichiers autorisés",
      exact: true,
    })
    .uncheck();
  await form
    .getByRole("button", { name: "Enregistrer les permissions", exact: true })
    .click();
  await p
    .locator(".access-text-form")
    .getByRole("button", { name: "Envoyer", exact: true })
    .click();
  await expect(p.getByRole("alert")).toContainText("échoué");
  await expect(
    p.getByRole("textbox", { name: "Réponse", exact: true }),
  ).toHaveValue("Preserved after permission denial");
  expect(
    (
      await p.request.get(
        `/api/v1/collaboration/revisions/${f.revision}/content`,
      )
    ).status(),
  ).toBe(404);
  await (
    await memberRow(page, "supplier-revoke@example.test")
  )
    .getByRole("button", { name: "Révoquer l’accès", exact: true })
    .click();
  await p.reload();
  await expect(
    p.getByText("Aucun projet autorisé.", { exact: false }),
  ).toBeVisible();
  expect(
    (
      await p.request.get(
        `/api/v1/collaboration/conversations/${f.shared}/messages`,
      )
    ).status(),
  ).toBe(404);
  await post(
    page,
    `access/organizations/${f.org}/revoke-sessions/${actor}`,
    {},
  );
  expect((await p.request.get("/api/v1/me")).status()).toBe(401);
  await context.close();
});
test("only explicitly assigned supplier can confirm an immutable decision with their verified identity", async ({
  page,
  browser,
}) => {
  const f = await fixture(page);
  await post(
    page,
    `access/documents/${f.document}/sharing`,
    { shared: true, revision_ids: [f.revision] },
    "PATCH",
  );
  const i = await inviteApi(
      page,
      f,
      "supplier-approve@example.test",
      "supplier_engineer",
    ),
    context = await browser.newContext({ baseURL: origin }),
    p = await context.newPage(),
    actor = await accept(p, "supplier-approve", i.invitation_url);
  const members = await (
      await page.request.get(`/api/v1/access/projects/${f.project}/members`)
    ).json(),
    m = members.items.find((x: { user_id: string }) => x.user_id === actor);
  await post(
    page,
    `access/projects/${f.project}/members/${actor}`,
    {
      role: "supplier_engineer",
      active: true,
      version: m.version,
      permissions: {
        ...rolePermissions("supplier_engineer"),
        view_approvals: true,
        approve: true,
      },
    },
    "PATCH",
  );
  const id = crypto.randomUUID();
  await post(page, "approvals", {
    id,
    revision_id: f.revision,
    title: "Assigned exact B decision",
  });
  await post(
    page,
    `access/approvals/${id}/sharing`,
    { shared: true, approver_id: actor },
    "PATCH",
  );
  await post(page, `approvals/${id}/actions`, { action: "submit", version: 1 });
  await p.reload();
  await p.getByRole("button", { name: "Approbations", exact: true }).click();
  await p
    .getByRole("button", { name: "Prendre une décision", exact: true })
    .click();
  await expect(
    p.getByRole("button", { name: "Confirmer", exact: true }),
  ).toBeDisabled();
  await p
    .getByRole("checkbox", {
      name: "Je confirme cette décision sur la révision exacte affichée.",
      exact: true,
    })
    .check();
  await p.getByRole("button", { name: "Confirmer", exact: true }).click();
  await expect(
    p.getByText(
      "Décision associée à une identité Cloudflare Access vérifiée.",
      { exact: false },
    ),
  ).toBeVisible();
  const a = await (await page.request.get(`/api/v1/approvals/${id}`)).json();
  expect(a.approval.decided_by).toBe(actor);
  expect(a.approval.status).toBe("approved");
  expect(JSON.parse(a.approval.decision_identity).subject).toBe(
    "supplier-approve",
  );
  await context.close();
});
