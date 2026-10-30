import { z } from "zod";
import { requestPriorities } from "./messages";
export const approvalStatuses = [
  "draft",
  "pending",
  "approved",
  "rejected",
  "changes_requested",
  "cancelled",
] as const;
export const approvalPurposes = ["internal_review", "manufacturing"] as const;
export type ApprovalStatus = (typeof approvalStatuses)[number];
export const approvalFields = z.object({
  revision_id: z.uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(8000).default(""),
  responsible: z.string().trim().max(120).default(""),
  due_date: z.iso.date().nullable().default(null),
  priority: z.enum(requestPriorities).default("normal"),
  purpose: z.enum(approvalPurposes).default("internal_review"),
  point_ids: z.array(z.uuid()).max(20).default([]),
  message_id: z.uuid().nullable().default(null),
  technical_request_id: z.uuid().nullable().default(null),
});
export const approvalCreate = approvalFields.extend({ id: z.uuid() });
export const approvalAction = z
  .object({
    version: z.number().int().positive(),
    action: z.enum([
      "submit",
      "approve",
      "reject",
      "request_changes",
      "cancel",
    ]),
    comment: z.string().trim().max(8000).default(""),
    point_ids: z.array(z.uuid()).max(20).default([]),
  })
  .refine(
    (v) =>
      !["reject", "request_changes", "cancel"].includes(v.action) ||
      !!v.comment,
    { message: "A justification is required" },
  );
export interface Approval {
  id: string;
  number: number;
  project_id: string;
  document_id: string;
  revision_id: string;
  revision_label: string;
  document_name: string;
  document_number: string;
  title: string;
  description: string;
  responsible: string;
  approver_id: string | null;
  requester_id: string;
  requester: string;
  purpose: (typeof approvalPurposes)[number];
  priority: (typeof requestPriorities)[number];
  status: ApprovalStatus;
  due_date: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  decider: string | null;
  decision_comment: string;
  message_id: string | null;
  conversation_id: string | null;
  technical_request_id: string | null;
  previous_id: string | null;
  deleted_at: string | null;
  is_latest: number;
}
export interface ApprovalPoint {
  id: string;
  number: number;
  title: string;
  page: number;
  revision_id: string;
  document_id: string;
  point_deleted_at: string | null;
  status: string;
}
export interface ApprovalEvent {
  id: string;
  action: string;
  actor: string;
  created_at: string;
  payload: string;
}
export interface ApprovalDetail {
  approval: Approval;
  points: ApprovalPoint[];
  events: ApprovalEvent[];
  hasMoreEvents: boolean;
  successor_id: string | null;
}
export interface RevisionApproval {
  revision_id: string;
  is_latest: boolean;
  review_status: ApprovalStatus | "not_submitted";
  manufacturing_status: ApprovalStatus | "not_submitted";
  review_request_id: string | null;
  manufacturing_request_id: string | null;
  manufacturing_approved: boolean;
  current_manufacturing_ready: boolean;
  obsolete_for_current: boolean;
}
