import { accessRoutes } from "./access-routes";
import { collaborationRoutes, authorizeMemberRequest } from "./collaboration";
import type { TranslationProvider } from "./translation/provider";
import { translationRoutes } from "./translations";
import { approvalRoutes } from "./approvals";
import { communicationRoutes } from "./messages";
import { reviewRoutes } from "./review";
import { documentRoutes } from "./documents";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { z, type ZodType } from "zod";
import {
  projectSchema,
  supplierSchema,
  preferencesSchema,
  invitationSchema,
  roles,
} from "../../../packages/shared/src/index";
import { AccessIdentityProvider, type IdentityProvider } from "./identity";
import { Store, resolvePrincipal } from "./database";
import { HttpError, type Bindings, type Principal } from "./types";
import { serveFrontend } from "./gateway";
type Variables = { store: Store; principal: Principal; requestId: string };
export function createApp(
  identityProvider: IdentityProvider = new AccessIdentityProvider(),
  fetcher: typeof fetch = fetch,
  translationProviderFactory?: (env: Bindings) => TranslationProvider,
  invitationFetcher?: typeof fetch,
) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", secureHeaders());
  app.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    c.header("X-Request-ID", c.get("requestId"));
    c.header("Cache-Control", "private, no-store");
    await next();
  });
  app.use("/api/v1/*", (c, next) =>
    cors({
      origin: (o) => (o === c.env.APP_ORIGIN ? o : undefined),
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type"],
      credentials: false,
      maxAge: 600,
    })(c, next),
  );
  app.use("*", (c, next) =>
    c.req.method === "PUT" &&
    /^\/api\/v1\/(?:uploads|message-attachments)\/[^/]+\/content$/.test(
      c.req.path,
    )
      ? next()
      : bodyLimit({
          maxSize: 32768,
          onError: (c) => c.json({ error: "Request body too large" }, 413),
        })(c, next),
  );
  app.onError((error, c) => {
    if (
      error instanceof HttpError &&
      [401, 403].includes(error.status) &&
      !c.req.path.startsWith("/api/") &&
      c.req.method === "GET"
    )
      return c.html(
        "<!doctype html><html lang='fr'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>ForgeBridge</title><h1>ForgeBridge</h1><p>Session indisponible / Session unavailable / 会话不可用</p><a href='/cdn-cgi/access/logout'>Se reconnecter / Sign in again / 重新登录</a></html>",
        error.status,
      );

    if (
      error instanceof HttpError &&
      c.env.MULTIUSER_ENABLED === "true" &&
      c.get("store") &&
      [403, 404].includes(error.status)
    )
      return c.json(
        { error: "Resource unavailable", request_id: c.get("requestId") },
        404,
      );
    if (error instanceof HttpError)
      return c.json(
        { error: error.message, request_id: c.get("requestId") },
        error.status,
      );
    if (
      /(?:UNIQUE|CHECK|FOREIGN KEY|NOT NULL) constraint failed/i.test(
        error.message,
      )
    )
      return c.json(
        {
          error: "Data conflicts with an existing record or constraint",
          request_id: c.get("requestId"),
        },
        409,
      );
    console.error(
      JSON.stringify({ request_id: c.get("requestId"), error: error.name }),
    );
    return c.json(
      {
        error: "Storage or service unavailable",
        request_id: c.get("requestId"),
      },
      503,
    );
  });
  app.use("*", async (c, next) => {
    // No public health/assets route, no development bypass and no browser admin ID.
    const identity = await identityProvider.verify(c.req.raw, c.env);
    if (!c.env.DB) throw new HttpError(503, "D1 binding required");
    if (!c.env.APP_ORIGIN)
      throw new HttpError(503, "Private origin configuration required");
    const principal = await resolvePrincipal(c.env.DB, identity, c.env);
    if (
      c.req.method !== "GET" &&
      c.req.method !== "HEAD" &&
      c.req.header("Origin") !== c.env.APP_ORIGIN
    )
      throw new HttpError(403, "Origin rejected");
    if (
      c.env.RATE_LIMITER &&
      !(await c.env.RATE_LIMITER.limit({ key: principal.id })).success
    )
      throw new HttpError(429, "Too many requests");
    let recordSession = false;
    if (c.env.MULTIUSER_ENABLED === "true" && identity.sessionHash) {
      const r = await c.env.DB.prepare(
        "SELECT p.auth_not_before,EXISTS(SELECT 1 FROM revoked_sessions WHERE session_hash=? AND expires_at>unixepoch()) AS revoked,EXISTS(SELECT 1 FROM observed_sessions WHERE session_hash=?) AS observed FROM profiles p WHERE p.id=?",
      )
        .bind(identity.sessionHash, identity.sessionHash, principal.id)
        .first<{
          auth_not_before: number;
          revoked: number;
          observed: number;
        }>();
      if (!r || r.revoked || (identity.issuedAt ?? 0) <= r.auth_not_before)
        throw new HttpError(401, "Session revoked; sign in again");
      recordSession = !r.observed;
    }
    if (
      c.env.MULTIUSER_ENABLED === "true" &&
      recordSession &&
      identity.sessionHash &&
      identity.expiresAt
    ) {
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT OR IGNORE INTO observed_sessions(session_hash,user_id,expires_at) VALUES(?,?,?)",
        ).bind(identity.sessionHash, principal.id, identity.expiresAt),
        c.env.DB.prepare(
          "INSERT INTO security_events(id,actor_id,action,resource_id) SELECT ?,?,'session.authenticated',? WHERE changes()>0",
        ).bind(crypto.randomUUID(), principal.id, principal.id),
      ]);
    }
    c.set("principal", principal);
    const store = new Store(c.env.DB, principal.id, identity);
    store.multiuser = c.env.MULTIUSER_ENABLED === "true";
    store.accessSchema =
      store.multiuser ||
      !!(await c.env.DB.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='access_invitations'",
      ).first());
    store.ownerOnly =
      store.accessSchema && principal.id === c.env.ADMIN_USER_ID;
    c.set("store", store);
    if (
      c.req.path.startsWith("/api/v1/") &&
      principal.id !== c.env.ADMIN_USER_ID
    )
      await authorizeMemberRequest(c);
    await next();
  });
  const uuid = z.uuid();
  async function body<T>(
    c: { req: { json: () => Promise<unknown> } },
    schema: ZodType<T>,
  ): Promise<T> {
    const result = schema.safeParse(await c.req.json().catch(() => null));
    if (!result.success) throw new HttpError(400, "Invalid request data");
    return result.data;
  }
  function id(value: unknown) {
    const parsed = uuid.safeParse(value);
    if (!parsed.success)
      throw new HttpError(400, "Valid resource identifier required");
    return parsed.data;
  }
  app.get("/api/v1/health", (c) =>
    c.json({
      service: "forgebridge-api",
      database: "d1",
      mode: "private-developer",
    }),
  );
  app.get("/api/v1/me", async (c) =>
    c.json({
      ...(await c.get("store").me()),
      is_primary_admin: c.get("principal").id === c.env.ADMIN_USER_ID,
    }),
  );
  app.patch("/api/v1/me", async (c) =>
    c.json(await c.get("store").preferences(await body(c, preferencesSchema))),
  );
  app.post("/api/v1/organizations", async (c) => {
    const v = await body(
      c,
      z.object({ name: z.string().trim().min(1).max(160) }),
    );
    return c.json(await c.get("store").createOrganization(v.name), 201);
  });
  app.get("/api/v1/projects", async (c) =>
    c.json(await c.get("store").projects(id(c.req.query("organization_id")))),
  );
  app.get("/api/v1/projects/search", async (c) => {
    const s = c.get("store"),
      org = id(c.req.query("organization_id"));
    await s.requireOrg(org);
    const g = s.scopeProject("p");
    const q = (c.req.query("q") ?? "").slice(0, 160);
    const status = c.req.query("status") ?? "";
    const page =
      Math.max(0, Math.min(10000, Number(c.req.query("page")) || 0)) | 0;
    const rows = await s.all(
      `SELECT p.*,COALESCE(p.lifecycle_status,p.status) AS status,(SELECT count(*) FROM documents d WHERE d.project_id=p.id AND d.status<>'archived') AS document_count,(SELECT group_concat(s.name,', ') FROM project_suppliers ps JOIN suppliers s ON s.id=ps.supplier_id WHERE ps.project_id=p.id) AS supplier_names FROM projects p WHERE p.organization_id=? AND ${g.text} AND (?='' OR instr(lower(p.name||' '||p.code||' '||p.description),lower(?))>0) AND (?='' OR COALESCE(p.lifecycle_status,p.status)=?) ORDER BY p.updated_at DESC,p.id LIMIT 51 OFFSET ?`,
      org,
      ...g.args,
      q,
      q,
      status,
      status,
      page * 50,
    );
    return c.json({
      items: rows.slice(0, 50),
      hasMore: rows.length > 50,
      page,
    });
  });
  app.post("/api/v1/projects", async (c) =>
    c.json(
      await c.get("store").saveProject(
        await body(
          c,
          projectSchema.extend({
            organization_id: uuid,
            id: uuid.nullable().default(null),
          }),
        ),
      ),
      201,
    ),
  );
  app.get("/api/v1/suppliers", async (c) =>
    c.json(await c.get("store").suppliers(id(c.req.query("organization_id")))),
  );
  app.post("/api/v1/suppliers", async (c) =>
    c.json(
      await c.get("store").saveSupplier(
        await body(
          c,
          supplierSchema.extend({
            organization_id: uuid,
            id: uuid.nullable().default(null),
          }),
        ),
      ),
      201,
    ),
  );
  app.get("/api/v1/organization_memberships", async (c) =>
    c.json(await c.get("store").members(id(c.req.query("organization_id")))),
  );
  app.patch("/api/v1/organization_memberships/:user", async (c) => {
    if (c.get("store").accessSchema)
      throw new HttpError(409, "Use reviewed project access controls");
    const v = await body(
      c,
      z.object({
        organization_id: uuid,
        role: z.enum(roles),
        active: z.boolean(),
      }),
    );
    return c.json(
      await c
        .get("store")
        .setOrgMember(
          v.organization_id,
          id(c.req.param("user")),
          v.role,
          v.active,
        ),
    );
  });
  app.get("/api/v1/projects/:id/collaborators", async (c) =>
    c.json(await c.get("store").collaborators(id(c.req.param("id")))),
  );
  app.post("/api/v1/projects/:id/suppliers", async (c) => {
    const v = await body(c, z.object({ supplier_id: uuid }));
    return c.json(
      await c.get("store").linkSupplier(id(c.req.param("id")), v.supplier_id),
    );
  });
  app.patch("/api/v1/projects/:id/collaborators/:user", async (c) => {
    if (c.get("store").accessSchema)
      throw new HttpError(409, "Use reviewed project access controls");
    const v = await body(
      c,
      z.object({ role: z.enum(roles).exclude(["owner"]), active: z.boolean() }),
    );
    return c.json(
      await c
        .get("store")
        .setProjectMember(
          id(c.req.param("id")),
          id(c.req.param("user")),
          v.role,
          v.active,
        ),
    );
  });
  app.get("/api/v1/audit_events", async (c) =>
    c.json(await c.get("store").audit(id(c.req.query("organization_id")))),
  );
  app.get("/api/v1/invitations", async (c) =>
    c.json(
      await c.get("store").invitations(id(c.req.query("organization_id"))),
    ),
  );
  app.post("/api/v1/invitations", async (c) =>
    c.json(
      await c.get("store").createInvitation(await body(c, invitationSchema)),
      201,
    ),
  );
  app.post("/api/v1/invitations/accept", () => {
    throw new HttpError(
      409,
      "Supplier accounts and invitation acceptance are not enabled in private developer mode",
    );
  });
  app.delete("/api/v1/invitations/:id", async (c) =>
    c.json(await c.get("store").revokeInvitation(id(c.req.param("id")))),
  );
  app.route("/api/v1/access", accessRoutes(invitationFetcher));
  app.route("/api/v1/collaboration", collaborationRoutes());
  app.route("/", documentRoutes());
  app.route("/", reviewRoutes());
  app.route("/", communicationRoutes());
  app.route("/", approvalRoutes());
  app.route("/api/v1", translationRoutes(translationProviderFactory));
  app.all("/api/*", () => {
    throw new HttpError(404, "Not found");
  });
  app.all("*", async (c) => serveFrontend(c.req.raw, c.env, fetcher));
  return app;
}
export default createApp();
