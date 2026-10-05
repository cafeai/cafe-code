import type {
  AuthAdminPasswordStatus,
  AuthPairingCredentialResult,
  AuthSessionId,
  EnvironmentId,
} from "@cafecode/contracts";
import * as primary from "./primary";
import { fetchRemoteJson, fetchRemoteSessionState } from "./remote/api";
import { getSavedEnvironmentRecord, readSavedEnvironmentBearerToken } from "./runtime/catalog";

/** Bind auth administration to the displayed server before opening a dialog.
 * Remote response text is never trusted as an error message, and only the saved
 * bearer is used; the primary browser cookie cannot authorize a remote action. */
export function createWorkspaceAuthApi(environmentId: EnvironmentId | null) {
  if (!environmentId || environmentId === primary.readPrimaryEnvironmentDescriptor()?.environmentId)
    return primary;
  async function request<T>(
    pathname: string,
    method: "GET" | "POST" = "GET",
    body?: unknown,
  ): Promise<T> {
    const record = getSavedEnvironmentRecord(environmentId!);
    const bearerToken = await readSavedEnvironmentBearerToken(environmentId!);
    if (!record || !bearerToken)
      throw new Error("Sign in to the selected server before managing access.");
    return fetchRemoteJson<T>({
      httpBaseUrl: record.httpBaseUrl,
      pathname,
      bearerToken,
      method,
      ...(body !== undefined ? { body } : {}),
    });
  }
  return {
    fetchSessionState: async () => {
      const record = getSavedEnvironmentRecord(environmentId);
      const bearerToken = await readSavedEnvironmentBearerToken(environmentId);
      if (!record || !bearerToken)
        throw new Error("Sign in to the selected server before managing access.");
      return fetchRemoteSessionState({ httpBaseUrl: record.httpBaseUrl, bearerToken });
    },
    fetchServerAdminPasswordStatus: () =>
      request<AuthAdminPasswordStatus>("/api/auth/admin-password"),
    setServerAdminPassword: (password: string) =>
      request<AuthAdminPasswordStatus>("/api/auth/admin-password", "POST", {
        password: password.trim(),
      }),
    clearServerAdminPassword: () =>
      request<AuthAdminPasswordStatus>("/api/auth/admin-password/clear", "POST"),
    createServerPairingCredential: (label?: string) =>
      request<AuthPairingCredentialResult>(
        "/api/auth/pairing-token",
        "POST",
        label?.trim() ? { label: label.trim() } : {},
      ),
    revokeServerPairingLink: async (id: string) => {
      await request("/api/auth/pairing-links/revoke", "POST", { id });
    },
    revokeServerClientSession: async (sessionId: AuthSessionId) => {
      await request("/api/auth/clients/revoke", "POST", { sessionId });
    },
    revokeOtherServerClientSessions: async () =>
      (await request<{ revokedCount: number }>("/api/auth/clients/revoke-others", "POST"))
        .revokedCount,
  };
}
