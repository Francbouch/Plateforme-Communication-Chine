import { approveEmailEnrollment } from "./email-management";
import { resolvePrincipal } from "./database";
import type { IdentityProvider } from "./identity";
import { HttpError, type Bindings } from "./types";
/** Independent Access-only recovery. Native cookies cannot authorize this endpoint. */
export async function emailRecovery(
  request: Request,
  env: Bindings,
  provider: IdentityProvider,
) {
  const identity = await provider.verify(request, {
    ...env,
    ACCESS_AUD: env.RECOVERY_ACCESS_AUD ?? env.ACCESS_AUD,
  });
  if (identity.provider !== "cloudflare-access")
    throw new HttpError(403, "Independent recovery identity required");
  if (!env.DB) throw new HttpError(503, "D1 unavailable");
  const principal = await resolvePrincipal(env.DB, identity, env);
  if (
    principal.id !== env.ADMIN_USER_ID ||
    identity.email !== env.ADMIN_EMAIL?.trim().toLowerCase()
  )
    throw new HttpError(403, "Administrator required");
  const schema = await env.DB.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_auth_control'",
  ).first();
  if (!schema)
    throw new HttpError(
      503,
      "Reviewed email authentication migration required",
    );
  if (
    identity.sessionHash &&
    (await env.DB.prepare(
      "SELECT 1 FROM revoked_sessions WHERE session_hash=? AND expires_at>unixepoch()",
    )
      .bind(identity.sessionHash)
      .first())
  )
    throw new HttpError(401, "Recovery session revoked");
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/recovery") {
    // A read alone is not proof that the recovery action works.
  } else if (request.method === "POST" && path === "/recovery/action") {
    if (request.headers.get("Origin") !== env.APP_ORIGIN)
      throw new HttpError(403, "Origin rejected");
    const type = request.headers.get("Content-Type") ?? "";
    const input = type.startsWith("application/json")
      ? await request.json()
      : Object.fromEntries(new URLSearchParams(await request.text()));
    const action = (input as { action?: unknown }).action;
    if (action === "verify-recovery") {
      if (
        !env.RECOVERY_ACCESS_AUD ||
        env.RECOVERY_ACCESS_AUD === env.ACCESS_AUD
      )
        throw new HttpError(
          409,
          "Separate recovery Access application required",
        );
      await env.DB.prepare(
        "UPDATE email_auth_control SET recovery_verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1",
      ).run();
    } else if (action === "enroll-admin")
      await approveEmailEnrollment(
        env,
        principal,
        principal.id,
        identity.email,
      );
    else if (action === "disable")
      await env.DB.prepare(
        "UPDATE email_auth_control SET enabled=0,suspended=1 WHERE id=1",
      ).run();
    else if (action === "stage" && env.EMAIL_AUTH_ENABLED === "staging")
      await env.DB.prepare(
        "UPDATE email_auth_control SET suspended=0,enabled=0 WHERE id=1",
      ).run();
    else if (action === "revoke-native")
      await env.DB.prepare(
        "DELETE FROM email_auth_session WHERE userId IN(SELECT auth_user_id FROM email_auth_links WHERE profile_id=?)",
      )
        .bind(principal.id)
        .run();
    else if (action === "enable") {
      if (
        env.EMAIL_AUTH_SECURITY_REVIEWED !== "true" ||
        !/^[a-f0-9]{64}$/i.test(env.EMAIL_AUTH_BACKUP_PROOF ?? "")
      )
        throw new HttpError(
          409,
          "Reviewed backup and security checks required",
        );
      const result = await env.DB.prepare(
        "UPDATE email_auth_control SET enabled=1,suspended=0 WHERE id=1 AND admin_verified_at IS NOT NULL AND recovery_verified_at IS NOT NULL AND EXISTS(SELECT 1 FROM email_auth_links l JOIN email_auth_session s ON s.userId=l.auth_user_id WHERE l.profile_id=? AND s.expiresAt>?)",
      )
        .bind(principal.id, new Date().toISOString())
        .run();
      if (!result.meta.changes)
        throw new HttpError(
          409,
          "Verified administrator sign-in and recovery required",
        );
    } else throw new HttpError(400, "Unknown recovery action");
    await env.DB.prepare(
      "INSERT INTO security_events(id,actor_id,action,resource_id) VALUES(?,?,'auth.recovery_action',?)",
    )
      .bind(crypto.randomUUID(), principal.id, String(action))
      .run();
    return new Response(null, {
      status: 303,
      headers: {
        Location: new URL("/recovery", env.APP_ORIGIN).href,
        "Cache-Control": "private, no-store",
      },
    });
  } else throw new HttpError(404, "Not found");
  return new Response(
    `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ForgeBridge — Récupération</title><h1>ForgeBridge — Récupération administrateur</h1><p>Identité Cloudflare Access indépendante vérifiée. Aucune modification des projets ou fichiers.</p><form method="post" action="/recovery/action"><button name="action" value="verify-recovery">Confirmer le fonctionnement de la récupération</button></form><form method="post" action="/recovery/action"><button name="action" value="enroll-admin">Autoriser mon compte administrateur par courriel</button></form><form method="post" action="/recovery/action"><button name="action" value="revoke-native">Révoquer mes sessions par courriel</button></form><form method="post" action="/recovery/action"><button name="action" value="disable">Désactiver la connexion par courriel</button></form><form method="post" action="/recovery/action"><button name="action" value="enable">Activer après connexion, récupération et sauvegarde vérifiées</button></form><form method="post" action="/recovery/action"><button name="action" value="stage">Réouvrir le test protégé en mode staging</button></form><p>Après désactivation, rétablissez EMAIL_AUTH_ENABLED=off et la politique Access initiale pour revenir au fonctionnement historique. Cette page reste protégée par Access.</p><a href="/login">Tester la connexion par courriel</a></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy":
          "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
