import { isDemo, demoRequest } from "./demo";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
/** Same-origin Access gateway. The browser never holds an application secret. */
export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  if (isDemo) return demoRequest<T>(path, body, method);
  const response = await fetch(`/api/v1/${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (
    response.status === 401 ||
    (response.ok && response.headers.get("Content-Type")?.includes("text/html"))
  ) {
    if (typeof window !== "undefined")
      window.dispatchEvent(new Event("forgebridge:session-expired"));
  }
  if (!response.headers.get("Content-Type")?.includes("application/json"))
    throw new ApiError(
      response.status,
      "Private gateway unavailable or Access session expired",
    );
  const result = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      (result as { error?: string }).error ??
        `Request rejected (${response.status})`,
    );
  return result as T;
}
