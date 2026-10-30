import { it, expect, vi, afterEach } from "vitest";
import middleware, { protectOrigin } from "../middleware";
import { assetKey } from "../apps/api/src/storage";
import { api, ApiError } from "../apps/web/src/client";
afterEach(() => vi.unstubAllGlobals());
it("locks every Vercel origin request without a shared secret or with a forged one", async () => {
  const req = (key?: string) =>
    new Request("https://origin.vercel.app/assets/app.js", {
      headers: key ? { "X-ForgeBridge-Origin-Key": key } : {},
    });
  expect((await protectOrigin(req(), undefined)).status).toBe(503);
  expect((await protectOrigin(req(), "x".repeat(43))).status).toBe(403);
  expect((await protectOrigin(req("forged"), "x".repeat(43))).status).toBe(403);
  expect(
    (await protectOrigin(req("x".repeat(43)), "x".repeat(43))).headers.get(
      "x-middleware-next",
    ),
  ).toBe("1");
});
it("generates opaque scoped R2 keys without allowing traversal", () => {
  const ids = {
    organizationId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    documentId: crypto.randomUUID(),
  };
  const first = assetKey(ids);
  expect(first).toContain(
    `/projects/${ids.projectId}/documents/${ids.documentId}/assets/`,
  );
  expect(assetKey(ids)).not.toBe(first);
  expect(() => assetKey({ ...ids, projectId: "../../other" })).toThrow();
});
it("uses same-origin Access cookies without identity or secrets supplied by React", async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response('{"ok":true}', {
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(api("projects", { name: "Project" })).resolves.toEqual({
    ok: true,
  });
  expect(fetch).toHaveBeenCalledWith(
    "/api/v1/projects",
    expect.objectContaining({
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    }),
  );
});
it("reports failed persistence and non-JSON Access redirects as errors", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('{"error":"Write failed"}', {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    )
    .mockResolvedValueOnce(
      new Response("<html>Access login</html>", {
        headers: { "Content-Type": "text/html" },
      }),
    );
  vi.stubGlobal("fetch", fetch);
  await expect(api("projects", {})).rejects.toThrow("Write failed");
  await expect(api("me")).rejects.toBeInstanceOf(ApiError);
});

it("opens only the demo and static assets, keeping API and private pages locked", async () => {
  for (const path of ["/demo", "/demo/projects", "/assets/app.js"]) {
    expect(
      (
        await middleware(new Request(`https://origin.vercel.app${path}`))
      ).headers.get("x-middleware-next"),
    ).toBe("1");
  }
  for (const path of ["/", "/api/v1/me", "/projects", "/demolition"]) {
    expect(
      (await middleware(new Request(`https://origin.vercel.app${path}`)))
        .status,
    ).toBeGreaterThanOrEqual(400);
  }
});
