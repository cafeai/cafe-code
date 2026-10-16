import type {
  EnvironmentId,
  ProviderSkillsInput,
  ProviderSkillsResult,
  ServerProviderSkill,
} from "@cafecode/contracts";
import { useEffect, useMemo, useState } from "react";
import { requireEnvironmentConnection } from "../../environments/runtime";

const EMPTY: readonly ServerProviderSkill[] = [];
export { providerSkillsScopeRevision } from "./providerSkillsScope";

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

// Finite source-owned labels/helpers only; no received or user data.
