import {
  HttpError,
  type Bindings,
  type Identity,
  type Principal,
} from "./types";
export async function authHash(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export async function authHmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return [
    ...new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export async function eligibleEmail(
  env: Bindings,
  email: string,
): Promise<boolean> {
  const db = env.DB!;
  const linked = await db
    .prepare(
      "SELECT p.status,p.email FROM email_auth_links l JOIN profiles p ON p.id=l.profile_id WHERE l.email=?",
    )
    .bind(email)
    .first<{ status: string; email: string }>();
  if (linked) {
    if (linked.status !== "active" || linked.email.toLowerCase() !== email)
      return false;
    return !!(await db
      .prepare(
        "SELECT 1 FROM email_auth_links l WHERE l.email=? AND (EXISTS(SELECT 1 FROM organization_memberships m WHERE m.user_id=l.profile_id AND m.active=1) OR EXISTS(SELECT 1 FROM email_auth_enrollments e WHERE e.profile_id=l.profile_id) OR EXISTS(SELECT 1 FROM access_invitations i WHERE i.email=l.email AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
      )
      .bind(email)
      .first());
  }
  const enrollment = await db
    .prepare(
      "SELECT 1 FROM email_auth_enrollments e JOIN profiles p ON p.id=e.profile_id WHERE e.email=? AND p.status='active' AND (p.email IS NULL OR lower(p.email)=e.email)",
    )
    .bind(email)
    .first();
  if (enrollment) return true;
  // Existing profiles never get linked merely because their email matches.
  if (
    await db
      .prepare("SELECT 1 FROM profiles WHERE lower(email)=?")
      .bind(email)
      .first()
  )
    return false;
  return !!(await db
    .prepare(
      "SELECT 1 FROM access_invitations WHERE email=? AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    )
    .bind(email)
    .first());
}
/** Verified Better Auth email + explicit enrollment or still-valid invitation. No owner bootstrap. */
export async function ensureEmailLink(env: Bindings, userId: string) {
  const db = env.DB!;
  const user = await db
    .prepare("SELECT email,emailVerified FROM email_auth_user WHERE id=?")
    .bind(userId)
    .first<{ email: string; emailVerified: number }>();
  if (!user?.emailVerified || !(await eligibleEmail(env, user.email)))
    throw new HttpError(403, "Account enrollment required");
  const link = await db
    .prepare(
      "SELECT profile_id,email FROM email_auth_links WHERE auth_user_id=?",
    )
    .bind(userId)
    .first<{ profile_id: string; email: string }>();
  if (link) {
    const profile = await db
      .prepare(
        "SELECT 1 FROM profiles WHERE id=? AND lower(email)=? AND status='active'",
      )
      .bind(link.profile_id, user.email)
      .first();
    if (!profile || link.email !== user.email)
      throw new HttpError(403, "Account unavailable");
    return link.profile_id;
  }
  const candidate = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        "UPDATE profiles SET email=? WHERE email IS NULL AND status='active' AND id=(SELECT profile_id FROM email_auth_enrollments WHERE email=?)",
      )
      .bind(user.email, user.email),
    db
      .prepare(
        `INSERT INTO profiles(id,email,name) SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM profiles WHERE lower(email)=?) AND NOT EXISTS(SELECT 1 FROM email_auth_enrollments WHERE email=?) AND EXISTS(SELECT 1 FROM access_invitations WHERE email=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .bind(
        candidate,
        user.email,
        user.email.slice(0, 120),
        user.email,
        user.email,
        user.email,
      ),
    db
      .prepare(
        "INSERT OR IGNORE INTO email_auth_links(auth_user_id,profile_id,email) SELECT ?,p.id,? FROM profiles p WHERE lower(p.email)=? AND p.status='active' AND (p.id=? OR p.id=(SELECT profile_id FROM email_auth_enrollments WHERE email=?))",
      )
      .bind(userId, user.email, user.email, candidate, user.email),
    db
      .prepare(
        "INSERT INTO security_events(id,actor_id,action,resource_id) SELECT ?,profile_id,'identity.email_linked',profile_id FROM email_auth_links WHERE auth_user_id=? AND changes()>0",
      )
      .bind(crypto.randomUUID(), userId),
  ]);
  const confirmed = await db
    .prepare(
      "SELECT profile_id FROM email_auth_links WHERE auth_user_id=? AND email=?",
    )
    .bind(userId, user.email)
    .first<{ profile_id: string }>();
  if (!confirmed)
    throw new HttpError(403, "Reviewed identity linking required");
  return confirmed.profile_id;
}
export async function emailPrincipal(
  env: Bindings,
  identity: Identity,
): Promise<Principal> {
  const profile = await ensureEmailLink(env, identity.subject);
  if (
    profile === env.ADMIN_USER_ID &&
    identity.email !== env.ADMIN_EMAIL?.trim().toLowerCase()
  )
    throw new HttpError(403, "Administrator identity mismatch");
  return { id: profile, identity };
}
