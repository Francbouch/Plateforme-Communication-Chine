import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { PDFDocument } from "@cantoo/pdf-lib";
const origin = "http://127.0.0.1:4191";
test.use({ trace: "on" });
test.beforeEach(async ({ context }) => {
  context.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/api/"))
      expect(
        response.status(),
        `${response.request().method()} ${new URL(response.url()).pathname}`,
      ).toBeLessThan(500);
  });
});
async function post(page: Page, path: string, data: unknown, method = "POST") {
  const r = await page.request.fetch("/api/v1/" + path, {
    method,
    data,
    headers: { Origin: origin },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}
async function anonymous(context: BrowserContext) {
  expect(
    (
      await context.request.post("/__test__/auth", {
        data: { actor: "anonymous" },
      })
    ).ok(),
  ).toBeTruthy();
}
async function login(page: Page, email: string, link = "/login") {
  await anonymous(page.context());
  await page.goto(link);
  await expect(
    page.getByRole("heading", { name: "Connexion par courriel", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Courriel", exact: true })
    .fill(email);
  await page
    .getByRole("button", { name: "Demander un code", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Si cette adresse est autorisée",
  );
  const mail = await (
    await page.request.get("/__test__/mail?email=" + encodeURIComponent(email))
  ).json();
  const otp = mail.text.match(/\b\d{8}\b/)[0] as string;
  await page
    .getByRole("textbox", { name: "Code à 8 chiffres", exact: true })
    .fill(otp);
  await page.getByRole("button", { name: "Se connecter", exact: true }).click();
}
async function setup(page: Page, suffix: string) {
  await page.goto("/admin");
  const org = await post(page, "organizations", {
      name: "Email test " + suffix,
    }),
    project = await post(page, "projects", {
      organization_id: org.id,
      code: suffix,
      name: "Preserved " + suffix,
    });
  await page.evaluate(
    (id) => localStorage.setItem("forgebridge.organization", id),
    org.id,
  );
  await page.reload();
  return { org: org.id as string, project: project.id as string };
}
test("administrator signs in with a real OTP session, keeps original projects after reload, and validates independent recovery before activation", async ({
  page,
  browser,
}) => {
  const f = await setup(page, "ADMIN");
  const region = page.getByRole("region", {
    name: "Connexion et rattachement des comptes",
    exact: true,
  });
  await region
    .getByRole("button", {
      name: "Autoriser mon courriel administrateur",
      exact: true,
    })
    .click();
  await expect(region.getByRole("status")).toHaveText("Opération enregistrée.");
  const original = (await (await page.request.get("/api/v1/me")).json()).profile
    .id;
  const context = await browser.newContext({ baseURL: origin }),
    p = await context.newPage();
  await login(p, "browser@example.test");
  await expect(
    p
      .getByRole("navigation", { name: "Votre espace de travail", exact: true })
      .getByRole("link", { name: "Projets", exact: true }),
  ).toBeVisible();
  const me = await (await p.request.get("/api/v1/me")).json();
  expect(me.profile.id).toBe(original);
  expect(me.is_primary_admin).toBe(true);
  await p
    .getByRole("navigation", { name: "Votre espace de travail", exact: true })
    .getByRole("link", { name: "Projets", exact: true })
    .click();
  await expect(p.getByText("Preserved ADMIN", { exact: true })).toBeVisible();
  await p.reload();
  await expect(p.getByText("Preserved ADMIN", { exact: true })).toBeVisible();
  const cookies = await context.cookies(),
    native = cookies.find((c) => c.name.includes("forgebridge.session_token"))!;
  expect(native.httpOnly).toBe(true);
  expect(native.sameSite).toBe("Lax");
  expect((await p.request.get("/recovery")).status()).toBe(401);
  await page.goto("/recovery");
  await expect(
    page.getByRole("heading", {
      name: "ForgeBridge — Récupération administrateur",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Confirmer le fonctionnement de la récupération",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", {
      name: "Activer après connexion, récupération et sauvegarde vérifiées",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "ForgeBridge — Récupération administrateur",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Révoquer mes sessions par courriel",
      exact: true,
    })
    .click();
  expect((await p.request.get("/api/v1/me")).status()).toBe(401);
  await page
    .getByRole("button", {
      name: "Désactiver la connexion par courriel",
      exact: true,
    })
    .click();
  expect(
    (await (await page.request.get("/api/auth/config")).json()).enabled,
  ).toBe(false);
  await page
    .getByRole("button", {
      name: "Réouvrir le test protégé en mode staging",
      exact: true,
    })
    .click();
  expect(
    (await (await page.request.get("/api/auth/config")).json()).enabled,
  ).toBe(true);
  expect((await page.request.get("/api/v1/me")).status()).toBe(200);
  expect(
    (
      await page.request.get(`/api/v1/projects?organization_id=${f.org}`)
    ).status(),
  ).toBe(200);
  await context.close();
});
test("supplier accepts an emailed invitation after native login, sees only B, replies, and loses access immediately when sessions are revoked", async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  const f = await setup(page, "SUPPLIER"),
    hidden = await post(page, "projects", {
      organization_id: f.org,
      code: "HIDDEN",
      name: "Hidden project",
    }),
    sp = await post(page, "suppliers", {
      organization_id: f.org,
      name: "Email supplier",
      country: "CN",
      language: "zh-CN",
    });
  await post(page, `projects/${f.project}/suppliers`, { supplier_id: sp.id });
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 300]);
  const bytes = Buffer.from(await pdf.save());
  async function upload(label: string, document_id?: string) {
    const reservation = await post(page, `projects/${f.project}/uploads`, {
      name: "Shared plan",
      filename: "plan.pdf",
      size: bytes.length,
      sha256: Buffer.from(
        await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
      ).toString("hex"),
      label,
      document_id: document_id ?? null,
    });
    expect(
      (
        await page.request.put(`/api/v1/uploads/${reservation.id}/content`, {
          data: bytes,
          headers: { Origin: origin, "Content-Length": String(bytes.length) },
        })
      ).ok(),
    ).toBeTruthy();
    return post(page, `uploads/${reservation.id}/complete`, {});
  }
  const b = await upload("B"),
    c = await upload("C", b.id);
  await post(
    page,
    `access/documents/${b.id}/sharing`,
    { shared: true, revision_ids: [b.revision_id] },
    "PATCH",
  );
  const conv = await post(page, `projects/${f.project}/conversations`, {
    title: "Supplier email conversation",
  });
  await post(
    page,
    `access/conversations/${conv.id}/sharing`,
    { shared: true },
    "PATCH",
  );
  await post(page, `access/organizations/${f.org}/invitations`, {
    email: "native-supplier@example.test",
    role: "supplier_engineer",
    supplier_id: sp.id,
    project_ids: [f.project],
  });
  const mail = await (
      await page.request.get(
        "/__test__/mail?email=native-supplier@example.test",
      )
    ).json(),
    link = mail.text.match(/http:\/\/[^\s]+#invitation=[^\s]+/)[0] as string;
  const context = await browser.newContext({ baseURL: origin }),
    p = await context.newPage();
  await login(p, "native-supplier@example.test", link);
  await expect(
    p.getByRole("button", { name: "Accepter l’invitation", exact: true }),
  ).toBeVisible();
  await p
    .getByRole("button", { name: "Accepter l’invitation", exact: true })
    .click();
  await expect(
    p.getByRole("heading", {
      name: "Mon espace de collaboration",
      exact: true,
    }),
  ).toBeVisible();
  await p.getByRole("button", { name: /Shared plan/ }).click();
  await expect(p.locator(".pdf-sheet canvas")).toBeVisible();
  expect(
    (
      await p.request.get(
        `/api/v1/collaboration/revisions/${c.revision_id}/content`,
      )
    ).status(),
  ).toBe(404);
  expect(
    (
      await p.request.get(`/api/v1/collaboration/projects/${hidden.id}/summary`)
    ).status(),
  ).toBe(404);
  await p.getByRole("button", { name: "Messages", exact: true }).click();
  await p
    .getByRole("combobox", { name: "Conversations", exact: true })
    .selectOption(conv.id);
  const input = p.getByRole("textbox", {
    name: "Rédiger un message",
    exact: true,
  });
  await input.fill("Native supplier message");
  await p
    .locator(".access-text-form")
    .getByRole("button", { name: "Envoyer", exact: true })
    .click();
  await expect(
    p.getByText("Native supplier message", { exact: true }),
  ).toBeVisible();
  const actor = (await (await p.request.get("/api/v1/me")).json()).profile.id;
  await input.fill("Preserved after native revocation");
  await post(
    page,
    `access/organizations/${f.org}/revoke-sessions/${actor}`,
    {},
  );
  await p
    .locator(".access-text-form")
    .getByRole("button", { name: "Envoyer", exact: true })
    .click();
  await expect(p.locator(".session-notice")).toBeVisible();
  await expect(input).toHaveValue("Preserved after native revocation");
  await expect(p.locator(".session-notice a")).toHaveAttribute(
    "href",
    "/login",
  );
  expect(
    (
      await p.request.get(
        `/api/v1/collaboration/revisions/${b.revision_id}/content`,
      )
    ).status(),
  ).toBe(401);
  await context.close();
});
test("a native reader signs out from the actual UI and a copied old cookie cannot reopen private routes", async ({
  page,
  browser,
}) => {
  const f = await setup(page, "LOGOUT");
  await post(page, `access/organizations/${f.org}/invitations`, {
    email: "native-reader@example.test",
    role: "reviewer",
    supplier_id: null,
    project_ids: [f.project],
  });
  const mail = await (
      await page.request.get("/__test__/mail?email=native-reader@example.test")
    ).json(),
    link = mail.text.match(/http:\/\/[^\s]+#invitation=[^\s]+/)[0] as string;
  const context = await browser.newContext({ baseURL: origin }),
    p = await context.newPage();
  await login(p, "native-reader@example.test", link);
  await p
    .getByRole("button", { name: "Accepter l’invitation", exact: true })
    .click();
  await expect(
    p.getByRole("heading", {
      name: "Mon espace de collaboration",
      exact: true,
    }),
  ).toBeVisible();
  const old = (await context.cookies()).find((c) =>
    c.name.includes("forgebridge.session_token"),
  )!;
  await p.getByRole("button", { name: "Déconnexion", exact: true }).click();
  await expect(
    p.getByRole("heading", { name: "Connexion par courriel", exact: true }),
  ).toBeVisible();
  expect(
    (
      await p.request.get("/api/v1/me", {
        headers: { Cookie: `${old.name}=${old.value}` },
      })
    ).status(),
  ).toBe(401);
  await context.close();
});
