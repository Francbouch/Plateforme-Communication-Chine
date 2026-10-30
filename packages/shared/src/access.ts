import { z } from "zod";
export const permissionNames = [
  "view_project",
  "view_documents",
  "download_documents",
  "add_documents",
  "add_revisions",
  "annotate",
  "create_points",
  "reply_points",
  "view_conversations",
  "participate_conversations",
  "create_requests",
  "view_approvals",
  "approve",
  "manage_members",
  "translate",
  "correct_translations",
] as const;
export type Permission = (typeof permissionNames)[number];
export type Permissions = Record<Permission, boolean>;
export const accessRoles = [
  "project_admin",
  "designer",
  "supplier_engineer",
  "reviewer",
] as const;
export type AccessRole = (typeof accessRoles)[number];
export function rolePermissions(role: string): Permissions {
  const p = Object.fromEntries(
    permissionNames.map((k) => [k, false]),
  ) as Permissions;
  for (const k of [
    "view_project",
    "view_documents",
    "download_documents",
    "view_conversations",
    "translate",
  ] as const)
    p[k] = true;
  if (role !== "reviewer")
    for (const k of [
      "reply_points",
      "participate_conversations",
      "correct_translations",
    ] as const)
      p[k] = true;
  if (["designer", "project_admin"].includes(role))
    for (const k of [
      "add_documents",
      "add_revisions",
      "annotate",
      "create_points",
      "create_requests",
      "view_approvals",
    ] as const)
      p[k] = true;
  if (role === "project_admin") p.manage_members = true;
  return p;
}
export const permissionsSchema = z.record(z.enum(permissionNames), z.boolean());
export const accessInvite = z
  .object({
    email: z.email().transform((v) => v.trim().toLowerCase()),
    role: z.enum(accessRoles),
    project_ids: z.array(z.uuid()).min(1).max(20),
    supplier_id: z.uuid().nullable().default(null),
    message: z.string().trim().max(1000).default(""),
    expires_days: z.number().int().min(1).max(14).default(7),
  })
  .refine((v) => v.role.startsWith("supplier_") === !!v.supplier_id);
export interface ProjectAccess {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  role: string;
  external: boolean;
  permissions: Permissions;
}
