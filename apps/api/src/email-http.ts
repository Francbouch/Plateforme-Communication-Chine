import { APIError } from "better-auth/api";
import { createEmailAuth } from "./email-auth";
import { authHash, authHmac, eligibleEmail } from "./email-accounts";
import { HttpError, type Bindings, type Identity } from "./types";
import { z } from "zod";
export function emailAuthConfigured(env: Bindings) {
  if (!["staging", "true"].includes(env.EMAIL_AUTH_ENABLED ?? "")) return false;
  if (
    !env.DB ||
    !env.APP_ORIGIN ||
    !env.BETTER_AUTH_SECRET ||
    env.BETTER_AUTH_SECRET.length < 43 ||
    !env.AUTH_FROM ||
    !env.RESEND_API_KEY ||
    env.MULTIUSER_ENABLED !== "true"
  )
    return false;
  try {
    const url = new URL(env.APP_ORIGIN);
    return (
      url.origin === env.APP_ORIGIN &&
      (url.protocol === "https:" ||
        ["127.0.0.1", "localhost"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}
export async function emailAuthEnabled(env: Bindings) {
  if (!emailAuthConfigured(env)) return false;
  const schema = await env
    .DB!.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_auth_control'",
    )
    .first();
  if (!schema) return false;
  const control = await env
    .DB!.prepare("SELECT enabled,suspended FROM email_auth_control WHERE id=1")
    .first<{ enabled: number; suspended: number }>();
  return (
    !!control &&
    control.suspended === 0 &&
    (env.EMAIL_AUTH_ENABLED === "staging" || control.enabled === 1)
  );
}
async function quota(
  env: Bindings,
  subject: string,
  seconds: number,
  max: number,
) {
  const now = Math.floor(Date.now() / 1000),
    window = Math.floor(now / seconds);
  const key = await authHmac(
    env.BETTER_AUTH_SECRET!,
    `rate:${seconds}:${window}:${subject}`,
  );
  const row = await env
    .DB!.prepare(
      "INSERT INTO email_auth_windows(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
    )
    .bind(key, (window + 1) * seconds)
    .first<{ count: number }>();
  if (!row || row.count > max)
    throw new HttpError(429, "Authentication rate limit reached");
}
export async function nativeIdentity(
  request: Request,
  env: Bindings,
  mailer: typeof fetch,
): Promise<Identity | null> {
  let session;
  try {
    session = await createEmailAuth(env, mailer).api.getSession({
      headers: request.headers,
      // Reads must never refresh a revoked or expiring session.
      query: { disableCookieCache: true, disableRefresh: true },
    });
  } catch (error) {
    if (error instanceof APIError && [400, 401, 403].includes(error.statusCode))
      throw new HttpError(401, "Session expired");
    throw error;
  }
  if (!session?.user.emailVerified) return null;
  return {
    provider: "better-auth",
    issuer: env.APP_ORIGIN!,
    subject: session.user.id,
    email: session.user.email.toLowerCase(),
    issuedAt: Math.floor(new Date(session.session.createdAt).getTime() / 1000),
    expiresAt: Math.floor(new Date(session.session.expiresAt).getTime() / 1000),
    sessionHash: await authHash(session.session.token),
  };
}
/** Narrow public surface. No password, social login, user update, token introspection or signup routes. */
export async function emailAuthRequest(
  request: Request,
  env: Bindings,
  mailer: typeof fetch = fetch,
) {
  const path = new URL(request.url).pathname;
  if (path === "/api/auth/config" && request.method === "GET")
    return Response.json(
      { enabled: await emailAuthEnabled(env) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  if (!(await emailAuthEnabled(env)))
    throw new HttpError(503, "Email authentication unavailable");
  const allowed = [
    "/api/auth/email-otp/send-verification-otp",
    "/api/auth/sign-in/email-otp",
    "/api/auth/sign-out",
  ];
  if (!allowed.includes(path) || request.method !== "POST")
    throw new HttpError(404, "Not found");
  if (
    request.headers.get("Origin") !== env.APP_ORIGIN ||
    new URL(request.url).origin !== env.APP_ORIGIN
  )
    throw new HttpError(403, "Origin rejected");
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    throw new HttpError(400, "Invalid authentication request");
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  await quota(env, "global-requests", 60, 300);
  await quota(env, "global-requests", 3600, 2000);
  await quota(env, `ip-auth:${ip}`, 60, 30);
  await quota(env, `ip-auth:${ip}`, 3600, 200);
  let body: Record<string, string> = {};
  if (path !== "/api/auth/sign-out") {
    const input = await request.json().catch(() => null);
    const parsed = z
      .object({
        email: z
          .email()
          .max(254)
          .transform((x) => x.toLowerCase().trim()),
        otp: z
          .string()
          .regex(/^\d{8}$/)
          .optional(),
        type: z.literal("sign-in").optional(),
      })
      .safeParse(input);
    if (!parsed.success)
      throw new HttpError(400, "Invalid authentication request");
    const email = parsed.data.email,
      sending = path.includes("send-verification-otp");
    await quota(env, `email-auth:${email}`, 900, 15);
    if (sending) {
      await quota(env, `email-send:${email}`, 60, 1);
      await quota(env, `email-send:${email}`, 900, 3);
      await quota(env, `email-send:${email}`, 86400, 10);
      await quota(env, `ip-send:${ip}`, 3600, 20);
    }
    const eligible = await eligibleEmail(env, email);
    if (!eligible) {
      if (sending) return Response.json({ ok: true });
      throw new HttpError(401, "Invalid or expired code");
    }
    if (sending) await quota(env, "global-send", 86400, 100);
    if (!sending && !parsed.data.otp)
      throw new HttpError(400, "Invalid authentication request");
    body = sending
      ? { email, type: "sign-in" }
      : { email, otp: parsed.data.otp! };
  }
  const response = await createEmailAuth(env, mailer).handler(
    new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(body),
    }),
  );
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  // Better Auth's sign-in JSON contains a bearer token. Never expose it to frontend JS.
  if (response.ok)
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  // Provider/adapter diagnostics remain server-side and contain no OTP in application logs.
  if (path.includes("send-verification-otp")) {
    await env
      .DB!.prepare(
        "INSERT INTO security_events(id,action) VALUES(?,'email.delivery_failed')",
      )
      .bind(crypto.randomUUID())
      .run();
    return Response.json(
      { ok: true },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }
  throw new HttpError(401, "Invalid or expired code");
}
export async function emailLogout(
  request: Request,
  env: Bindings,
  mailer: typeof fetch = fetch,
) {
  const response = await createEmailAuth(env, mailer).api.signOut({
    headers: request.headers,
    asResponse: true,
  });
  return new Response(JSON.stringify({ logout_url: "/" }), {
    status: response.status,
    headers: response.headers,
  });
}
