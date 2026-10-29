import { z } from "zod";
export const locales = ["fr-CA", "en", "zh-CN"] as const;
export const roles = [
  "owner",
  "project_admin",
  "designer",
  "supplier_manager",
  "supplier_engineer",
  "reviewer",
] as const;
export type Role = (typeof roles)[number];
export const projectSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(4000).default(""),
  status: z.enum(["active", "paused", "archived"]).default("active"),
});
export const supplierSchema = z.object({
  name: z.string().trim().min(1).max(160),
  country: z.string().trim().min(2).max(80),
  language: z.enum(locales),
  contacts: z.string().max(2000).default(""),
  internal_notes: z.string().max(4000).default(""),
  status: z.enum(["active", "inactive"]).default("active"),
});
export const invitationSchema = z
  .object({
    email: z.email(),
    role: z.enum(roles).exclude(["owner"]),
    project_id: z.uuid(),
    supplier_id: z.uuid().nullable(),
    expires_days: z.number().int().min(1).max(14).default(7),
  })
  .refine((v) => v.role.startsWith("supplier_") === Boolean(v.supplier_id), {
    message:
      "Supplier roles require a supplier; internal roles must not have one.",
  });
export const preferencesSchema = z.object({
  name: z.string().trim().min(1).max(120),
  language: z.enum(locales),
  timezone: z
    .string()
    .max(80)
    .refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, "Invalid timezone"),
});
export interface Project {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  description: string;
  status: string;
  updated_at: string;
}
export interface Supplier {
  id: string;
  organization_id: string;
  name: string;
  country: string;
  language: string;
  contacts: string;
  status: string;
  internal_notes: string;
  supplier_notes?: { internal_notes: string } | null;
}
export interface Profile {
  id: string;
  name: string;
  language: string;
  timezone: string;
}
export interface Organization {
  id: string;
  name: string;
  role: Role;
}
