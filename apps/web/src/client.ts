import { createClient } from "@supabase/supabase-js";
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
export const auth =
  url && key
    ? createClient(url, key, {
        auth: {
          flowType: "pkce",
          persistSession: true,
          autoRefreshToken: true,
        },
      })
    : null;
const apiBaseUrl =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(
    /\/+$/,
    "",
  ) ?? "";

export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const session = await auth?.auth.getSession();
  const response = await fetch(`${apiBaseUrl}/api/v1/${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      Authorization: `Bearer ${session?.data.session?.access_token ?? ""}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`Request rejected (${response.status})`);
  return response.json() as Promise<T>;
}
