/**
 * WorkspaceObservatory - Effect service contract for read-only workspace views.
 *
 * Exposes bounded directory listings and bounded UTF-8 text previews for the
 * workspace root of a project that the server's own projection already knows.
 * The service never writes, never executes, and never accepts a caller-supplied
 * root.
 *
 * @module WorkspaceObservatory
 */
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  WorkspaceObservatoryFileInput,
  WorkspaceObservatoryFileResult,
  WorkspaceObservatoryTreeInput,
  WorkspaceObservatoryTreeResult,
} from "@cafecode/contracts";

/**
 * Denial reasons are deliberately coarse so a rejected request cannot be used
 * to probe the filesystem outside the selected project.
 *
 * `busy` and `timed-out` describe the observatory's own admission control
 * rather than anything about the requested path, so they leak nothing: `busy`
 * means the bounded pool of concurrent filesystem operations was already full,
 * and `timed-out` means one operation exceeded its deadline.
 */
export const WorkspaceObservatoryDenialReason = Schema.Literals([
  "unknown-project",
  "root-unavailable",
  "outside-root",
  "sensitive-path",
  "link",
  "not-a-directory",
  "not-a-file",
  "unreadable",
  "binary",
  "changed-while-reading",
  "busy",
  "timed-out",
]);
export type WorkspaceObservatoryDenialReason = typeof WorkspaceObservatoryDenialReason.Type;

export class WorkspaceObservatoryDeniedError extends Schema.TaggedErrorClass<WorkspaceObservatoryDeniedError>()(
  "WorkspaceObservatoryDeniedError",
  {
    reason: WorkspaceObservatoryDenialReason,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * WorkspaceObservatoryShape - Service API for read-only workspace observation.
 */
export interface WorkspaceObservatoryShape {
  /**
   * List one directory inside the selected project's workspace root.
   */
  readonly tree: (
    input: WorkspaceObservatoryTreeInput,
  ) => Effect.Effect<WorkspaceObservatoryTreeResult, WorkspaceObservatoryDeniedError>;

  /**
   * Read a bounded UTF-8 text preview of one regular file inside the selected
   * project's workspace root.
   */
  readonly readFile: (
    input: WorkspaceObservatoryFileInput,
  ) => Effect.Effect<WorkspaceObservatoryFileResult, WorkspaceObservatoryDeniedError>;
}

/**
 * WorkspaceObservatory - Service tag for read-only workspace observation.
 */
export class WorkspaceObservatory extends Context.Service<
  WorkspaceObservatory,
  WorkspaceObservatoryShape
>()("cafecode/workspace/Services/WorkspaceObservatory") {}
