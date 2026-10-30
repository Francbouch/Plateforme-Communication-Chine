/** TEST FIXTURE ONLY. Bound to loopback, ephemeral signing keys and isolated D1.
 * This is never imported by the Worker or Vercel build and is not an identity provider.
 */
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { createApp } from "../../apps/api/src/index";
import { AccessIdentityProvider } from "../../apps/api/src/identity";
import { migrate } from "./d1";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { protectOrigin } from "../../middleware";
import type { Bindings } from "../../apps/api/src/types";
const folder = await mkdtemp(join(tmpdir(), "forgebridge-browser-"));
const keys = await generateKeyPair("RS256");
const publicKey = await exportJWK(keys.publicKey);
const issuer = "https://forgebridge-browser-test.cloudflareaccess.com";
const secret = crypto.randomUUID() + crypto.randomUUID();
const token = await new SignJWT({ email: "browser@example.test", type: "app" })
  .setProtectedHeader({ alg: "RS256", kid: "browser-test" })
  .setIssuer(issuer)
  .setAudience("browser-test")
  .setSubject("isolated-browser-subject")
  .setIssuedAt()
  .setExpirationTime("10m")
  .sign(keys.privateKey);
const env: Bindings = {
  APP_ORIGIN: "http://127.0.0.1:4191",
  ACCESS_ISSUER: issuer,
  ACCESS_AUD: "browser-test",
  ADMIN_EMAIL: "browser@example.test",
  ADMIN_USER_ID: crypto.randomUUID(),
  ADMIN_NAME: "Browser test administrator",
  VERCEL_ORIGIN: "https://test.vercel.app",
  ORIGIN_SHARED_SECRET: secret,
};
const root = resolve("apps/web/dist");
const upstream: typeof fetch = async (input, init) => {
  const request = new Request(String(input), init);
  const guard = await protectOrigin(request, secret);
  if (guard.headers.get("x-middleware-next") !== "1") return guard;
  const path = decodeURIComponent(new URL(request.url).pathname);
  let file = resolve(root, "." + path);
  if (!file.startsWith(root + "/") && file !== root)
    return new Response("Forbidden", { status: 403 });
  let content: Uint8Array;
  try {
    content = await readFile(file);
  } catch {
    file = join(root, "index.html");
    content = await readFile(file);
  }
  const type: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".wasm": "application/wasm",
    ".css": "text/css",
    ".svg": "image/svg+xml",
  };
  return new Response(new Uint8Array(content).buffer, {
    headers: {
      "Content-Type": type[extname(file)] ?? "application/octet-stream",
    },
  });
};
const bundled = await build({
  stdin: {
    contents: `import {createApp} from './apps/api/src/index';import {AccessIdentityProvider} from './apps/api/src/identity';import {createLocalJWKSet} from 'jose';const provider=new AccessIdentityProvider(createLocalJWKSet({keys:[${JSON.stringify({ ...publicKey, kid: "browser-test", alg: "RS256" })}]}));export default createApp(provider);`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
});
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-10-29",
    resourcePersistencePath: folder,
    d1Databases: { DB: "forgebridge-browser" },
    r2Buckets: { DOCUMENTS: "forgebridge-browser-files" },
    bindings: { ...env } as Record<string, string>,
  }),
);
const db = (await runtime.getD1Database("DB")) as unknown as D1Database;
await migrate(db);
env.DB = db;
const app = createApp(
  new AccessIdentityProvider(
    createLocalJWKSet({
      keys: [{ ...publicKey, kid: "browser-test", alg: "RS256" }],
    }),
  ),
  upstream,
);
const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers))
      if (v) headers.set(k, Array.isArray(v) ? v.join(",") : v);
    // Deliberately simulates the Access edge for tests, after independently tested JWT verification.
    headers.set("Cf-Access-Jwt-Assertion", token);
    for (const name of [
      "host",
      "connection",
      "accept-encoding",
      "transfer-encoding",
    ])
      headers.delete(name);
    const options = {
      method: req.method,
      headers: Object.fromEntries(headers),
      body: ["GET", "HEAD"].includes(req.method ?? "GET")
        ? undefined
        : Buffer.concat(chunks),
    };
    const url = "http://127.0.0.1:4191" + req.url;
    const response = req.url?.startsWith("/api/")
      ? await runtime.dispatchFetch(url, options)
      : await app.request(url, options, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body)
      Readable.fromWeb(
        response.body as import("node:stream/web").ReadableStream,
      ).pipe(res);
    else res.end();
  } catch (error) {
    console.error(
      "Test harness request failed",
      error instanceof Error
        ? error.message +
            " " +
            (error.cause instanceof Error
              ? error.cause.message + " " + JSON.stringify(error.cause.cause)
              : JSON.stringify(error.cause))
        : "Unknown error",
    );
    res.writeHead(500);
    res.end("Test harness failed");
  }
});
server.listen(4191, "127.0.0.1", () =>
  console.log("Isolated private browser fixture ready"),
);
async function close() {
  server.close();
  await runtime.dispose();
  await rm(folder, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
