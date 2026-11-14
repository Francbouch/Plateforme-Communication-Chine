import { eligibleEmail, ensureEmailLink, authHmac } from "./email-accounts";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins/email-otp";
import type { Bindings } from "./types";

export function createEmailAuth(env: Bindings, mailer: typeof fetch = fetch) {
  const origin = env.APP_ORIGIN!;
  const secure = origin.startsWith("https:");
  return betterAuth({
    appName: "ForgeBridge",
    baseURL: origin,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB!,
    user: { modelName: "email_auth_user" },
    session: {
      modelName: "email_auth_session",
      expiresIn: 7 * 86400,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    account: {
      modelName: "email_auth_account",
      accountLinking: { enabled: false },
    },
    verification: { modelName: "email_auth_verification" },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "email_auth_rate_limit",
      window: 60,
      max: 30,
    },
    trustedOrigins: [origin],
    advanced: {
      useSecureCookies: secure,
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      cookies: {
        session_token: {
          name: "forgebridge.session_token",
          attributes: { httpOnly: true, secure, sameSite: "lax", path: "/" },
        },
      },
    },
    logger: { disabled: true },
    telemetry: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          before: async (user) =>
            (await eligibleEmail(env, user.email))
              ? { data: { ...user, name: user.email.slice(0, 120) } }
              : false,
        },
      },
      session: {
        create: {
          before: async (session) => {
            await ensureEmailLink(env, session.userId);
            return { data: session };
          },
        },
      },
    },
    plugins: [
      emailOTP({
        otpLength: 8,
        expiresIn: 300,
        allowedAttempts: 5,
        rateLimit: { window: 60, max: 30 },
        storeOTP: {
          hash: (otp) => authHmac(env.BETTER_AUTH_SECRET!, "otp:" + otp),
        },
        resendStrategy: "rotate",
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== "sign-in")
            throw new Error("Unsupported email operation");
          const response = await mailer("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.RESEND_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: env.AUTH_FROM,
              to: [email],
              subject: "ForgeBridge — Code / Sign-in code / 登录验证码",
              text: `ForgeBridge\n\n${otp}\n\nCe code expire dans 5 minutes et ne fonctionne qu’une fois.\nThis code expires in 5 minutes and can only be used once.\n此验证码5分钟内有效，仅可使用一次。\n\nSi vous n’avez pas demandé ce code, ignorez ce message.\nIf you did not request this code, ignore this email.\n如果您没有请求验证码，请忽略此邮件。`,
            }),
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) throw new Error("Mail delivery unavailable");
        },
      }),
    ],
  });
}
