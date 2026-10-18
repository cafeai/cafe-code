import type {
  AuthTwoFactorEnabled,
  AuthTwoFactorEnrollment,
  AuthTwoFactorStatus,
  EnvironmentId,
} from "@cafecode/contracts";
import { readPrimaryEnvironmentDescriptor, resolvePrimaryEnvironmentHttpUrl } from "./primary";
import { fetchRemoteJson, isRemoteEnvironmentAuthHttpError } from "./remote/api";
import { getSavedEnvironmentRecord, readSavedEnvironmentBearerToken } from "./runtime/catalog";

export class TwoFactorApiError extends Error {
  constructor(readonly kind: "code" | "limited" | "locked" | "request") {
    super(kind);
  }
}

/** Capture the selected server before any request. Secrets are transient request
 * bodies only, never stored with the saved bearer or replayed after TLS approval. */
export function createTwoFactorApi(environmentId: EnvironmentId | null) {
  const remote =
    environmentId && environmentId !== readPrimaryEnvironmentDescriptor()?.environmentId;
  async function request<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
    try {
      if (remote) {
        const record = getSavedEnvironmentRecord(environmentId);
        const token = await readSavedEnvironmentBearerToken(environmentId);
        if (!record || !token) throw new TwoFactorApiError("request");
        return await fetchRemoteJson<T>({
          httpBaseUrl: record.httpBaseUrl,
          pathname: path,
          method,
          bearerToken: token,
          ...(body === undefined ? {} : { body }),
        });
      }
      const response = await fetch(resolvePrimaryEnvironmentHttpUrl(path), {
        method,
        credentials: "include",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      if (!response.ok && response.headers.get("x-cafe-auth-reason") === "two-factor-locked")
        throw new TwoFactorApiError("locked");
      if (!response.ok)
        throw new TwoFactorApiError(
          response.status === 429 ? "limited" : response.status === 401 ? "code" : "request",
        );
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof TwoFactorApiError) throw error;
      if (isRemoteEnvironmentAuthHttpError(error))
        throw new TwoFactorApiError(
          error.reason === "two-factor-locked"
            ? "locked"
            : error.status === 429
              ? "limited"
              : error.status === 401
                ? "code"
                : "request",
        );
      // Never render remote response text, URLs or secret-bearing exceptions.
      throw new TwoFactorApiError("request");
    }
  }
  return {
    status: () => request<AuthTwoFactorStatus>("/api/auth/two-factor", "GET"),
    begin: () => request<AuthTwoFactorEnrollment>("/api/auth/two-factor/setup", "POST"),
    enable: (code: string) =>
      request<AuthTwoFactorEnabled>("/api/auth/two-factor/enable", "POST", { code }),
    disable: (code: string) =>
      request<AuthTwoFactorStatus>("/api/auth/two-factor/disable", "POST", { code }),
  };
}
export type TwoFactorApi = ReturnType<typeof createTwoFactorApi>;
