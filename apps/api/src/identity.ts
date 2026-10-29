import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Bindings, Identity } from "./types";
import { HttpError } from "./types";
const resolvers = new Map<string, JWTVerifyGetKey>();
export interface IdentityProvider {
  verify(request: Request, env: Bindings): Promise<Identity>;
}
export class AccessIdentityProvider implements IdentityProvider {
  constructor(private testKeyResolver?: JWTVerifyGetKey) {}
  async verify(request: Request, env: Bindings): Promise<Identity> {
    const issuer = env.ACCESS_ISSUER;
    if (
      !issuer ||
      !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) ||
      !env.ACCESS_AUD
    )
      throw new HttpError(503, "Access configuration required");
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token || token.length > 16384)
      throw new HttpError(401, "Cloudflare Access session required");
    let resolver = this.testKeyResolver;
    if (!resolver) {
      resolver = resolvers.get(issuer);
      if (!resolver) {
        resolver = createRemoteJWKSet(
          new URL(`${issuer}/cdn-cgi/access/certs`),
          {
            timeoutDuration: 5000,
            cooldownDuration: 30000,
            cacheMaxAge: 600000,
          },
        );
        resolvers.set(issuer, resolver);
      }
    }
    try {
      const { payload } = await jwtVerify(token, resolver, {
        issuer,
        audience: env.ACCESS_AUD,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "email", "iat", "exp", "aud", "iss"],
        clockTolerance: 0,
      });
      if (
        typeof payload.iat !== "number" ||
        payload.iat > Math.floor(Date.now() / 1000) ||
        payload.type !== "app" ||
        typeof payload.sub !== "string" ||
        !payload.sub ||
        typeof payload.email !== "string" ||
        !payload.email.includes("@")
      )
        throw new Error("Invalid identity");
      return {
        provider: "cloudflare-access",
        issuer,
        subject: payload.sub,
        email: payload.email.trim().toLowerCase(),
      };
    } catch {
      throw new HttpError(401, "Invalid or expired Access session");
    }
  }
}
