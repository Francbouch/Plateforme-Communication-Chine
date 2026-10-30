import { useState, useEffect, useRef } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import { applyConfirmedPoint } from "./reviewCache";
import type { Revision, Page } from "../../../../packages/shared/src/documents";
import type {
  ReviewItem,
  ReviewMessage,
  ReviewEvent,
} from "../../../../packages/shared/src/review";
export type ReviewCreateData = Pick<
  ReviewItem,
  "id" | "page" | "type" | "geometry" | "color"
> &
  Partial<Pick<ReviewItem, "summary" | "content" | "responsible" | "status">>;
export interface ReviewDetail {
  item: ReviewItem;
  messages: ReviewMessage[];
  history: ReviewEvent[];
  hasMoreMessages: boolean;
  hasMoreHistory: boolean;
}
export function useReview(revision: Revision, page: number, enabled: boolean) {
  const [saved, setSaved] = useState(false);
  const activeRevision = useRef(revision.id);
  activeRevision.current = revision.id;
  const client = useQueryClient(),
    [selected, setSelected] = useState<string | null>(null),
    [panel, setPanel] = useState(true),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    setSelected(null);
    setError("");
    setSaved(false);
  }, [revision.id]);
  const annotations = useInfiniteQuery({
    queryKey: ["review", "annotations", revision.id, page],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api<Page<ReviewItem>>(
        `revisions/${revision.id}/annotations?page_number=${page}&page=${pageParam}`,
      ),
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    enabled,
    staleTime: 30000,
  });
  const items = annotations.data?.pages.flatMap((p) => p.items) ?? [];
  async function mutation<T>(
    fn: () => Promise<T>,
    confirmedPoint?: (result: T) => ReviewItem,
  ) {
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const result = await fn();
      if (confirmedPoint)
        await applyConfirmedPoint(client, confirmedPoint(result));
      else if (selected)
        await client.invalidateQueries({
          queryKey: ["review", "point", selected],
        });
      setSaved(true);
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setSaving(false);
    }
  }
  const create = async (data: ReviewCreateData) => {
    const revisionId = revision.id;
    const item = await mutation(
      () => api<ReviewItem>(`revisions/${revisionId}/review-items`, data),
      (item) => item,
    );
    if (activeRevision.current === revisionId) {
      setSelected(item.id);
      setPanel(true);
    }
    return item;
  };
  const update = async (
    id: string,
    data: Partial<ReviewItem> & { annotation_deleted?: true; version: number },
  ) =>
    mutation(
      () => api<ReviewItem>(`review-items/${id}`, data, "PATCH"),
      (item) => item,
    );
  return {
    items,
    annotations,
    selected,
    setSelected,
    panel,
    setPanel,
    saving,
    saved,
    error,
    setError,
    create,
    update,
    mutation,
  };
}
export type ReviewSession = ReturnType<typeof useReview>;
