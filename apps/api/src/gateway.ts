import { HttpError, type Bindings } from "./types";
export async function serveFrontend(
  request: Request,
  env: Bindings,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (
    !env.VERCEL_ORIGIN ||
    !env.ORIGIN_SHARED_SECRET ||
    env.ORIGIN_SHARED_SECRET.length < 43
  )
    throw new HttpError(503, "Private frontend origin is not configured");
  let origin: URL;
  try {
    origin = new URL(env.VERCEL_ORIGIN);
  } catch {
    throw new HttpError(503, "Invalid frontend origin configuration");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new HttpError(503, "HTTPS frontend origin required");
  if (!["GET", "HEAD"].includes(request.method))
    throw new HttpError(404, "Not found");
  const incoming = new URL(request.url);
  const target = new URL(origin.origin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  const headers = new Headers({
    "X-ForgeBridge-Origin-Key": env.ORIGIN_SHARED_SECRET,
  });
  for (const name of ["accept", "accept-language"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Never forward Access cookies/JWTs or a client-supplied origin key to Vercel.
  let response: Response;
  try {
    response = await fetcher(target, {
      method: request.method,
      headers,
      redirect: "manual",
    });
  } catch {
    throw new HttpError(502, "Frontend origin unavailable");
  }
  if (response.status >= 300 && response.status < 400)
    throw new HttpError(
      502,
      "Frontend origin must not redirect; use its canonical HTTPS host",
    );
  const output = new Headers(response.headers);
  for (const name of [
    "set-cookie",
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "location",
    "x-forgebridge-origin-key",
  ])
    output.delete(name);
  output.set("Cache-Control", "private, no-store");
  output.set("Referrer-Policy", "no-referrer");
  output.set("X-Content-Type-Options", "nosniff");
  output.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  return new Response(response.body, {
    status: response.status,
    headers: output,
  });
}
