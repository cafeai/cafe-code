import type { SessionCredentialServiceShape } from "./Services/SessionCredentialService.ts";

export type ProviderMcpCredentialIssuer = Pick<SessionCredentialServiceShape, "issue" | "revoke">;

let activeIssuer: ProviderMcpCredentialIssuer | undefined;

/**
 * Bridges the auth control plane into provider drivers without making the
 * provider registry depend on the persistence-backed auth layer (which is
 * initialized later in the server graph). The returned cleanup is identity
 * checked so closing an older layer cannot unregister a newer runtime.
 */
export function installProviderMcpCredentialIssuer(
  issuer: ProviderMcpCredentialIssuer,
): () => void {
  activeIssuer = issuer;
  return () => {
    if (activeIssuer === issuer) activeIssuer = undefined;
  };
}

export function readProviderMcpCredentialIssuer(): ProviderMcpCredentialIssuer | undefined {
  return activeIssuer;
}
