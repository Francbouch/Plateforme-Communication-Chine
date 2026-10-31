import type { TFunction } from "i18next";
import { ApiError } from "./client";
/** API diagnostics stay out of user-facing messages. */
export function userError(error: unknown, t: TFunction): string {
  const status = error instanceof ApiError ? error.status : 0;
  return t(
    status === 401
      ? "sessionExpired"
      : status === 403 || status === 404
        ? "permissionChanged"
        : status === 409
          ? "requestConflict"
          : status === 413
            ? "requestTooLarge"
            : status === 429
              ? "requestRateLimited"
              : status === 0
                ? "offlineError"
                : "requestFailed",
  );
}
