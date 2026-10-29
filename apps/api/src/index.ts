import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import {
  createClient,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import { z } from "zod";
import {
  projectSchema,
  supplierSchema,
  invitationSchema,
  preferencesSchema,
  roles,
} from "../../../packages/shared/src/index";
export type Bindings = {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  APP_ORIGIN: string;
  DOCUMENTS?: R2Bucket;
  RATE_LIMITER?: {
    limit(input: { key: string }): Promise<{ success: boolean }>;
  };
};
type Variables = { db: SupabaseClient; user: User; requestId: string };
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
app.use("*", secureHeaders());
app.use(
  "/api/v1/*",
  bodyLimit({
    maxSize: 32768,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  }),
);
app.use("*", async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  c.header("X-Request-ID", c.get("requestId"));
  c.header("Cache-Control", "no-store");
  await next();
});
app.onError((error, c) => {
  console.error(
    JSON.stringify({ request_id: c.get("requestId"), error: error.name }),
  );
  return c.json(
    { error: "Internal server error", request_id: c.get("requestId") },
    500,
  );
});
app.get("/api/v1/health", (c) =>
  c.json({
    service: "forgebridge-api",
    configured: Boolean(c.env.SUPABASE_URL && c.env.SUPABASE_PUBLISHABLE_KEY),
  }),
);
app.use("/api/v1/*", async (c, next) => {
  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_PUBLISHABLE_KEY)
    return c.json({ error: "Supabase is not configured" }, 503);
  if (c.req.method !== "GET" && c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ error: "Origin rejected" }, 403);
  const token = c.req.header("Authorization");
  if (!token?.startsWith("Bearer ") || token.length > 8192)
    return c.json({ error: "Authentication required" }, 401);
  const db = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: token } },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  const { data, error } = await db.auth.getUser(token.slice(7));
  if (error || !data.user) return c.json({ error: "Invalid session" }, 401);
  const { data: profile } = await db
    .from("profiles")
    .select("status")
    .eq("id", data.user.id)
    .single();
  if (profile?.status !== "active")
    return c.json({ error: "Account unavailable" }, 403);
  if (
    c.env.RATE_LIMITER &&
    !(await c.env.RATE_LIMITER.limit({ key: data.user.id })).success
  )
    return c.json({ error: "Too many requests" }, 429);
  c.set("db", db);
  c.set("user", data.user);
  await next();
});
async function digest(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
const uuid = z.uuid();
app.get("/api/v1/me", async (c) => {
  const db = c.get("db");
  const [profile, memberships] = await Promise.all([
    db.from("profiles").select("id,name,language,timezone").single(),
    db
      .from("organization_memberships")
      .select("role,organization:organizations(id,name)")
      .eq("user_id", c.get("user").id)
      .eq("active", true),
  ]);
  if (profile.error || memberships.error)
    return c.json({ error: "Unable to load account" }, 400);
  return c.json({
    profile: profile.data,
    organizations: memberships.data.map((m) => ({
      ...m.organization,
      role: m.role,
    })),
  });
});
app.post("/api/v1/organizations", async (c) => {
  const p = z
    .object({ name: z.string().trim().min(1).max(160) })
    .safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "Invalid organization" }, 400);
  const { data, error } = await c
    .get("db")
    .rpc("create_organization", { n: p.data.name });
  return error
    ? c.json({ error: "Organization rejected; MFA required" }, 403)
    : c.json({ id: data }, 201);
});
app.patch("/api/v1/me", async (c) => {
  const p = preferencesSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "Invalid preferences" }, 400);
  const { error } = await c.get("db").rpc("update_preferences", {
    n: p.data.name,
    l: p.data.language,
    t: p.data.timezone,
  });
  return error
    ? c.json({ error: "Preferences rejected" }, 403)
    : c.json({ ok: true });
});
for (const table of [
  "projects",
  "suppliers",
  "invitations",
  "organization_memberships",
  "audit_events",
] as const) {
  app.get(`/api/v1/${table}`, async (c) => {
    const org = uuid.safeParse(c.req.query("organization_id"));
    if (!org.success) return c.json({ error: "Organization required" }, 400);
    const fields = {
      projects: "*",
      suppliers: "*,supplier_notes(internal_notes)",
      invitations:
        "id,project_id,supplier_id,email,role,expires_at,accepted_at,revoked_at",
      organization_memberships: "user_id,role,active",
      audit_events: "id,actor_id,action,resource_id,created_at",
    }[table];
    const { data, error } = await c
      .get("db")
      .from(table)
      .select(fields)
      .eq("organization_id", org.data)
      .limit(200);
    return error ? c.json({ error: "Query rejected" }, 400) : c.json(data);
  });
}
app.patch("/api/v1/organization_memberships/:user", async (c) => {
  const p = z
    .object({
      organization_id: uuid,
      user: uuid,
      role: z.enum(roles),
      active: z.boolean(),
    })
    .safeParse({
      ...(await c.req.json().catch(() => ({}))),
      user: c.req.param("user"),
    });
  if (!p.success) return c.json({ error: "Invalid membership" }, 400);
  const v = p.data;
  const { error } = await c.get("db").rpc("set_organization_member", {
    o: v.organization_id,
    u: v.user,
    r: v.role,
    a: v.active,
  });
  return error
    ? c.json({ error: "Membership rejected" }, 403)
    : c.json({ ok: true });
});
app.post("/api/v1/projects", async (c) => {
  const body = await c.req.json().catch(() => null);
  const p = projectSchema
    .extend({ organization_id: uuid, id: uuid.nullable().default(null) })
    .safeParse(body);
  if (!p.success) return c.json({ error: "Invalid project" }, 400);
  const v = p.data;
  const { data, error } = await c.get("db").rpc("save_project", {
    o: v.organization_id,
    p: v.id,
    c: v.code,
    n: v.name,
    d: v.description,
    s: v.status,
  });
  return error
    ? c.json({ error: "Project rejected" }, 403)
    : c.json({ id: data }, 201);
});
app.post("/api/v1/suppliers", async (c) => {
  const p = supplierSchema
    .extend({ organization_id: uuid, id: uuid.nullable().default(null) })
    .safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "Invalid supplier" }, 400);
  const v = p.data;
  const { data, error } = await c.get("db").rpc("save_supplier", {
    o: v.organization_id,
    s: v.id,
    n: v.name,
    c: v.country,
    l: v.language,
    ct: v.contacts,
    nt: v.internal_notes,
    st: v.status,
  });
  return error
    ? c.json({ error: "Supplier rejected" }, 403)
    : c.json({ id: data }, 201);
});
app.get("/api/v1/projects/:id/collaborators", async (c) => {
  const p = uuid.safeParse(c.req.param("id"));
  if (!p.success) return c.json({ error: "Invalid project" }, 400);
  const { data, error } = await c
    .get("db")
    .from("project_memberships")
    .select("user_id,role,supplier_id,active")
    .eq("project_id", p.data);
  return error ? c.json({ error: "Query rejected" }, 403) : c.json(data);
});
app.post("/api/v1/projects/:id/suppliers", async (c) => {
  const p = z.object({ project: uuid, supplier_id: uuid }).safeParse({
    project: c.req.param("id"),
    ...(await c.req.json().catch(() => ({}))),
  });
  if (!p.success) return c.json({ error: "Invalid association" }, 400);
  const { error } = await c
    .get("db")
    .rpc("link_supplier", { p: p.data.project, s: p.data.supplier_id });
  return error
    ? c.json({ error: "Association rejected" }, 403)
    : c.json({ ok: true });
});
app.patch("/api/v1/projects/:id/collaborators/:user", async (c) => {
  const p = z
    .object({
      role: z.enum(roles).exclude(["owner"]),
      active: z.boolean(),
      project: uuid,
      user: uuid,
    })
    .safeParse({
      ...(await c.req.json().catch(() => ({}))),
      project: c.req.param("id"),
      user: c.req.param("user"),
    });
  if (!p.success) return c.json({ error: "Invalid membership" }, 400);
  const v = p.data;
  const { error } = await c.get("db").rpc("set_project_member", {
    p: v.project,
    u: v.user,
    r: v.role,
    a: v.active,
  });
  return error
    ? c.json({ error: "Membership rejected" }, 403)
    : c.json({ ok: true });
});
app.post("/api/v1/invitations", async (c) => {
  const p = invitationSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "Invalid invitation" }, 400);
  const token = crypto.randomUUID() + crypto.randomUUID();
  const v = p.data;
  const { data, error } = await c.get("db").rpc("create_invitation", {
    p: v.project_id,
    s: v.supplier_id,
    e: v.email,
    r: v.role,
    h: await digest(token),
    days: v.expires_days,
  });
  return error
    ? c.json({ error: "Invitation rejected" }, 403)
    : c.json({ id: data, token }, 201);
});
app.post("/api/v1/invitations/accept", async (c) => {
  const p = z
    .object({ token: z.string().min(60).max(100) })
    .safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "Invalid invitation" }, 400);
  const { data, error } = await c
    .get("db")
    .rpc("accept_invitation", { h: await digest(p.data.token) });
  return error
    ? c.json({ error: "Invitation unavailable" }, 403)
    : c.json({ project_id: data });
});
app.delete("/api/v1/invitations/:id", async (c) => {
  const p = uuid.safeParse(c.req.param("id"));
  if (!p.success) return c.json({ error: "Invalid invitation" }, 400);
  const { error } = await c.get("db").rpc("revoke_invitation", { i: p.data });
  return error
    ? c.json({ error: "Revocation rejected" }, 403)
    : c.json({ ok: true });
});
app.notFound((c) => c.json({ error: "Not found" }, 404));
export default app;
