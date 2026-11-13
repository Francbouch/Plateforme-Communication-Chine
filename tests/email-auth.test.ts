import { beforeAll, beforeEach, afterEach, it, expect } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { migrate } from "./helpers/d1";
let script: string, runtime: Miniflare;
beforeAll(async () => {
  const out = await build({
    stdin: {
      contents: `import {createEmailAuth} from './apps/api/src/email-auth';let code='';export default {async fetch(req,env){if(new URL(req.url).pathname==='/test-mail')return Response.json({code});const auth=createEmailAuth(env,async(url,init)=>{const msg=JSON.parse(init.body);code=msg.text.match(/\\b[0-9]{8}\\b/)[0];return Response.json({id:'test-only'});});return auth.handler(req);}};`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["node:*"],
    write: false,
  });
  script = out.outputFiles[0].text;
});
beforeEach(async () => {
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: "2026-10-29",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "email-auth" },
      bindings: {
        APP_ORIGIN: "https://private.test",
        BETTER_AUTH_SECRET: "local-test-only-secret-" + "a".repeat(40),
        AUTH_FROM: "test@example.test",
        RESEND_API_KEY: "test-only",
      },
    }),
  );
  const db = (await runtime.getD1Database("DB")) as unknown as D1Database;
  await migrate(db);
  await db
    .prepare(
      "INSERT INTO profiles(id,email,name) VALUES('root','test@example.test','Existing')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO email_auth_enrollments(email,profile_id,approved_by) VALUES('test@example.test','root','root')",
    )
    .run();
});
afterEach(async () => {
  await runtime.dispose();
});
async function request(path: string, body?: unknown, cookie = "") {
  return runtime.dispatchFetch("https://private.test" + path, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: "https://private.test",
      "Content-Type": "application/json",
      Cookie: cookie,
      "cf-connecting-ip": "192.0.2.1",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
it("runs Better Auth OTP with the real D1 dialect in workerd and consumes a code exactly once", async () => {
  const r = await request("/api/auth/email-otp/send-verification-otp", {
    email: "test@example.test",
    type: "sign-in",
  });
  expect(r.status, await r.text()).toBe(200);
  const { code } = (await (await request("/test-mail")).json()) as {
    code: string;
  };
  expect(code).toMatch(/^\d{8}$/);
  const signin = await request("/api/auth/sign-in/email-otp", {
    email: "test@example.test",
    otp: code,
  });
  expect(signin.status, await signin.text()).toBe(200);
  const cookie = signin.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Secure");
  const session = await request(
    "/api/auth/get-session",
    undefined,
    cookie.split(";")[0],
  );
  expect(
    ((await session.json()) as { user: { email: string } }).user.email,
  ).toBe("test@example.test");
  expect(
    (
      await request("/api/auth/sign-in/email-otp", {
        email: "test@example.test",
        otp: code,
      })
    ).status,
  ).toBeGreaterThanOrEqual(400);
});
