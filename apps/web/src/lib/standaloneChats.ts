import type { EnvironmentId } from "@cafecode/contracts";
import { readPrimaryEnvironmentDescriptor } from "../environments/primary";
import { getSavedEnvironmentRuntimeState } from "../environments/runtime/catalog";

/** Capability authority follows the exact conversation owner, never the active tab. */
export function supportsStandaloneChats(environmentId: EnvironmentId): boolean {
  const primary = readPrimaryEnvironmentDescriptor();
  const descriptor =
    primary?.environmentId === environmentId
      ? primary
      : getSavedEnvironmentRuntimeState(environmentId)?.descriptor;
  return (
    descriptor?.environmentId === environmentId && descriptor.capabilities.standaloneChats === true
  );
}
