import type { OrchestrationThreadActivity } from "@cafecode/contracts";
import { isCodexHistoryRecoveryRequiredError } from "@cafecode/shared/codexHistorySafety";
import { isClaudeResponseLimitError } from "@cafecode/shared/claudeResponseLimits";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Thread } from "./types";
import { readProviderDiagnosticSummary } from "./providerDiagnostic";

/** Presentation only: never clear errors or infer recovery authority from a row. */
export function isProviderErrorRepresentedInWorkLog(input: {
  readonly thread: Pick<Thread, "id" | "error" | "session" | "latestTurn" | "modelSelection">;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}): boolean {
  const { thread } = input;
  const error = thread.error;
  if (
    !error ||
    error.length > 65_536 ||
    !thread.session ||
    !thread.session.subagentRuntimeId ||
    error !== thread.session.lastError ||
    thread.modelSelection.instanceId !== thread.session.providerInstanceId ||
    !thread.latestTurn ||
    thread.latestTurn.state !== "error" ||
    thread.latestTurn.completedAt === null ||
    thread.session.updatedAt !== thread.latestTurn.completedAt ||
    isCodexHistoryRecoveryRequiredError(error) ||
    isClaudeResponseLimitError(error) ||
    // Preserve actionable authentication/approval feedback. This conservative
    // UI exclusion changes no provider classification or permission policy.
    /auth|credential|sign[ -]?in|login|approval|permission/iu.test(error)
  )
    return false;
  const hash = Array.from(sha256(new TextEncoder().encode(error)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const ownerHash = Array.from(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([
          thread.id,
          thread.latestTurn.turnId,
          thread.session.providerInstanceId,
          thread.session.subagentRuntimeId,
        ]),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  for (const activity of input.activities.toReversed()) {
    if (
      activity.kind !== "runtime.error" ||
      activity.turnId !== thread.latestTurn!.turnId ||
      !activity.payload ||
      typeof activity.payload !== "object" ||
      Array.isArray(activity.payload)
    )
      continue;
    let descriptors: PropertyDescriptorMap;
    try {
      descriptors = Object.getOwnPropertyDescriptors(activity.payload);
    } catch {
      return false;
    }
    const marker = descriptors.providerDiagnostic;
    const errorHash = descriptors.providerErrorHash;
    const owner = descriptors.providerErrorOwnerHash;
    if (!marker || !("value" in marker)) return false;
    const summary = readProviderDiagnosticSummary(marker.value);
    if (summary?.subject.kind === "subagent") continue;
    // Published only after the exact private occurrence write succeeds. The
    // row, not its private JSON, remains discoverable after history reload.
    return (
      summary?.status === "error" &&
      summary.subject.kind === "root" &&
      errorHash !== undefined &&
      "value" in errorHash &&
      errorHash.value === hash &&
      owner !== undefined &&
      "value" in owner &&
      owner.value === ownerHash
    );
  }
  return false;
}
