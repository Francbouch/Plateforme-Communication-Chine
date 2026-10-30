import { next } from "@vercel/functions/middleware";
export const config = { matcher: "/(.*)" };
/** Vercel origin lock: shared random secret is server-to-server, never VITE_*. */
export async function protectOrigin(
  request: Request,
  secret: string | undefined,
): Promise<Response> {
  if (!secret || secret.length < 43)
    return new Response("Private origin is not configured", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  const received = request.headers.get("X-ForgeBridge-Origin-Key");
  if (!received || received.length > 1024)
    return new Response("Private ForgeBridge origin", {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    });
  const hash = async (v: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)),
    );
  const [a, b] = await Promise.all([hash(secret), hash(received)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff)
    return new Response("Private ForgeBridge origin", {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    });
  return next({ headers: { "Cache-Control": "private, no-store" } });
}
export default function middleware(request: Request) {
  const path = new URL(request.url).pathname;
  // Public UI demonstration only; API and private pages remain locked.
  if (
    path === "/demo" ||
    path.startsWith("/demo/") ||
    path.startsWith("/assets/")
  )
    return next();
  return protectOrigin(request, process.env.ORIGIN_SHARED_SECRET);
}
