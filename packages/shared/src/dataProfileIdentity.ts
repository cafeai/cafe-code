// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import type { DataProfile } from "./dataProfile.ts";

/**
 * An authenticated runtime echoes this content-free correlation of its actual
 * admitted profile/root. It is not a capability and must never replace the
 * private bootstrap token, generation, or native process ownership proof.
 */
export function dataProfileIdentity(profile: DataProfile, effectiveRoot: string): string {
  return createHash("sha256")
    .update("cafecode.data-profile.v1\0")
    .update(JSON.stringify([profile, effectiveRoot]))
    .digest("hex");
}
