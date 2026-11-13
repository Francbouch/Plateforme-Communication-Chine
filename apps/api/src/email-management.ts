import { z } from "zod";
import { HttpError, type Bindings, type Principal } from "./types";
import { Store } from "./database";

export async function approveEmailEnrollment(
  env: Bindings,
  principal: Principal,
  userId: string,
  requestedEmail?: string,
) {
  const db = env.DB!;
  if (principal.id !== env.ADMIN_USER_ID)
    throw new HttpError(403, "Administrator required");
  const admin = await db
    .prepare("SELECT 1 FROM profiles WHERE id=? AND status='active'")
    .bind(principal.id)
    .first();
  if (!admin) throw new HttpError(403, "Administrator unavailable");
  const profile = await db
    .prepare("SELECT id,email,status FROM profiles WHERE id=?")
    .bind(userId)
    .first<{ id: string; email: string | null; status: string }>();
  if (!profile || profile.status !== "active")
    throw new HttpError(404, "Account unavailable");
  if (userId === principal.id) {
    if (
      (await db.prepare("SELECT 1 FROM projects LIMIT 1").first()) &&
      !(await db
        .prepare(
          "SELECT 1 FROM organization_memberships WHERE user_id=? AND role='owner' AND active=1",
        )
        .bind(principal.id)
        .first())
    )
      throw new HttpError(
        409,
        "Existing project ownership must be reviewed first",
      );
    // Initial privileged enrollment requires the independent existing Access identity.
    if (
      principal.identity.provider !== "cloudflare-access" ||
      principal.identity.email !== env.ADMIN_EMAIL?.trim().toLowerCase()
    )
      throw new HttpError(403, "Recovery identity required");
  } else if (
    !(await db
      .prepare(
        "SELECT 1 FROM organization_memberships owner JOIN organization_memberships target ON target.organization_id=owner.organization_id WHERE owner.user_id=? AND owner.role='owner' AND owner.active=1 AND target.user_id=? AND target.active=1",
      )
      .bind(principal.id, userId)
      .first())
  )
    throw new HttpError(404, "Account unavailable");
  const email = z
    .email()
    .max(254)
    .parse(
      (
        requestedEmail ??
        profile.email ??
        (userId === principal.id ? env.ADMIN_EMAIL : "") ??
        ""
      )
        .trim()
        .toLowerCase(),
    );
  if (profile.email && profile.email.toLowerCase() !== email)
    throw new HttpError(409, "Existing email does not match");
  if (
    userId === principal.id &&
    email !== env.ADMIN_EMAIL?.trim().toLowerCase()
  )
    throw new HttpError(409, "Administrator identity mismatch");
  if (
    await db
      .prepare("SELECT 1 FROM profiles WHERE lower(email)=? AND id<>?")
      .bind(email, userId)
      .first()
  )
    throw new HttpError(409, "Ambiguous existing email");
  await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO email_auth_enrollments(email,profile_id,approved_by) VALUES(?,?,?)",
      )
      .bind(email, userId, principal.id),
    db
      .prepare(
        "INSERT INTO security_events(id,actor_id,action,resource_id) SELECT ?,?,'identity.enrollment_approved',? WHERE changes()>0",
      )
      .bind(crypto.randomUUID(), principal.id, userId),
  ]);
  const confirmed = await db
    .prepare(
      "SELECT 1 FROM email_auth_enrollments WHERE email=? AND profile_id=?",
    )
    .bind(email, userId)
    .first();
  if (!confirmed) throw new HttpError(409, "Reviewed enrollment conflict");
  return { ok: true, email, profile_id: userId };
}
export async function emailStatus(s: Store) {
  const schema = !!(await s
    .statement(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_auth_control'",
    )
    .first());
  if (!schema) return { schema_ready: false };
  const rows = await s.all(
    "SELECT e.email,e.profile_id,EXISTS(SELECT 1 FROM email_auth_links l WHERE l.profile_id=e.profile_id) AS linked FROM email_auth_enrollments e WHERE e.approved_by=? ORDER BY e.approved_at DESC LIMIT 200",
    s.userId,
  );
  return { schema_ready: true, enrollments: rows };
}
