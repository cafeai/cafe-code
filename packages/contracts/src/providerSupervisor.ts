import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ProviderSupervisorSessionId = TrimmedNonEmptyString.pipe(
  Schema.brand("ProviderSupervisorSessionId"),
);
export type ProviderSupervisorSessionId = typeof ProviderSupervisorSessionId.Type;

export const ProviderSupervisorId = TrimmedNonEmptyString.pipe(
  Schema.brand("ProviderSupervisorId"),
);
export type ProviderSupervisorId = typeof ProviderSupervisorId.Type;

export const ProviderSupervisorOwnerId = TrimmedNonEmptyString.pipe(
  Schema.brand("ProviderSupervisorOwnerId"),
);
export type ProviderSupervisorOwnerId = typeof ProviderSupervisorOwnerId.Type;

export const ProviderSupervisorOwnerKind = Schema.Literals([
  "provider-daemon",
  "main-daemon",
  "supervisor",
  "test",
  "unknown",
]);
export type ProviderSupervisorOwnerKind = typeof ProviderSupervisorOwnerKind.Type;

export const ProviderSupervisorTransferState = Schema.Literals([
  "running",
  "preparing-transfer",
  "transferring",
  "draining",
  "detached",
  "stopped",
  "error",
]);
export type ProviderSupervisorTransferState = typeof ProviderSupervisorTransferState.Type;

export const ProviderSupervisorStreamKind = Schema.Literals(["stdout", "stderr", "pty"]);
export type ProviderSupervisorStreamKind = typeof ProviderSupervisorStreamKind.Type;

export const ProviderSupervisorSession = Schema.Struct({
  sessionId: ProviderSupervisorSessionId,
  supervisorId: ProviderSupervisorId,
  ownerId: ProviderSupervisorOwnerId,
  ownerKind: ProviderSupervisorOwnerKind,
  threadId: Schema.optional(ThreadId),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  providerKind: Schema.optional(Schema.String),
  providerPid: Schema.optional(NonNegativeInt),
  commandDisplay: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  socketPath: Schema.optional(Schema.String),
  protocolVersion: PositiveInt,
  ioGeneration: PositiveInt,
  rawByteCursor: NonNegativeInt,
  parserCursor: NonNegativeInt,
  transferState: ProviderSupervisorTransferState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastAttachedAt: Schema.optional(IsoDateTime),
  lastDetachedAt: Schema.optional(IsoDateTime),
  lastError: Schema.optional(Schema.String),
});
export type ProviderSupervisorSession = typeof ProviderSupervisorSession.Type;

export const ProviderSupervisorHealthSummary = Schema.Struct({
  sessionCount: NonNegativeInt,
  runningSessionCount: NonNegativeInt,
  transferringSessionCount: NonNegativeInt,
  detachedSessionCount: NonNegativeInt,
  stoppedSessionCount: NonNegativeInt,
  errorSessionCount: NonNegativeInt,
  maxRawByteCursor: NonNegativeInt,
  maxParserCursor: NonNegativeInt,
});
export type ProviderSupervisorHealthSummary = typeof ProviderSupervisorHealthSummary.Type;

export const ProviderSupervisorDiagnostics = ProviderSupervisorHealthSummary.pipe(
  Schema.fieldsAssign({
    sessions: Schema.Array(ProviderSupervisorSession),
  }),
);
export type ProviderSupervisorDiagnostics = typeof ProviderSupervisorDiagnostics.Type;

export const ProviderSupervisorOwnershipEvent = Schema.Struct({
  eventId: NonNegativeInt,
  sessionId: ProviderSupervisorSessionId,
  eventType: Schema.Literals([
    "created",
    "adopted",
    "detached",
    "transfer-state",
    "cursor",
    "error",
  ]),
  ownerId: ProviderSupervisorOwnerId,
  previousOwnerId: Schema.optional(ProviderSupervisorOwnerId),
  ioGeneration: PositiveInt,
  transferState: ProviderSupervisorTransferState,
  emittedAt: IsoDateTime,
  detail: Schema.optional(Schema.Unknown),
});
export type ProviderSupervisorOwnershipEvent = typeof ProviderSupervisorOwnershipEvent.Type;

export const ProviderSupervisorIoEventMetadata = Schema.Struct({
  cursor: NonNegativeInt,
  sessionId: ProviderSupervisorSessionId,
  streamKind: ProviderSupervisorStreamKind,
  byteOffset: NonNegativeInt,
  byteLength: PositiveInt,
  emittedAt: IsoDateTime,
  sha256: Schema.optional(Schema.String),
});
export type ProviderSupervisorIoEventMetadata = typeof ProviderSupervisorIoEventMetadata.Type;
