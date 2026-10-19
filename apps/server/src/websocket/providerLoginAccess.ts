import type { ProviderInstanceConfig } from "@cafecode/contracts";

/** Login changes credentials on the server machine, including for legacy
 * terminal launchers. A visible button or a remote paired viewer grants nothing. */
export function canLoginProvider(input: {
  readonly role: string;
  readonly secureSecretTransport: boolean;
  readonly instance: ProviderInstanceConfig | undefined;
}): boolean {
  // Legacy default accounts keep enabled inside config; explicit instance
  // policy overrides it exactly as it does in registry admission.
  const config = input.instance?.config;
  const configEnabled =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as { readonly enabled?: unknown }).enabled
      : undefined;
  const enabled = input.instance?.enabled ?? configEnabled;
  return (
    input.role === "owner" &&
    input.secureSecretTransport &&
    input.instance !== undefined &&
    enabled !== false
  );
}
