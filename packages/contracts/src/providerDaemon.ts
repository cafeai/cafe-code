import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PortSchema, ThreadId } from "./baseSchemas.ts";
import {
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderSteerTurnInput,
  ProviderStopSessionInput,
  ProviderTurnSteerResult,
  ProviderTurnStartResult,
} from "./provider.ts";
import { ProviderRuntimeEvent } from "./providerRuntime.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ProviderSupervisorHealthSummary } from "./providerSupervisor.ts";

export const PROVIDER_DAEMON_HEALTH_PATH = "/api/provider-daemon/health";
export const PROVIDER_DAEMON_RPC_PATH = "/api/provider-daemon/rpc";
export const PROVIDER_DAEMON_EVENTS_PATH = "/api/provider-daemon/events";
export const PROVIDER_DAEMON_LEASES_PATH = "/api/provider-daemon/leases";

const ProviderDaemonToken = Schema.String.check(Schema.isMinLength(32));
const ProviderDaemonCommandId = Schema.String.check(Schema.isMinLength(16));
const ProviderDaemonLeaseId = Schema.String.check(Schema.isMinLength(16));

export const ProviderDaemonTransport = Schema.Literals(["tcp", "ipc"]);
export type ProviderDaemonTransport = typeof ProviderDaemonTransport.Type;

export const ProviderRuntimeProcessMode = Schema.Literals([
  "provider-daemon",
  "provider-supervisor",
]);
export type ProviderRuntimeProcessMode = typeof ProviderRuntimeProcessMode.Type;

export const ProviderDaemonCapability = Schema.Literals(["health", "events", "rpc", "lease"]);
export type ProviderDaemonCapability = typeof ProviderDaemonCapability.Type;

export const ProviderDaemonCommandDiagnostic = Schema.Struct({
  commandId: Schema.String,
  method: Schema.String,
  status: Schema.optional(Schema.Literals(["running", "completed", "failed"])),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  durationMs: Schema.optional(Schema.Number),
  requestSummary: Schema.optional(Schema.Unknown),
  responseSummary: Schema.optional(Schema.Unknown),
  errorTag: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
});
export type ProviderDaemonCommandDiagnostic = typeof ProviderDaemonCommandDiagnostic.Type;

export const ProviderDaemonPersistenceHealth = Schema.Struct({
  sqliteBusyTimeoutMs: NonNegativeInt,
});
export type ProviderDaemonPersistenceHealth = typeof ProviderDaemonPersistenceHealth.Type;

export const ProviderDaemonClientConfig = Schema.Struct({
  httpBaseUrl: Schema.String,
  transport: Schema.optional(ProviderDaemonTransport),
  socketPath: Schema.optional(Schema.String),
  token: ProviderDaemonToken,
  leaseId: Schema.optional(ProviderDaemonLeaseId),
});
export type ProviderDaemonClientConfig = typeof ProviderDaemonClientConfig.Type;

export const ProviderDaemonBootstrap = Schema.Struct({
  mode: ProviderRuntimeProcessMode,
  transport: Schema.optional(ProviderDaemonTransport),
  port: Schema.optional(PortSchema),
  host: Schema.optional(Schema.String),
  socketPath: Schema.optional(Schema.String),
  cafeCodeHome: Schema.String,
  token: ProviderDaemonToken,
  runtimeBuildId: Schema.optional(Schema.String),
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
});
export type ProviderDaemonBootstrap = typeof ProviderDaemonBootstrap.Type;

export const ProviderDaemonMarker = Schema.Struct({
  version: Schema.Literals([1, 2]),
  mode: Schema.optional(ProviderRuntimeProcessMode),
  protocolVersion: Schema.optional(NonNegativeInt),
  pid: NonNegativeInt,
  ppid: Schema.optional(NonNegativeInt),
  transport: Schema.optional(ProviderDaemonTransport),
  port: Schema.optional(PortSchema),
  host: Schema.optional(Schema.String),
  httpBaseUrl: Schema.String,
  socketPath: Schema.optional(Schema.String),
  credentialPath: Schema.optional(Schema.String),
  token: Schema.optional(ProviderDaemonToken),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  appVersion: Schema.String,
  runtimeBuildId: Schema.optional(Schema.String),
});
export type ProviderDaemonMarker = typeof ProviderDaemonMarker.Type;

export const ProviderDaemonUpstreamSupervisorHealth = Schema.Struct({
  configured: Schema.Boolean,
  reachable: Schema.Boolean,
  endpointTransport: Schema.optional(ProviderDaemonTransport),
  pid: Schema.optional(NonNegativeInt),
  ppid: Schema.optional(NonNegativeInt),
  mode: Schema.optional(ProviderRuntimeProcessMode),
  protocolVersion: Schema.optional(NonNegativeInt),
  version: Schema.optional(Schema.String),
  runtimeBuildId: Schema.optional(Schema.String),
  startedAt: Schema.optional(IsoDateTime),
  activeSessionCount: Schema.optional(NonNegativeInt),
  configuredInstanceCount: Schema.optional(NonNegativeInt),
  eventCursor: Schema.optional(NonNegativeInt),
  activeStreamCount: Schema.optional(NonNegativeInt),
  retainedEventCount: Schema.optional(NonNegativeInt),
  oldestEventCursor: Schema.optional(Schema.NullOr(NonNegativeInt)),
  newestEventCursor: Schema.optional(Schema.NullOr(NonNegativeInt)),
  leaseCount: Schema.optional(NonNegativeInt),
  commandCount: Schema.optional(NonNegativeInt),
  completedCommandCount: Schema.optional(NonNegativeInt),
  failedCommandCount: Schema.optional(NonNegativeInt),
  runningCommandCount: Schema.optional(NonNegativeInt),
  recentCompletedCommands: Schema.optional(Schema.Array(ProviderDaemonCommandDiagnostic)),
  recentRunningCommands: Schema.optional(Schema.Array(ProviderDaemonCommandDiagnostic)),
  recentFailedCommands: Schema.optional(Schema.Array(ProviderDaemonCommandDiagnostic)),
  persistence: Schema.optional(ProviderDaemonPersistenceHealth),
  healthLatencyMs: Schema.optional(Schema.Number),
  lastError: Schema.optional(Schema.String),
});
export type ProviderDaemonUpstreamSupervisorHealth =
  typeof ProviderDaemonUpstreamSupervisorHealth.Type;

export const ProviderDaemonErrorCauseDiagnostic = Schema.Struct({
  tag: Schema.String,
  message: Schema.String,
  name: Schema.optional(Schema.String),
  stack: Schema.optional(Schema.String),
  sqlReasonTag: Schema.optional(Schema.String),
  sqlOperation: Schema.optional(Schema.String),
  sqliteCode: Schema.optional(Schema.String),
  sqliteErrno: Schema.optional(Schema.Number),
});
export type ProviderDaemonErrorCauseDiagnostic = typeof ProviderDaemonErrorCauseDiagnostic.Type;

export const ProviderDaemonErrorDiagnostics = Schema.Struct({
  tag: Schema.String,
  message: Schema.String,
  name: Schema.optional(Schema.String),
  stack: Schema.optional(Schema.String),
  causeChain: Schema.Array(ProviderDaemonErrorCauseDiagnostic),
});
export type ProviderDaemonErrorDiagnostics = typeof ProviderDaemonErrorDiagnostics.Type;

export const ProviderDaemonRecentRpcFailure = Schema.Struct({
  failedAt: IsoDateTime,
  method: Schema.optional(Schema.String),
  commandId: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
  tag: Schema.String,
  message: Schema.String,
  diagnostics: Schema.optional(ProviderDaemonErrorDiagnostics),
});
export type ProviderDaemonRecentRpcFailure = typeof ProviderDaemonRecentRpcFailure.Type;

export const ProviderDaemonProcessDiagnostic = Schema.Struct({
  capturedAt: IsoDateTime,
  kind: Schema.Literals(["uncaughtException", "unhandledRejection", "warning", "manual"]),
  origin: Schema.optional(Schema.String),
  diagnostics: ProviderDaemonErrorDiagnostics,
});
export type ProviderDaemonProcessDiagnostic = typeof ProviderDaemonProcessDiagnostic.Type;

export const ProviderDaemonProcessDiagnosticsSnapshot = Schema.Struct({
  totalCount: NonNegativeInt,
  recentLimit: NonNegativeInt,
  recent: Schema.Array(ProviderDaemonProcessDiagnostic),
});
export type ProviderDaemonProcessDiagnosticsSnapshot =
  typeof ProviderDaemonProcessDiagnosticsSnapshot.Type;

export const ProviderDaemonRpcMetrics = Schema.Struct({
  totalRpcCount: NonNegativeInt,
  mutatingRpcCount: NonNegativeInt,
  failedRpcCount: NonNegativeInt,
  totalRpcDurationMs: Schema.Number,
  maxRpcDurationMs: Schema.Number,
  meanRpcDurationMs: Schema.optional(Schema.Number),
  lastRpcMethod: Schema.optional(Schema.String),
  lastRpcAt: Schema.optional(IsoDateTime),
  lastRpcDurationMs: Schema.optional(Schema.Number),
  recentFailures: Schema.optional(Schema.Array(ProviderDaemonRecentRpcFailure)),
});
export type ProviderDaemonRpcMetrics = typeof ProviderDaemonRpcMetrics.Type;

export const ProviderDaemonRuntimeEventMethodCount = Schema.Struct({
  key: Schema.String,
  count: NonNegativeInt,
});
export type ProviderDaemonRuntimeEventMethodCount =
  typeof ProviderDaemonRuntimeEventMethodCount.Type;

export const ProviderDaemonRecentRuntimeEvent = Schema.Struct({
  cursor: NonNegativeInt,
  emittedAt: IsoDateTime,
  eventId: Schema.String,
  type: Schema.String,
  threadId: Schema.optional(ThreadId),
  turnId: Schema.optional(Schema.String),
  itemId: Schema.optional(Schema.String),
  rawMethod: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.Unknown),
});
export type ProviderDaemonRecentRuntimeEvent = typeof ProviderDaemonRecentRuntimeEvent.Type;

export const ProviderDaemonTurnTimingDiagnostic = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.String,
  acceptedAt: Schema.optional(IsoDateTime),
  turnStartedAt: Schema.optional(IsoDateTime),
  firstAssistantItemStartedAt: Schema.optional(IsoDateTime),
  firstAssistantDeltaAt: Schema.optional(IsoDateTime),
  lastAssistantDeltaAt: Schema.optional(IsoDateTime),
  assistantCompletedAt: Schema.optional(IsoDateTime),
  turnCompletedAt: Schema.optional(IsoDateTime),
  lastEventAt: Schema.optional(IsoDateTime),
  acceptedToTurnStartedMs: Schema.optional(Schema.Number),
  acceptedToFirstAssistantDeltaMs: Schema.optional(Schema.Number),
  acceptedToTurnCompletedMs: Schema.optional(Schema.Number),
  turnStartedToFirstAssistantDeltaMs: Schema.optional(Schema.Number),
  firstAssistantDeltaTextBytes: Schema.optional(NonNegativeInt),
  assistantDeltaCount: NonNegativeInt,
  assistantDeltaTextBytes: NonNegativeInt,
  largestAssistantDeltaTextBytes: NonNegativeInt,
  maxAssistantDeltaGapMs: Schema.optional(Schema.Number),
  transportRetryCount: NonNegativeInt,
  responseStreamDisconnectedCount: NonNegativeInt,
  runtimeWarningCount: NonNegativeInt,
  runtimeErrorCount: NonNegativeInt,
  httpFallbackAt: Schema.optional(IsoDateTime),
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  inputByteLength: Schema.optional(NonNegativeInt),
});
export type ProviderDaemonTurnTimingDiagnostic = typeof ProviderDaemonTurnTimingDiagnostic.Type;

export const ProviderDaemonRuntimeEventDiagnostics = Schema.Struct({
  recentWindowSize: NonNegativeInt,
  recentEventCount: NonNegativeInt,
  snapshotBackfillEventCount: NonNegativeInt,
  assistantTextDeltaCount: NonNegativeInt,
  assistantMessageCompletedCount: NonNegativeInt,
  turnStartedCount: NonNegativeInt,
  turnCompletedCount: NonNegativeInt,
  runtimeWarningCount: NonNegativeInt,
  runtimeErrorCount: NonNegativeInt,
  lastEventAt: Schema.optional(IsoDateTime),
  lastEventType: Schema.optional(Schema.String),
  lastRawMethod: Schema.optional(Schema.String),
  lastThreadId: Schema.optional(ThreadId),
  lastTurnId: Schema.optional(Schema.String),
  lastSnapshotBackfillAt: Schema.optional(IsoDateTime),
  recentMethodCounts: Schema.Array(ProviderDaemonRuntimeEventMethodCount),
  recentSnapshotBackfillEvents: Schema.Array(ProviderDaemonRecentRuntimeEvent),
  recentRuntimeDiagnosticEvents: Schema.Array(ProviderDaemonRecentRuntimeEvent),
  recentTurnTimings: Schema.Array(ProviderDaemonTurnTimingDiagnostic),
});
export type ProviderDaemonRuntimeEventDiagnostics =
  typeof ProviderDaemonRuntimeEventDiagnostics.Type;

export const ProviderDaemonSupervisorProcess = Schema.Struct({
  status: Schema.Literals(["spawned", "adopted"]),
  pid: NonNegativeInt,
  httpBaseUrl: Schema.String,
  transport: ProviderDaemonTransport,
  socketPath: Schema.optional(Schema.String),
  leaseId: Schema.optional(ProviderDaemonLeaseId),
  markerPath: Schema.String,
  appVersion: Schema.String,
  protocolVersion: NonNegativeInt,
  runtimeBuildId: Schema.optional(Schema.String),
  adoptedExistingProcess: Schema.Boolean,
  durationMs: Schema.Number,
});
export type ProviderDaemonSupervisorProcess = typeof ProviderDaemonSupervisorProcess.Type;

export const ProviderDaemonHealth = Schema.Struct({
  ok: Schema.Literal(true),
  mode: ProviderRuntimeProcessMode,
  protocolVersion: Schema.optional(NonNegativeInt),
  pid: NonNegativeInt,
  ppid: NonNegativeInt,
  version: Schema.String,
  runtimeBuildId: Schema.optional(Schema.String),
  startedAt: IsoDateTime,
  activeSessionCount: NonNegativeInt,
  configuredInstanceCount: NonNegativeInt,
  eventCursor: NonNegativeInt,
  transport: Schema.optional(ProviderDaemonTransport),
  activeStreamCount: Schema.optional(NonNegativeInt),
  retainedEventCount: Schema.optional(NonNegativeInt),
  oldestEventCursor: Schema.optional(Schema.NullOr(NonNegativeInt)),
  newestEventCursor: Schema.optional(Schema.NullOr(NonNegativeInt)),
  leaseCount: Schema.optional(NonNegativeInt),
  commandCount: Schema.optional(NonNegativeInt),
  completedCommandCount: Schema.optional(NonNegativeInt),
  failedCommandCount: Schema.optional(NonNegativeInt),
  runningCommandCount: Schema.optional(NonNegativeInt),
  recentCompletedCommands: Schema.optional(Schema.Array(ProviderDaemonCommandDiagnostic)),
  recentRunningCommands: Schema.optional(Schema.Array(ProviderDaemonCommandDiagnostic)),
  recentFailedCommands: Schema.optional(Schema.Array(ProviderDaemonCommandDiagnostic)),
  supervisor: Schema.optional(ProviderSupervisorHealthSummary),
  upstreamSupervisor: Schema.optional(ProviderDaemonUpstreamSupervisorHealth),
  supervisorProcess: Schema.optional(ProviderDaemonSupervisorProcess),
  rpc: Schema.optional(ProviderDaemonRpcMetrics),
  persistence: Schema.optional(ProviderDaemonPersistenceHealth),
  runtimeEvents: Schema.optional(ProviderDaemonRuntimeEventDiagnostics),
  processDiagnostics: Schema.optional(ProviderDaemonProcessDiagnosticsSnapshot),
});
export type ProviderDaemonHealth = typeof ProviderDaemonHealth.Type;

export const ProviderDaemonLeaseRequest = Schema.Struct({
  clientKind: Schema.Literals(["desktop-main", "provider-daemon", "debug", "test"]),
  capabilities: Schema.Array(ProviderDaemonCapability),
});
export type ProviderDaemonLeaseRequest = typeof ProviderDaemonLeaseRequest.Type;

export const ProviderDaemonLeaseResponse = Schema.Struct({
  leaseId: ProviderDaemonLeaseId,
  token: ProviderDaemonToken,
  capabilities: Schema.Array(ProviderDaemonCapability),
  issuedAt: IsoDateTime,
});
export type ProviderDaemonLeaseResponse = typeof ProviderDaemonLeaseResponse.Type;

export const ProviderDaemonAdapterCapabilities = Schema.Struct({
  sessionModelSwitch: Schema.Literals(["in-session", "unsupported"]),
  liveSteer: Schema.Literals(["supported", "unsupported"]),
});
export type ProviderDaemonAdapterCapabilities = typeof ProviderDaemonAdapterCapabilities.Type;

export const ProviderDaemonContinuationIdentity = Schema.Struct({
  driverKind: ProviderDriverKind,
  continuationKey: Schema.String,
});
export type ProviderDaemonContinuationIdentity = typeof ProviderDaemonContinuationIdentity.Type;

export const ProviderDaemonInstanceRoutingInfo = Schema.Struct({
  instanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  displayName: Schema.optional(Schema.String),
  accentColor: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
  continuationIdentity: ProviderDaemonContinuationIdentity,
});
export type ProviderDaemonInstanceRoutingInfo = typeof ProviderDaemonInstanceRoutingInfo.Type;

export const ProviderDaemonEventRecord = Schema.Struct({
  cursor: NonNegativeInt,
  emittedAt: IsoDateTime,
  event: ProviderRuntimeEvent,
});
export type ProviderDaemonEventRecord = typeof ProviderDaemonEventRecord.Type;

export const ProviderDaemonRpcError = Schema.Struct({
  tag: Schema.String,
  message: Schema.String,
  diagnostics: Schema.optional(ProviderDaemonErrorDiagnostics),
});
export type ProviderDaemonRpcError = typeof ProviderDaemonRpcError.Type;

export const ProviderDaemonRpcEnvelope = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.Unknown,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: ProviderDaemonRpcError,
  }),
]);
export type ProviderDaemonRpcEnvelope = typeof ProviderDaemonRpcEnvelope.Type;

const GetCapabilitiesPayload = Schema.Struct({
  instanceId: ProviderInstanceId,
});

const GetInstanceInfoPayload = Schema.Struct({
  instanceId: ProviderInstanceId,
});

const RollbackConversationPayload = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

export const ProviderDaemonRpcRequest = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("startSession"),
    commandId: Schema.optional(ProviderDaemonCommandId),
    payload: ProviderSessionStartInput,
  }),
  Schema.Struct({
    method: Schema.Literal("sendTurn"),
    commandId: Schema.optional(ProviderDaemonCommandId),
    payload: ProviderSendTurnInput,
  }),
  Schema.Struct({
    method: Schema.Literal("steerTurn"),
    commandId: Schema.optional(ProviderDaemonCommandId),
    payload: ProviderSteerTurnInput,
  }),
  Schema.Struct({
    method: Schema.Literal("interruptTurn"),
    commandId: Schema.optional(ProviderDaemonCommandId),
    payload: ProviderInterruptTurnInput,
  }),
  Schema.Struct({
    method: Schema.Literal("respondToRequest"),
    commandId: Schema.optional(ProviderDaemonCommandId),
    payload: ProviderRespondToRequestInput,
  }),
  Schema.Struct({
    method: Schema.Literal("respondToUserInput"),
    commandId: Schema.optional(ProviderDaemonCommandId),
    payload: ProviderRespondToUserInputInput,
  }),
  Schema.Struct({
    method: Schema.Literal("stopSession"),
    commandId: Schema.optional(ProviderDaemonCommandId),
    payload: ProviderStopSessionInput,
  }),
  Schema.Struct({
    method: Schema.Literal("listSessions"),
    payload: Schema.Struct({}),
  }),
  Schema.Struct({
    method: Schema.Literal("getCapabilities"),
    payload: GetCapabilitiesPayload,
  }),
  Schema.Struct({
    method: Schema.Literal("getInstanceInfo"),
    payload: GetInstanceInfoPayload,
  }),
  Schema.Struct({
    method: Schema.Literal("rollbackConversation"),
    commandId: Schema.optional(ProviderDaemonCommandId),
    payload: RollbackConversationPayload,
  }),
]);
export type ProviderDaemonRpcRequest = typeof ProviderDaemonRpcRequest.Type;

export const ProviderDaemonRpcResultByMethod = {
  startSession: ProviderSession,
  sendTurn: ProviderTurnStartResult,
  steerTurn: ProviderTurnSteerResult,
  interruptTurn: Schema.Void,
  respondToRequest: Schema.Void,
  respondToUserInput: Schema.Void,
  stopSession: Schema.Void,
  listSessions: Schema.Array(ProviderSession),
  getCapabilities: ProviderDaemonAdapterCapabilities,
  getInstanceInfo: ProviderDaemonInstanceRoutingInfo,
  rollbackConversation: Schema.Void,
} as const;
