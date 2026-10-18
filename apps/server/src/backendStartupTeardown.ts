import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Runtime from "effect/Runtime";
import { BACKEND_PROFILE_STARTUP_REFUSED_EXIT_CODE } from "@cafecode/shared/backendStartupFailure";

import { BackendProfileGuardError } from "./backendProfileGuard.ts";
import { DataProfileSelectionError } from "./cli/config.ts";

/** Classify only the exact completed typed startup refusal. The enclosing
 * scoped program has already drained every finalizer before Runtime calls
 * this callback. Defects, interruption and combined failures remain ordinary
 * runtime outcomes; text, tags and arbitrary error properties grant no match. */
export const backendStartupTeardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isFailure(exit) && exit.cause.reasons.length === 1) {
    const reason = exit.cause.reasons[0];
    if (
      reason !== undefined &&
      Cause.isFailReason(reason) &&
      (reason.error instanceof BackendProfileGuardError ||
        reason.error instanceof DataProfileSelectionError)
    ) {
      onExit(BACKEND_PROFILE_STARTUP_REFUSED_EXIT_CODE);
      return;
    }
  }
  // Preserve Effect's existing policy except for the one reserved protocol
  // code. An unrelated error can carry Runtime.errorExitCode metadata; it must
  // not impersonate a completed typed profile refusal through that shortcut.
  Runtime.defaultTeardown(exit, (code) =>
    onExit(code === BACKEND_PROFILE_STARTUP_REFUSED_EXIT_CODE ? 1 : code),
  );
};
