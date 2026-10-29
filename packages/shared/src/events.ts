/** Future integrations: no external service is activated by these contracts. */
export type DocumentEventType =
  | "document.created"
  | "document.revision.drafted"
  | "document.revision.published"
  | "document.annotation.created"
  | "document.approval.requested"
  | "document.acknowledged";
export interface BusinessEvent {
  id: string;
  organizationId: string;
  projectId: string;
  resourceId: string;
  actorId: string;
  type: DocumentEventType;
  occurredAt: string;
  idempotencyKey: string;
}
export interface TranslationProvider {
  translate(input: {
    text: string;
    sourceLanguage: string;
    targetLanguage: string;
    glossaryId?: string;
  }): Promise<{ text: string; provider: string }>;
}
export interface NotificationDispatcher {
  /** Persist a unique (consumer,event.id) receipt and use provider idempotency. */
  dispatch(
    event: BusinessEvent,
    recipientIds: readonly string[],
    idempotencyKey: string,
  ): Promise<void>;
}
export interface ApprovalRequest {
  id: string;
  organizationId: string;
  projectId: string;
  revisionId: string;
  requestedBy: string;
  reviewerId: string;
  status: "pending" | "approved" | "rejected" | "revoked";
}
export interface DocumentAcknowledgement {
  id: string;
  revisionId: string;
  userId: string;
  acknowledgedAt: string;
}
