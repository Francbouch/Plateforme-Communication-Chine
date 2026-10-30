import { z } from "zod";
export const documentStatuses = [
  "draft",
  "in_review",
  "to_approve",
  "approved",
  "rejected",
  "archived",
] as const;
export const maxUploadBytes = 50 * 1024 * 1024;
export const fileTypes: Record<string, string> = {
  pdf: "application/pdf",
  step: "application/step",
  stp: "application/step",
  stl: "model/stl",
  dxf: "application/dxf",
  dwg: "application/acad",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export const folderSchema = z.object({
  name: z.string().trim().min(1).max(160),
  parent_id: z.uuid().nullable().default(null),
});
export const documentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  number: z.string().trim().max(80).default(""),
  description: z.string().max(4000).default(""),
  folder_id: z.uuid().nullable().default(null),
  status: z.enum(documentStatuses).default("draft"),
});
export const uploadSchema = documentSchema.extend({
  document_id: z.uuid().nullable().default(null),
  label: z.string().trim().min(1).max(40).default("A"),
  change_description: z.string().max(4000).default(""),
  filename: z
    .string()
    .min(1)
    .max(240)
    .refine((s) => !/[\x00-\x1f/\\]/.test(s)),
  size: z.number().int().min(1).max(maxUploadBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export interface Folder {
  id: string;
  project_id: string;
  parent_id: string | null;
  name: string;
  archived: number;
}
export interface Revision {
  id: string;
  document_id: string;
  ordinal: number;
  label: string;
  change_description: string;
  filename: string;
  extension: string;
  content_type: string;
  size: number;
  sha256: string;
  created_at: string;
}
export interface DocumentInfo {
  id: string;
  project_id: string;
  folder_id: string | null;
  name: string;
  number: string;
  description: string;
  status: string;
  created_at: string;
  updated_at: string;
}
export interface DocumentRow extends DocumentInfo {
  revision_id: string;
  label: string;
  extension: string;
  size: number;
}
export interface DocumentDetail {
  hasMoreRevisions: boolean;
  hasMoreHistory: boolean;
  document: DocumentInfo;
  revisions: Revision[];
  history: {
    id: string;
    from_status: string | null;
    to_status: string;
    created_at: string;
  }[];
}
export interface Page<T> {
  items: T[];
  hasMore: boolean;
  page: number;
}
