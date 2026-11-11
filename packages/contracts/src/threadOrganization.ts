import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Thread organization and origin metadata.
 *
 * Groups are sidebar containment owned by exactly one parent thread. They are
 * created only through Cafe's management tool (there is no renderer entry
 * point), but that routing is product scope, not proof that a caller is an AI:
 * manual owner clients may also call the tool. Nothing in this module grants
 * permission, native provider ownership, retry authority or isolation.
 *
 * Origin classification is an editable label. Provenance is a separate
 * immutable server-recorded creation fact; correcting the label never rewrites
 * it, and placing a thread in a group never changes either.
 */

/** Nested group depth (thread → group → member → group …). A traversal
 * bound for delete/restore/render, never a limit on how many threads exist. */
export const MAX_THREAD_GROUP_DEPTH = 16;
/** Live groups per owner. Bounds the owner's shell frame (group summaries
 * travel with the owner shell); group membership itself is unbounded. */
export const MAX_LIVE_THREAD_GROUPS_PER_OWNER = 128;
export const THREAD_GROUP_TITLE_MAX_CHARS = 200;
export const THREAD_DESCRIPTION_MAX_CHARS = 2_000;

export const ThreadGroupId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9:_-]+$/),
).pipe(Schema.brand("ThreadGroupId"));
export type ThreadGroupId = typeof ThreadGroupId.Type;

export const ThreadGroupTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(THREAD_GROUP_TITLE_MAX_CHARS),
  Schema.isPattern(/^[^\p{Cc}\p{Bidi_Control}]+$/u),
);
export type ThreadGroupTitle = typeof ThreadGroupTitle.Type;

/**
 * Untrusted agent/user text. Multi-line text is allowed, but other control and
 * bidirectional-override characters are refused rather than silently changed.
 * Keep it out of logs, traces and compact debug output.
 */
export const ThreadDescription = TrimmedString.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(THREAD_DESCRIPTION_MAX_CHARS),
  Schema.isPattern(/^(?:[^\p{Cc}\p{Bidi_Control}]|[\n\t])*$/u),
);
export type ThreadDescription = typeof ThreadDescription.Type;

export const ThreadOriginClassification = Schema.Literals(["human", "agent", "unknown"]);
export type ThreadOriginClassification = typeof ThreadOriginClassification.Type;

/** `recorded`: server default derived from provenance. `user`: a person saved it. */
export const ThreadOriginSource = Schema.Literals(["recorded", "user"]);
export type ThreadOriginSource = typeof ThreadOriginSource.Type;

export const ThreadOrigin = Schema.Struct({
  classification: ThreadOriginClassification,
  source: ThreadOriginSource,
  updatedAt: IsoDateTime,
});
export type ThreadOrigin = typeof ThreadOrigin.Type;

/**
 * How a thread was created. `mcp-launch` means the management call carried a
 * signed launch claim for a **Cafe chat**; it never identifies a native
 * provider subagent. `mcp-owner-client` is a manual/external owner bearer and
 * is deliberately not called human or agent.
 */
export const ThreadCreationPath = Schema.Literals([
  "cafe-ui",
  "mcp-launch",
  "mcp-owner-client",
  "fork",
  "duplicate",
  "server",
]);
export type ThreadCreationPath = typeof ThreadCreationPath.Type;

export const ThreadProvenance = Schema.Struct({
  creationPath: ThreadCreationPath,
  /** Cafe chat recorded with the creation path, when trustworthy. */
  originThreadId: Schema.optional(ThreadId),
  /** Launch-claim attribution context only; never adoption proof. */
  providerInstanceId: Schema.optional(ProviderInstanceId),
  recordedAt: IsoDateTime,
});
export type ThreadProvenance = typeof ThreadProvenance.Type;

export const ThreadGroupAttribution = Schema.Literals(["launch-claim", "explicit-argument"]);
export type ThreadGroupAttribution = typeof ThreadGroupAttribution.Type;

export const ThreadGroupProvenance = Schema.Struct({
  creationPath: Schema.Literals(["mcp-launch", "mcp-owner-client", "server"]),
  /** Whether the owner came from the signed launch claim or an explicit argument. */
  attribution: ThreadGroupAttribution,
  /** Signed launch chat recorded separately when present. */
  launchThreadId: Schema.optional(ThreadId),
  recordedAt: IsoDateTime,
});
export type ThreadGroupProvenance = typeof ThreadGroupProvenance.Type;

/**
 * Engine/read-model group record. `deletionId` names the exact delete
 * operation (its command ID); restore matches that incarnation within the
 * group's own descendant subtree only.
 */
export const OrchestrationThreadGroup = Schema.Struct({
  id: ThreadGroupId,
  ownerThreadId: ThreadId,
  title: ThreadGroupTitle,
  description: Schema.NullOr(ThreadDescription),
  provenance: ThreadGroupProvenance,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
  deletionId: Schema.NullOr(CommandId),
});
export type OrchestrationThreadGroup = typeof OrchestrationThreadGroup.Type;

/** Compact live group summary carried on its owner's shell. */
export const OrchestrationThreadGroupSummary = Schema.Struct({
  id: ThreadGroupId,
  title: ThreadGroupTitle,
  createdAt: IsoDateTime,
});
export type OrchestrationThreadGroupSummary = typeof OrchestrationThreadGroupSummary.Type;

/** Recorded default when no person has corrected the label. */
export function defaultThreadOriginClassification(
  provenance: ThreadProvenance | null | undefined,
): ThreadOriginClassification {
  switch (provenance?.creationPath) {
    case "cafe-ui":
    case "fork":
    case "duplicate":
      return "human";
    case "mcp-launch":
      return "agent";
    default:
      return "unknown";
  }
}
