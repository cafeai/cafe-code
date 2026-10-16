import type { ProviderSkillsInput, ServerProvider, UnifiedSettings } from "@cafecode/contracts";
const configurationIdentities = new WeakMap<object, number>();
let nextConfigurationIdentity = 0;

function configurationIdentity(configuration: object | undefined): number | null {
  if (configuration === undefined) return null;
  const existing = configurationIdentities.get(configuration);
  if (existing !== undefined) return existing;
  const identity = ++nextConfigurationIdentity;
  configurationIdentities.set(configuration, identity);
  return identity;
}

/** UI-only invalidation for authorities that can change under the same public
 * ids. Do not send this revision to the server, render it or persist it: cwd and
 * configuration remain independently resolved by the authenticated RPC. The
 * selected immutable settings object receives an opaque weak identity, so no
 * credential/environment/configuration values are copied into a string. Ignore
 * ordinary checkedAt/quota/model-list refreshes so they do not create probes. */
export function providerSkillsScopeRevision(input: {
  readonly cwd: string | null | undefined;
  readonly instanceId: ProviderSkillsInput["instanceId"];
  readonly settings: Pick<UnifiedSettings, "providerInstances" | "providers">;
  readonly snapshot: ServerProvider | null;
}): string {
  const explicit = input.settings.providerInstances[input.instanceId];
  const configuration =
    explicit ??
    (input.instanceId === "codex"
      ? input.settings.providers.codex
      : input.instanceId === "claudeAgent"
        ? input.settings.providers.claudeAgent
        : undefined);
  return JSON.stringify([
    input.cwd,
    configurationIdentity(configuration),
    input.snapshot?.enabled,
    input.snapshot?.auth,
  ]);
}
