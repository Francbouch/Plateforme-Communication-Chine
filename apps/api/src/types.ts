export interface Bindings {
  MULTIUSER_ENABLED?: string;
  RESEND_API_KEY?: string;
  INVITATION_FROM?: string;
  TRANSLATION_ENABLED?: string;
  DEEPL_API_KEY?: string;
  TRANSLATION_DAILY_REQUESTS?: string;
  TRANSLATION_DAILY_CHARACTERS?: string;
  TRANSLATION_PER_MINUTE?: string;
  DB?: D1Database;
  DOCUMENTS?: R2Bucket;
  APP_ORIGIN?: string;
  ACCESS_ISSUER?: string;
  ACCESS_AUD?: string;
  ADMIN_EMAIL?: string;
  ADMIN_USER_ID?: string;
  ADMIN_NAME?: string;
  VERCEL_ORIGIN?: string;
  ORIGIN_SHARED_SECRET?: string;
  RATE_LIMITER?: {
    limit(input: { key: string }): Promise<{ success: boolean }>;
  };
}
export interface Identity {
  provider: "cloudflare-access";
  issuer: string;
  subject: string;
  email: string;
  issuedAt?: number;
  expiresAt?: number;
  sessionHash?: string;
}
export interface Principal {
  id: string;
  identity: Identity;
}
export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}
