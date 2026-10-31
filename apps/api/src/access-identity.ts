import {
  HttpError,
  type Bindings,
  type Identity,
  type Principal,
} from "./types";
export async function resolveMemberIdentity(
  db: D1Database,
  identity: Identity,
  env: Bindings,
): Promise<Principal | null> {
  if (
    env.MULTIUSER_ENABLED !== "true" ||
    identity.email === env.ADMIN_EMAIL?.trim().toLowerCase()
  )
    return null;
  if (!identity.issuedAt || !identity.expiresAt || !identity.sessionHash)
    throw new HttpError(401, "Verified Access session required");
  const existing = await db
    .prepare(
      "SELECT p.id,p.status,p.email FROM identity_links l JOIN profiles p ON p.id=l.user_id WHERE l.provider=? AND l.issuer=? AND l.subject=?",
    )
    .bind(identity.provider, identity.issuer, identity.subject)
    .first<{ id: string; status: string; email: string }>();
  if (existing) {
    if (existing.status !== "active" || existing.email !== identity.email)
      throw new HttpError(403, "Account unavailable");
    return { id: existing.id, identity };
  }
  const invited = await db
    .prepare(
      "SELECT id FROM access_invitations WHERE email=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') LIMIT 1",
    )
    .bind(identity.email)
    .first();
  if (!invited) throw new HttpError(403, "Invitation required");
  // Never rebind an existing email/profile to another subject automatically.
  const hash = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(identity.issuer + "\0" + identity.subject),
      ),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const existingEmail = await db
    .prepare("SELECT id FROM profiles WHERE lower(email)=?")
    .bind(identity.email)
    .first<{ id: string }>();
  if (existingEmail && existingEmail.id !== id)
    throw new HttpError(403, "Identity linking requires administrator review");
  await db.batch([
    db
      .prepare("INSERT OR IGNORE INTO profiles(id,email,name) VALUES(?,?,?)")
      .bind(id, identity.email, identity.email.slice(0, 120)),
    db
      .prepare(
        "INSERT OR IGNORE INTO identity_links(provider,issuer,subject,user_id) VALUES(?,?,?,?)",
      )
      .bind(identity.provider, identity.issuer, identity.subject, id),
  ]);
  const linked = await db
    .prepare(
      "SELECT p.id FROM profiles p JOIN identity_links l ON l.user_id=p.id WHERE p.id=? AND p.email=? AND p.status='active' AND l.provider=? AND l.issuer=? AND l.subject=?",
    )
    .bind(
      id,
      identity.email,
      identity.provider,
      identity.issuer,
      identity.subject,
    )
    .first();
  if (!linked)
    throw new HttpError(403, "Identity linking requires administrator review");
  return { id, identity };
}
