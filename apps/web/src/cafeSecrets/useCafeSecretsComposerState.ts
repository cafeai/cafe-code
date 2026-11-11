import type { EnvironmentId, ProviderInstanceId } from "@cafecode/contracts";
import { supportsCafeSecrets } from "@cafecode/shared/cafeSecrets";
import { useEffect, useState } from "react";

import {
  type CafeSecretSendIssue,
  loadCafeSecretsCapability,
  needsCafeSecretAdmission,
  readThreadSecretsApi,
  type ThreadSecretsApiHandle,
} from "./cafeSecretsClient";

export interface ReportedCafeSecretIssue {
  readonly issue: CafeSecretSendIssue;
  /** The exact prompt the send refused; any later edit retires the report. */
  readonly prompt: string;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: string;
  readonly api: ThreadSecretsApiHandle | undefined;
}

/**
 * Live composer presentation for Cafe Secrets. Capability is read lazily, only
 * once the prompt actually contains secret syntax, and is fail-closed.
 */
export function useCafeSecretsComposerState(input: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: string;
  readonly prompt: string;
  readonly reported: ReportedCafeSecretIssue | null;
}): { readonly present: boolean; readonly issue: CafeSecretSendIssue | null } {
  const present = needsCafeSecretAdmission(input.prompt);
  // The connection-owned API object identifies the transport that answered;
  // a replaced saved-server connection under the same EnvironmentId must not
  // keep showing the retired connection's answer.
  const api = readThreadSecretsApi(input.environmentId);
  const [capability, setCapability] = useState<{
    readonly key: string;
    readonly api: ThreadSecretsApiHandle | undefined;
    readonly supported: boolean;
  } | null>(null);
  const key = `${input.environmentId}\u0000${input.instanceId}\u0000${input.driver}`;
  useEffect(() => {
    if (!present) return;
    let cancelled = false;
    void loadCafeSecretsCapability({
      environmentId: input.environmentId,
      instanceId: input.instanceId,
      driver: input.driver,
    }).then((supported) => {
      // Scope the answer to the exact environment/instance/connection.
      if (!cancelled) setCapability({ key, api, supported });
    });
    return () => {
      cancelled = true;
    };
  }, [present, key, api, input.environmentId, input.instanceId, input.driver]);
  if (!present) return { present, issue: null };
  if (
    input.reported &&
    input.reported.prompt === input.prompt &&
    input.reported.environmentId === input.environmentId &&
    input.reported.instanceId === input.instanceId &&
    input.reported.driver === input.driver &&
    input.reported.api === api
  ) {
    return { present, issue: input.reported.issue };
  }
  // A known-unsupported driver needs no RPC; otherwise only a resolved false
  // for this exact key and connection shows the error (pending is not yet an
  // error, and the send path rechecks independently).
  const unsupported =
    !supportsCafeSecrets(input.driver) ||
    (capability !== null &&
      capability.key === key &&
      capability.api === api &&
      !capability.supported);
  return { present, issue: unsupported ? "unsupported" : null };
}
