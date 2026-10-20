import type { ProviderInstanceConfig } from "@cafecode/contracts";

type ProviderLoginAccess = {
  readonly role: string;
  readonly secureSecretTransport: boolean;
  readonly instance: ProviderInstanceConfig | undefined;
};

function isEnabledProvider(instance: ProviderInstanceConfig | undefined): boolean {
  // Legacy default accounts keep enabled inside config; explicit instance
  // policy overrides it exactly as it does in registry admission.
  const config = instance?.config;
  const configEnabled =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as { readonly enabled?: unknown }).enabled
      : undefined;
  const enabled = instance?.enabled ?? configEnabled;
  return instance !== undefined && enabled !== false;
}

/** Browser and terminal launchers retain their owner-only authority. */
export function canLoginProvider(input: ProviderLoginAccess): boolean {
  return input.role === "owner" && input.secureSecretTransport && isEnabledProvider(input.instance);
}

/** Paired clients may explicitly authenticate the selected server-side Codex
 * account through their own private device-code stream. This grants neither
 * settings authority nor access to another connection's pending login. The
 * caller must revalidate its persisted session and exact account throughout. */
export function canLoginProviderDeviceCode(input: ProviderLoginAccess): boolean {
  return (
    (input.role === "owner" || input.role === "client") &&
    input.secureSecretTransport &&
    input.instance?.driver === "codex" &&
    isEnabledProvider(input.instance)
  );
}
