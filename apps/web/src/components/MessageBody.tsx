/** Shared plain-text rendering for project messages and technical-point discussions. */
export function MessageBody({ body }: { body: string }) {
  return <p className="message-body">{body}</p>;
}
