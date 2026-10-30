import { z } from "zod";
export const requestStatuses = [
  "todo",
  "in_progress",
  "waiting",
  "done",
  "cancelled",
] as const;
export const requestPriorities = ["low", "normal", "high", "critical"] as const;
export const referenceSchema = z
  .object({
    document_id: z.uuid().nullable().default(null),
    revision_id: z.uuid().nullable().default(null),
    point_id: z.uuid().nullable().default(null),
    page: z.number().int().min(1).max(10000).nullable().default(null),
  })
  .refine(
    (v) =>
      (!v.revision_id || !!v.document_id) &&
      (!v.point_id || !!v.revision_id) &&
      (!v.page || !!v.revision_id),
  );
export type MessageReference = z.infer<typeof referenceSchema> & {
  id?: string;
  label?: string;
};
export const messageSchema = z
  .object({
    id: z.uuid(),
    body: z.string().trim().max(8000).default(""),
    parent_id: z.uuid().nullable().default(null),
    shared: z.boolean().default(false),
    references: z.array(referenceSchema).max(8).default([]),
    attachments: z.array(z.uuid()).max(5).default([]),
  })
  .refine(
    (v) => !!v.body || v.references.length > 0 || v.attachments.length > 0,
  );
export const requestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(8000).default(""),
  responsible: z.string().trim().max(120).default(""),
  due_date: z.iso.date().nullable().default(null),
  priority: z.enum(requestPriorities).default("normal"),
  status: z.enum(requestStatuses).default("todo"),
  point_id: z.uuid().nullable().default(null),
});
export interface Conversation {
  id: string;
  project_id: string;
  title: string;
  archived: number;
  version: number;
  created_at: string;
  updated_at: string;
  last_message: string | null;
}
export interface Message {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  body: string;
  author_id: string;
  author: string;
  shared: number;
  version: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  reply_count: number;
  references: MessageReference[];
  attachments: MessageAttachment[];
}
export interface MessageAttachment {
  id: string;
  filename: string;
  size: number;
  content_type: string;
  extension: string;
}
export interface TechnicalRequest {
  id: string;
  project_id: string;
  message_id: string;
  conversation_id: string;
  title: string;
  description: string;
  responsible: string;
  due_date: string | null;
  priority: (typeof requestPriorities)[number];
  status: (typeof requestStatuses)[number];
  point_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  document_name?: string;
}
export interface MessagePage<T> {
  items: T[];
  next: string | null;
}
export function referenceUrl(project: string, ref: MessageReference) {
  if (!ref.document_id) return `/projects/${project}/messages`;
  const query = new URLSearchParams({ document: ref.document_id });
  if (ref.revision_id) query.set("revision", ref.revision_id);
  if (ref.page) query.set("pdf_page", String(ref.page));
  if (ref.point_id) query.set("point", ref.point_id);
  return `/projects/${project}/documents?${query}`;
}
