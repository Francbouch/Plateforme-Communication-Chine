import { z } from "zod";
export const reviewTypes = [
  "marker",
  "rectangle",
  "arrow",
  "freehand",
  "highlight",
  "text",
  "discussion",
] as const;
export const reviewColors = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
] as const;
export const reviewStatuses = [
  "open",
  "in_progress",
  "waiting",
  "resolved",
] as const;
export type ReviewType = (typeof reviewTypes)[number];
export type Point = [number, number];
export interface Geometry {
  points: Point[];
}
export const geometrySchema = z.object({
  points: z
    .array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]))
    .max(256),
});
const fields = z.object({
  color: z.enum(reviewColors).default("red"),
  geometry: geometrySchema,
  content: z.string().max(2000).default(""),
  summary: z.string().trim().max(4000).default(""),
  status: z.enum(reviewStatuses).default("open"),
  responsible: z.string().trim().max(120).default(""),
});
export const reviewCreate = fields
  .extend({
    id: z.uuid(),
    page: z.number().int().min(1).max(10000),
    type: z.enum(reviewTypes),
  })
  .refine((v) => validGeometry(v.type, v.geometry), {
    message: "Invalid annotation geometry",
  });
export const reviewPatch = z.object({
  version: z.number().int().min(1),
  annotation_deleted: z.literal(true).optional(),
  color: z.enum(reviewColors).optional(),
  geometry: geometrySchema.optional(),
  content: z.string().max(2000).optional(),
  summary: z.string().trim().max(4000).optional(),
  status: z.enum(reviewStatuses).optional(),
  responsible: z.string().trim().max(120).optional(),
});
export function validGeometry(type: ReviewType, g: Geometry) {
  const p = g.points;
  if (type === "discussion") return p.length === 0;
  if (type === "marker" || type === "text") return p.length === 1;
  if (type === "freehand") return p.length >= 2;
  if (p.length !== 2) return false;
  if (type === "arrow")
    return Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) > 0.0001;
  return (
    Math.abs(p[0][0] - p[1][0]) > 0.0001 && Math.abs(p[0][1] - p[1][1]) > 0.0001
  );
}
export interface ReviewItem {
  id: string;
  document_id: string;
  revision_id: string;
  revision_label: string;
  number: number;
  page: number;
  type: ReviewType;
  color: (typeof reviewColors)[number];
  geometry: Geometry;
  content: string;
  summary: string;
  status: (typeof reviewStatuses)[number];
  responsible: string;
  created_by: string;
  author: string;
  version: number;
  annotation_deleted_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface ReviewMessage {
  id: string;
  item_id: string;
  body: string;
  author_id: string;
  author: string;
  version: number;
  created_at: string;
  updated_at: string;
}
export interface ReviewEvent {
  id: string;
  action: string;
  actor: string;
  payload: string;
  created_at: string;
}
export interface ReviewTarget {
  revision_id: string;
  page: number;
  id: string;
}
export const colorValues = {
  red: "#dc2626",
  orange: "#ea580c",
  yellow: "#ca8a04",
  green: "#16a34a",
  blue: "#2563eb",
};
