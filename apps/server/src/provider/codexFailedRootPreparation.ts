// The native crypto boundary binds private recovery capabilities; none of its
// inputs or random secrets may be copied into public events or diagnostics.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ProviderSendTurnInput } from "@cafecode/contracts";
import * as Schema from "effect/Schema";

const encodeRequest = Schema.encodeSync(Schema.fromJsonString(ProviderSendTurnInput));
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(ProviderSendTurnInput));
const secretPattern = /^[a-f0-9]{64}$/u;

/** Retain an owned deep wire copy; caller mutation cannot change a live lease. */
export function copyCodexFailedRootPreparationRequest(
  request: ProviderSendTurnInput,
): ProviderSendTurnInput {
  return decodeRequest(encodeRequest(request));
}

/** Bind the complete schema-canonical request, including the original history. */
export function codexFailedRootPreparationCommitment(
  attemptId: string,
  request: ProviderSendTurnInput,
): string {
  const { preparedFailedRootRecovery: _permit, ...original } = request;
  return createHash("sha256")
    .update("cafe-code/codex-failed-root-preparation/v1\0", "utf8")
    .update(JSON.stringify([attemptId, encodeRequest(original)]), "utf8")
    .digest("hex");
}

/** A capability is unpredictable even to a caller that knows every request field. */
export function newCodexFailedRootPreparationSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Validate shape before constant-time comparison; malformed values grant nothing. */
export function sameCodexFailedRootPreparationSecret(
  actual: string | undefined,
  expected: string | undefined,
): boolean {
  return (
    typeof actual === "string" &&
    typeof expected === "string" &&
    actual.length === 64 &&
    expected.length === 64 &&
    secretPattern.test(actual) &&
    secretPattern.test(expected) &&
    timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))
  );
}

/**
 * Forgetting a private tombstone must neither free an uncertain owner nor
 * revoke a still-live capability. The successful old-scope join is separate
 * from native retirement: its stopped flag alone precedes actual cleanup.
 * Pruning never closes the ordinary replacement session or grants a retry.
 */
export function mayPruneCodexFailedRootPreparation(input: {
  readonly oldRetired: boolean;
  readonly oldCleanupJoined: boolean;
  readonly pending: boolean;
  readonly state: string;
}): boolean {
  return (
    input.oldRetired &&
    input.oldCleanupJoined &&
    !input.pending &&
    (input.state === "consumed" || input.state === "retired")
  );
}
