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
    if (!data || item.point_id === undefined) continue;
    if (item.annotation_deleted_at && data.pages.some((p) => p.hasMore)) {
      refresh.push(client.invalidateQueries({ queryKey: key }));
      continue;
    }
    let found = false;
    const pages = data.pages.map((p) => ({
      ...p,
      items: p.items.flatMap((i) => {
        if (i.id !== item.id) return [i];
        found = true;
        return item.annotation_deleted_at ? [] : [item];
      }),
    }));
    if (!found && !item.annotation_deleted_at && pages.length)
      pages[pages.length - 1].items.push(item);
    client.setQueryData(key, { ...data, pages });
  }

  if (item.point_id === undefined)
    for (const [key, data] of client.getQueriesData<Page<ReviewItem>>({
      queryKey: ["review", "points", item.document_id],
    })) {
      if (!data || data.page !== 0 || data.hasMore) {
        refresh.push(client.invalidateQueries({ queryKey: key }));
        continue;
      }
      const params = new URLSearchParams(String(key[3]));
      const matches =
        item.point_id === undefined &&
        !item.point_deleted_at &&
        (!params.get("publication") ||
          params.get("publication") === item.publication) &&
        (params.get("status") === "cancelled"
          ? !!item.cancelled_at
          : !params.get("status") || !item.cancelled_at) &&
        (!params.get("revision_id") ||
          params.get("revision_id") === item.revision_id) &&
        (!params.get("page_number") ||
          Number(params.get("page_number")) === item.page) &&
        (params.get("status")
          ? params.get("status") === "cancelled"
            ? !!item.cancelled_at
            : params.get("status") === item.status
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
  if (item.point_id === undefined)
    for (const [key, data] of client.getQueriesData<ReviewDetail>({
      queryKey: ["review", "point", item.id],
    }))
      if (data) client.setQueryData(key, { ...data, item });
  if (item.point_id !== undefined) {
    refresh.push(
      client.invalidateQueries({
        queryKey: ["review", "points", item.document_id],
      }),
    );
    refresh.push(client.invalidateQueries({ queryKey: ["review", "point"] }));
  }
  // One targeted read refreshes replies/history; the PDF and unrelated lists stay intact.
  refresh.push(
    client.invalidateQueries({ queryKey: ["review", "point", item.id] }),
  );
  await Promise.all(refresh);
}
