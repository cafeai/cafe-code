/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Acts as the cross-provider facade used by transports (WebSocket/RPC). It
 * resolves provider adapters through `ProviderAdapterRegistry`, routes
 * session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
 * provider event stream to callers.
 *
 * Uses Effect `Context.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  ProviderDriverKind,
  ProviderInterruptTurnInput,
  ProviderInstanceId,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSnoozeUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionForkDiscardInput,
  ProviderSessionForkInput,
  ProviderSessionForkResult,
  ProviderSessionStartInput,
  ProviderThreadGoal,
  ProviderThreadGoalClearInput,
  ProviderThreadGoalClearResult,
  ProviderThreadGoalGetInput,
  ProviderThreadGoalSetInput,
  ServerProviderRuntimeRestartInput,
  ProviderSteerTurnInput,
  ProviderStopSessionInput,
  ThreadId,
  TurnId,
  ProviderTurnSteerResult,
  ProviderTurnStartResult,
} from "@cafecode/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { ProviderServiceError } from "../Errors.ts";
import type {
  ProviderAdapterCapabilities,
  ProviderSubagentDetail,
  ProviderThreadSnapshot,
} from "./ProviderAdapter.ts";
import type { ProviderInstanceRoutingInfo } from "./ProviderAdapterRegistry.ts";

export interface ProviderThreadReadResult {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly snapshot: ProviderThreadSnapshot;
}

export interface ProviderSubagentDetailReadResult extends ProviderSubagentDetail {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
}

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderServiceShape {
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /** Persistently fork one Codex/Claude conversation into a new Cafe thread id. */
  readonly forkSession: (
    input: ProviderSessionForkInput,
  ) => Effect.Effect<ProviderSessionForkResult, ProviderServiceError>;

  /** Compensate a successful provider fork whose Cafe domain commit failed. */
  readonly discardSessionFork: (
    input: ProviderSessionForkDiscardInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Send a provider turn.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /**
   * Steer a currently running provider turn.
   */
  readonly steerTurn: (
    input: ProviderSteerTurnInput,
  ) => Effect.Effect<ProviderTurnSteerResult, ProviderServiceError>;

  /**
   * Interrupt a running provider turn.
   */
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider approval request.
   */
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider structured user-input request.
   */
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /** Disable automatic resolution for one provider user-input request. */
  readonly snoozeUserInput: (
    input: ProviderSnoozeUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Permanently retire every provider session for one Cafe thread.
   *
   * This is stronger than a normal Stop. The implementation first fences the
   * thread against new provider mutations and runtime-event persistence, then
   * stops every configured adapter that still owns the thread. The hard-delete
   * transport must await this boundary (and downstream runtime ingestion)
   * before removing persistence so a delayed lifecycle event cannot resurrect
   * rows after the delete transaction commits.
   */
  readonly quiesceThreadForHardDelete: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop all live sessions owned by one configured provider instance.
   *
   * This intentionally does not start a replacement session immediately:
   * future user intent should reopen Codex/Claude with the persisted resume
   * cursor through the normal `startSession` path, so the renderer does not
   * infer lifecycle truth from a raw process restart.
   */
  readonly restartProviderRuntime: (input: ServerProviderRuntimeRestartInput) => Effect.Effect<
    {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderSession["provider"];
      readonly stoppedSessionCount: number;
    },
    ProviderServiceError
  >;

  /**
   * List active provider sessions.
   *
   * Aggregates runtime session lists from all registered adapters.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Read capabilities for the adapter bound to a configured provider instance.
   */
  readonly getCapabilities: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderServiceError>;

  /**
   * Read a provider-owned durable goal for a Cafe thread.
   */
  readonly getGoal?: (
    input: ProviderThreadGoalGetInput,
  ) => Effect.Effect<ProviderThreadGoal | null, ProviderServiceError>;

  /**
   * Create or update a provider-owned durable goal.
   */
  readonly setGoal?: (
    input: ProviderThreadGoalSetInput,
  ) => Effect.Effect<ProviderThreadGoal, ProviderServiceError>;

  /**
   * Clear a provider-owned durable goal.
   */
  readonly clearGoal?: (
    input: ProviderThreadGoalClearInput,
  ) => Effect.Effect<ProviderThreadGoalClearResult, ProviderServiceError>;

  /**
   * Read provider-owned thread history for the selected Cafe thread.
   *
   * The call routes through the configured provider adapter, so Codex/OpenAI
   * history reads use Codex app-server `thread/read` and provider account/home
   * checks remain inside the adapter layer.
   */
  readonly readThread?: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<ProviderThreadReadResult, ProviderServiceError>;

  /**
   * Read a provider-verified child thread through its root Cafe session.
   * The adapter returns public conversation text only; provider-native rollout
   * objects are never exposed by this service.
   */
  readonly readSubagentDetail: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly subagentId: string;
    readonly historyId?: string;
  }) => Effect.Effect<ProviderSubagentDetailReadResult, ProviderServiceError>;

  /**
   * Roll back provider conversation state by a number of turns.
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Canonical provider runtime event stream.
   *
   * Fan-out is owned by ProviderService (not by a standalone event-bus service).
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends Context.Service<ProviderService, ProviderServiceShape>()(
  "cafecode/provider/Services/ProviderService",
) {}
