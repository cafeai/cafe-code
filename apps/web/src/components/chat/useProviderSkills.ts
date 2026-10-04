import { useEffect, useMemo, useState } from "react";
import type {
  EnvironmentId,
  ProviderSkillsInput,
  ProviderSkillsResult,
  ServerProviderSkill,
  ServerProvider,
  UnifiedSettings,
} from "@cafecode/contracts";
import { requireEnvironmentConnection } from "../../environments/runtime";

const EMPTY: readonly ServerProviderSkill[] = [];
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
    explicit ?? (input.instanceId === "codex" ? input.settings.providers.codex : undefined);
  return JSON.stringify([
    input.cwd,
    configurationIdentity(configuration),
    input.snapshot?.enabled,
    input.snapshot?.auth,
  ]);
}

/** Gesture-owned read, not provider snapshot state. Exact scope is checked in
 * render as well as cleanup, so an account/project change never exposes a stale
 * frame or lets a late response overwrite the new picker. Closing/reopening is
 * an explicit refresh; keystrokes do not relaunch discovery. */
export function useProviderSkills(
  environmentId: EnvironmentId,
  input: ProviderSkillsInput | null,
  open: boolean,
  scopeRevision = "",
) {
  const key = JSON.stringify([environmentId, input, scopeRevision]);
  // A new opening owns its request generation immediately, before effects run.
  // Never flash last opening's cached permitted entries while refreshing.
  const request = useMemo(() => ({ key, open }), [key, open]);
  const [state, setState] = useState<{
    key: string;
    request: typeof request;
    result: ProviderSkillsResult;
  } | null>(null);
  useEffect(() => {
    if (!open || input === null) return;
    let current = true;
    const run = async () => {
      try {
        const result =
          await requireEnvironmentConnection(environmentId).client.server.listProviderSkills(input);
        if (current) setState({ key, request, result });
      } catch {
        if (current) setState({ key, request, result: { status: "unavailable", skills: [] } });
      }
    };
    void run();
    return () => {
      current = false;
    };
  }, [environmentId, input, key, open, request]);
  // Closed composers retain inert same-context chip labels; a new opening or
  // context switch must await its own discovery result.
  const result = state?.key === key && (!open || state.request === request) ? state.result : null;
  return {
    skills: result?.skills ?? EMPTY,
    loading: open && input !== null && result === null,
    status: input === null ? "unavailable" : result?.status,
  };
}
