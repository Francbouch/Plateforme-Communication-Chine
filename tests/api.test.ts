import { describe, it, expect, vi, beforeEach } from "vitest";
const mock = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  single: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: mock.getUser },
    from: () => ({ select: () => ({ eq: () => ({ single: mock.single }) }) }),
    rpc: mock.rpc,
  }),
}));
import app from "../apps/api/src/index";
import {
  projectSchema,
  invitationSchema,
  preferencesSchema,
} from "../packages/shared/src/index";
const env = {
  APP_ORIGIN: "http://localhost:5173",
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "public-test-key",
};
const id = "00000000-0000-4000-8000-000000000001";
function req(
  path: string,
  body?: unknown,
  options: Record<string, string> = {},
) {
  return app.request(
    `/api/v1/${path}`,
    {
      method: body ? "POST" : "GET",
      headers: {
        Origin: env.APP_ORIGIN,
        Authorization: "Bearer test",
        "Content-Type": "application/json",
        ...options,
      },
      body: body ? JSON.stringify(body) : undefined,
    },
    env,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.getUser.mockResolvedValue({ data: { user: { id } }, error: null });
  mock.single.mockResolvedValue({ data: { status: "active" } });
  mock.rpc.mockResolvedValue({ data: id, error: null });
});
describe("API boundary", () => {
  it("reports missing configuration honestly", async () => {
    expect(
      await (
        await app.request("/api/v1/health", {}, { APP_ORIGIN: "" })
      ).json(),
    ).toMatchObject({ configured: false });
    expect(
      (await app.request("/api/v1/projects", {}, { APP_ORIGIN: "" })).status,
    ).toBe(503);
  });
  it("rejects unauthenticated requests", async () =>
    expect(
      (await req("projects", undefined, { Authorization: "" })).status,
    ).toBe(401));
  it("rejects invalid sessions", async () => {
    mock.getUser.mockResolvedValue({
      error: new Error(),
      data: { user: null },
    });
    expect((await req("projects")).status).toBe(401);
  });
  it("rejects suspended accounts", async () => {
    mock.single.mockResolvedValue({ data: { status: "suspended" } });
    expect((await req("projects")).status).toBe(403);
  });
  it("rejects cross-origin mutations", async () => {
    expect(
      (await req("projects", {}, { Origin: "https://evil.example" })).status,
    ).toBe(403);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it("validates projects before database writes", async () => {
    expect((await req("projects", { name: "" })).status).toBe(400);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it("propagates authorization denial without SQL details", async () => {
    mock.rpc.mockResolvedValue({ error: { message: "private schema detail" } });
    const r = await req("projects", {
      organization_id: id,
      code: "A",
      name: "Design",
    });
    expect(r.status).toBe(403);
    expect(await r.text()).not.toContain("schema");
  });
  it("creates projects through transactional RPC", async () => {
    const r = await req("projects", {
      organization_id: id,
      code: "A",
      name: "Design",
    });
    expect(r.status).toBe(201);
    expect(mock.rpc).toHaveBeenCalledWith(
      "save_project",
      expect.objectContaining({ o: id, n: "Design" }),
    );
  });
  it("hashes invitation tokens and returns the raw token only once", async () => {
    const r = await req("invitations", {
      email: "engineer@example.test",
      role: "supplier_engineer",
      project_id: id,
      supplier_id: id,
    });
    expect(r.status).toBe(201);
    const data = (await r.json()) as { token: string };
    const args = mock.rpc.mock.calls[0][1];
    expect(args.h).toHaveLength(64);
    expect(args.h).not.toBe(data.token);
    expect(data.token).toHaveLength(72);
  });
  it("rejects inconsistent supplier invitation roles", async () => {
    expect(
      (
        await req("invitations", {
          email: "engineer@example.test",
          role: "supplier_engineer",
          project_id: id,
          supplier_id: null,
        })
      ).status,
    ).toBe(400);
  });
  it("enforces configured rate limiting", async () => {
    const r = await app.request(
      "/api/v1/me",
      { headers: { Authorization: "Bearer test" } },
      { ...env, RATE_LIMITER: { limit: async () => ({ success: false }) } },
    );
    expect(r.status).toBe(429);
  });
  it("never exposes an object route", async () => {
    expect((await req("assets/another-supplier-file")).status).toBe(404);
  });
});
describe("shared validation", () => {
  it("rejects invalid project codes", () =>
    expect(
      projectSchema.safeParse({ code: "../file", name: "x" }).success,
    ).toBe(false));
  it("rejects owner invitations", () =>
    expect(
      invitationSchema.safeParse({
        email: "a@b.test",
        role: "owner",
        project_id: id,
        supplier_id: null,
      }).success,
    ).toBe(false));
  it("validates timezones", () =>
    expect(
      preferencesSchema.safeParse({
        name: "User",
        language: "en",
        timezone: "invalid",
      }).success,
    ).toBe(false));
});

describe("Vercel cross-origin integration", () => {
  it("accepts preflight from the exact configured frontend without requiring authentication", async () => {
    const r = await app.request(
      "/api/v1/projects",
      {
        method: "OPTIONS",
        headers: {
          Origin: env.APP_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      },
      env,
    );
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe(env.APP_ORIGIN);
    expect(
      r.headers.get("Access-Control-Allow-Headers")?.toLowerCase(),
    ).toContain("authorization");
    expect(r.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(mock.getUser).not.toHaveBeenCalled();
  });
  it("does not grant CORS to an unrelated preview domain", async () => {
    const r = await app.request(
      "/api/v1/projects",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://untrusted-preview.vercel.app",
          "Access-Control-Request-Method": "POST",
        },
      },
      env,
    );
    expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
  it("allows the browser to read authenticated API errors from its configured origin", async () => {
    const r = await req("projects", undefined, { Authorization: "" });
    expect(r.status).toBe(401);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe(env.APP_ORIGIN);
  });
});
