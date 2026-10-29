import { it, expect, vi, afterEach } from "vitest";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});
async function loadClient(origin: string) {
  vi.stubEnv("VITE_SUPABASE_URL", "");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "");
  vi.stubEnv("VITE_API_BASE_URL", origin);
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  vi.stubGlobal("fetch", fetch);
  const { api } = await import("../apps/web/src/client");
  return { api, fetch };
}
it("uses the configured Worker origin on a Vercel frontend", async () => {
  const { api, fetch } = await loadClient("https://forgebridge-test.example/");
  await expect(api("projects", { name: "Project" })).resolves.toEqual({
    ok: true,
  });
  expect(fetch).toHaveBeenCalledWith(
    "https://forgebridge-test.example/api/v1/projects",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "Project" }),
    }),
  );
});
it("keeps the relative Vite proxy route during local development", async () => {
  const { api, fetch } = await loadClient("");
  await api("health");
  expect(fetch).toHaveBeenCalledWith(
    "/api/v1/health",
    expect.objectContaining({ method: "GET" }),
  );
});
