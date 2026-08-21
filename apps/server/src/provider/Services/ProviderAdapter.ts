/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionForkInput,
  ProviderSessionForkResult,
  ProviderSessionStartInput,
  ProviderSteerTurnInput,
  ProviderThreadGoal,
  ProviderThreadGoalClearResult,
  ProviderThreadGoalSetInput,
  ThreadId,
  ProviderTurnSteerResult,
  ProviderTurnStartResult,
  TurnId,
} from "@cafecode/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export type ProviderSessionModelSwitchMode = "in-session" | "restart-resume" | "unsupported";
export type ProviderLiveSteerSupport = "supported" | "unsupported";
export type ProviderThreadGoalSupport = "supported" | "unsupported";
export type ProviderSessionForkSupport = "supported" | "unsupported";

export interface ProviderAdapterCapabilities {
  /**
   * Declares how changing a model or its provider-owned traits is applied.
   * `restart-resume` preserves the native conversation while atomically
   * replacing an idle provider process with the newly selected configuration.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  /**
   * Declares whether the adapter accepts user guidance while a turn is already running.
   */
  readonly liveSteer: ProviderLiveSteerSupport;
  /**
   * Declares whether this provider exposes Codex-style durable thread goals.
   *
   * This remains optional while decoding adapters built before the goal
   * capability existed; absence is always interpreted as unsupported.
   */
  readonly threadGoals?: ProviderThreadGoalSupport;
  /**
   * Declares whether the adapter can branch provider-owned conversation state.
   * Missing is interpreted as unsupported for older/out-of-process adapters.
   */
  readonly sessionFork?: ProviderSessionForkSupport;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /** Fork a completed provider-native conversation without changing the source. */
  readonly forkSession?: (
    input: ProviderSessionForkInput,
  ) => Effect.Effect<ProviderSessionForkResult, TError>;

  /**
   * Remove a just-created native fork when Cafe cannot commit its matching
   * thread. This is intentionally narrow cleanup, not a general thread-delete
   * surface.
   */
  readonly discardSessionFork?: (fork: ProviderSessionForkResult) => Effect.Effect<void, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Steer an active provider turn without starting a new turn.
   *
   * Adapters that declare `liveSteer: "supported"` must cryptographically bind
   * or protocol-bind the steer to the expected active turn id when the upstream
   * provider offers that precondition.
   */
  readonly steerTurn: (
    input: ProviderSteerTurnInput,
  ) => Effect.Effect<ProviderTurnSteerResult, TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Disable provider-side auto-resolution for one pending user-input request.
   * Only providers that advertise non-blocking questions need to implement it.
   */
  readonly snoozeUserInput?: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * Read the provider-owned goal for a materialized thread.
   *
   * Goal methods are present only when `threadGoals` is supported. The
   * provider-native thread id must remain encapsulated by the adapter.
   */
  readonly getGoal?: (threadId: ThreadId) => Effect.Effect<ProviderThreadGoal | null, TError>;

  /**
   * Create or update a provider-owned goal.
   */
  readonly setGoal?: (
    input: ProviderThreadGoalSetInput,
  ) => Effect.Effect<ProviderThreadGoal, TError>;

  /**
   * Clear a provider-owned goal.
   */
  readonly clearGoal?: (threadId: ThreadId) => Effect.Effect<ProviderThreadGoalClearResult, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
