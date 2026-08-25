import * as Schema from "effect/Schema";

import type { CheckpointServiceError } from "../checkpointing/Errors.ts";

/**
 * ProviderAdapterValidationError - Invalid adapter API input.
 */
export class ProviderAdapterValidationError extends Schema.TaggedErrorClass<ProviderAdapterValidationError>()(
  "ProviderAdapterValidationError",
  {
    provider: Schema.String,
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider adapter validation failed (${this.provider}) in ${this.operation}: ${this.issue}`;
  }
}

/**
 * ProviderAdapterSessionNotFoundError - Adapter-owned session id is unknown.
 */
export class ProviderAdapterSessionNotFoundError extends Schema.TaggedErrorClass<ProviderAdapterSessionNotFoundError>()(
  "ProviderAdapterSessionNotFoundError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Unknown ${this.provider} adapter thread: ${this.threadId}`;
  }
}

/**
 * ProviderAdapterSessionClosedError - Adapter session exists but is closed.
 */
export class ProviderAdapterSessionClosedError extends Schema.TaggedErrorClass<ProviderAdapterSessionClosedError>()(
  "ProviderAdapterSessionClosedError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `${this.provider} adapter thread is closed: ${this.threadId}`;
  }
}

/**
 * ProviderAdapterRequestError - Provider protocol request failed or timed out.
 */
export class ProviderAdapterRequestError extends Schema.TaggedErrorClass<ProviderAdapterRequestError>()(
  "ProviderAdapterRequestError",
  {
    provider: Schema.String,
    method: Schema.String,
    detail: Schema.String,
    /**
     * The typed error tag returned by an out-of-process provider runtime.
     *
     * Keep this separate from `detail`: orchestration must distinguish a real
     * registry miss from transport failures without parsing human-readable
     * error strings. The field carries no provider payload or credentials.
     */
    remoteErrorTag: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider adapter request failed (${this.provider}) for ${this.method}: ${this.detail}`;
  }
}

/**
 * ProviderAdapterProcessError - Provider process lifecycle failure.
 */
export class ProviderAdapterProcessError extends Schema.TaggedErrorClass<ProviderAdapterProcessError>()(
  "ProviderAdapterProcessError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider adapter process error (${this.provider}) for thread ${this.threadId}: ${this.detail}`;
  }
}

/**
 * Finite failure reasons for the read-only provider subagent transcript path.
 *
 * Provider-native thread ids, account details, filesystem paths, response
 * bodies, and exception causes are intentionally absent. This error crosses
 * the adapter/service boundary and can subsequently be recorded by provider
 * daemon diagnostics, so allowing an arbitrary message or cause here would
 * turn an upstream provider failure into a local information disclosure.
 */
export const ProviderSubagentDetailReadFailureReason = Schema.Literals([
  "invalid-request",
  "session-unavailable",
  "provider-unavailable",
  "provider-process-exited",
  "provider-transport-unavailable",
  "provider-response-invalid",
  "root-thread-unavailable",
  "root-identity-mismatch",
  "child-identity-mismatch",
  "missing-subagent-metadata",
  "parent-metadata-mismatch",
  "session-tree-mismatch",
  "provider-request-failed",
]);
export type ProviderSubagentDetailReadFailureReason =
  typeof ProviderSubagentDetailReadFailureReason.Type;
const isProviderSubagentDetailReadFailureReasonSchema = Schema.is(
  ProviderSubagentDetailReadFailureReason,
);

export function isProviderSubagentDetailReadFailureReason(
  value: unknown,
): value is ProviderSubagentDetailReadFailureReason {
  return isProviderSubagentDetailReadFailureReasonSchema(value);
}

export class ProviderSubagentDetailReadError extends Schema.TaggedErrorClass<ProviderSubagentDetailReadError>()(
  "ProviderSubagentDetailReadError",
  {
    reason: ProviderSubagentDetailReadFailureReason,
  },
) {
  override get message(): string {
    return `Subagent detail read failed: ${this.reason}`;
  }
}

/**
 * Construct the diagnostic-safe subagent error without an Error stack.
 *
 * Even a newly-created stack contains local source paths. The provider daemon
 * intentionally retains stacks for ordinary operational failures, so this
 * privacy-sensitive operation clears its stack at construction instead of
 * relying on every future transport or logger to remember a special case.
 */
export function makeProviderSubagentDetailReadError(
  reason: ProviderSubagentDetailReadFailureReason,
): ProviderSubagentDetailReadError {
  const error = new ProviderSubagentDetailReadError({ reason });
  Reflect.deleteProperty(error, "stack");
  return error;
}

/**
 * ProviderValidationError - Invalid provider API input.
 */
export class ProviderValidationError extends Schema.TaggedErrorClass<ProviderValidationError>()(
  "ProviderValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider validation failed in ${this.operation}: ${this.issue}`;
  }
}

/**
 * ProviderUnsupportedError - Requested provider is not implemented.
 */
export class ProviderUnsupportedError extends Schema.TaggedErrorClass<ProviderUnsupportedError>()(
  "ProviderUnsupportedError",
  {
    provider: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider '${this.provider}' is not implemented`;
  }
}

/**
 * ProviderInstanceNotFoundError - Lookup against the instance registry failed.
 *
 * Distinct from `ProviderUnsupportedError`: the driver is registered, but no
 * instance with the requested id has been bootstrapped — typically because
 * the persisted instance id refers to an instance the user removed from
 * settings, or because routing is asked for an instance before the registry
 * has finished its first reload.
 */
export class ProviderInstanceNotFoundError extends Schema.TaggedErrorClass<ProviderInstanceNotFoundError>()(
  "ProviderInstanceNotFoundError",
  {
    instanceId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `No provider instance bound to id '${this.instanceId}'`;
  }
}

/**
 * ProviderDriverError - A driver `create` call failed before producing an
 * instance. Surfaced to the registry, which marks the offending entry as
 * an "unavailable" shadow snapshot rather than crashing the server.
 */
export class ProviderDriverError extends Schema.TaggedErrorClass<ProviderDriverError>()(
  "ProviderDriverError",
  {
    driver: Schema.String,
    instanceId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider driver '${this.driver}' failed to create instance '${this.instanceId}': ${this.detail}`;
  }
}

/**
 * ProviderSessionNotFoundError - Provider-facing session not found.
 */
export class ProviderSessionNotFoundError extends Schema.TaggedErrorClass<ProviderSessionNotFoundError>()(
  "ProviderSessionNotFoundError",
  {
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Unknown provider thread: ${this.threadId}`;
  }
}

/**
 * ProviderSessionDirectoryPersistenceError - Session directory persistence failure.
 */
export class ProviderSessionDirectoryPersistenceError extends Schema.TaggedErrorClass<ProviderSessionDirectoryPersistenceError>()(
  "ProviderSessionDirectoryPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider session directory persistence error in ${this.operation}: ${this.detail}`;
  }
}

export type ProviderAdapterError =
  | ProviderAdapterValidationError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterSessionClosedError
  | ProviderAdapterRequestError
  | ProviderAdapterProcessError
  | ProviderSubagentDetailReadError;

export type ProviderServiceError =
  | ProviderValidationError
  | ProviderUnsupportedError
  | ProviderInstanceNotFoundError
  | ProviderSessionNotFoundError
  | ProviderSessionDirectoryPersistenceError
  | ProviderAdapterError
  | CheckpointServiceError;
