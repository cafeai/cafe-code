export interface SshAuthOptions {
  readonly batchMode?: "yes" | "no";
}

export function formatSshAgentAuthRequiredMessage(destination: string): string {
  return [
    `SSH authentication failed for ${destination}.`,
    "Cafe Code requires SSH agent/key authentication.",
    "Load an unlocked key into ssh-agent and verify OpenSSH can connect without a password prompt.",
  ].join(" ");
}

export function isSshAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    /permission denied \((?:publickey|password|keyboard-interactive|hostbased|gssapi-with-mic)[^)]*\)/u.test(
      normalized,
    ) ||
    /authentication failed/u.test(normalized) ||
    /too many authentication failures/u.test(normalized)
  );
}
