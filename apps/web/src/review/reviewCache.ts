import type { QueryClient, InfiniteData } from "@tanstack/react-query";
import type { Page } from "../../../../packages/shared/src/documents";
import type { ReviewItem } from "../../../../packages/shared/src/review";
import type { ReviewDetail } from "./useReview";
/** Update only from a server-confirmed record. Never mark an unsaved draft as saved. */
export async function applyConfirmedPoint(
  client: QueryClient,
  item: ReviewItem,
) {
  const refresh: Promise<unknown>[] = [];
  for (const [key, data] of client.getQueriesData<
    InfiniteData<Page<ReviewItem>>
  >({ queryKey: ["review", "annotations", item.revision_id, item.page] })) {
    if (!data || data.pages.length !== 1 || data.pages[0].hasMore) {
      refresh.push(client.invalidateQueries({ queryKey: key }));
      continue;
    }
    const rows = data.pages[0].items.filter((i) => i.id !== item.id);
    if (!item.annotation_deleted_at && item.type !== "discussion")
      rows.push(item);
    rows.sort((a, b) => a.number - b.number);
    client.setQueryData(key, {
      ...data,
      pages: [{ ...data.pages[0], items: rows }],
    });
  }
  for (const [key, data] of client.getQueriesData<Page<ReviewItem>>({
    queryKey: ["review", "points", item.document_id],
  })) {
    if (!data || data.page !== 0 || data.hasMore) {
      refresh.push(client.invalidateQueries({ queryKey: key }));
      continue;
    }
    const params = new URLSearchParams(String(key[3]));
    const matches =
      (!params.get("revision_id") ||
        params.get("revision_id") === item.revision_id) &&
      (!params.get("page_number") ||
        Number(params.get("page_number")) === item.page) &&
      (params.get("status")
        ? params.get("status") === item.status
        : params.get("hide_resolved") !== "1" || item.status !== "resolved");
    const rows = data.items.filter((i) => i.id !== item.id);
    if (matches) rows.push(item);
    rows.sort((a, b) => a.number - b.number);
    client.setQueryData(key, {
      ...data,
      items: rows.slice(0, 50),
      hasMore: rows.length > 50,
    });
  }
  for (const [key, data] of client.getQueriesData<ReviewDetail>({
    queryKey: ["review", "point", item.id],
  }))
    if (data) client.setQueryData(key, { ...data, item });
  // One targeted read refreshes replies/history; the PDF and unrelated lists stay intact.
  refresh.push(
    client.invalidateQueries({ queryKey: ["review", "point", item.id] }),
  );
  await Promise.all(refresh);
}
