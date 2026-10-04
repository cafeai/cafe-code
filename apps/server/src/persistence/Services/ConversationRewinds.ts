import type {
  ProviderSession,
  ProviderPrepareConversationRollbackInput,
  ProviderConversationRewindIdentity,
  ProviderFinishConversationRollbackInput,
  ProviderRuntimeEvent,
} from "@cafecode/contracts";
import type * as Effect from "effect/Effect";
import type { PersistenceSqlError, PersistenceDecodeError } from "../Errors.ts";

export type RewindPhase =
  | "preparing"
  | "prepared"
  | "switching"
  | "committed"
  | "aborted"
  | "finished"
  | "refused";
export interface ConversationRewind {
  readonly operationId: string;
  readonly phase: RewindPhase;
  readonly runtimeId: string;
  readonly expectedControlSequence: number;
  readonly retainedTurnCount: number;
  readonly numTurns: number;
  readonly firstRemovedTurnId: string;
  readonly original: ProviderSession;
  readonly candidate: ProviderSession | null;
}
export type ConversationRewindError = PersistenceSqlError | PersistenceDecodeError;
export interface ConversationRewindStore {
  readonly read: (
    threadId: string,
  ) => Effect.Effect<ConversationRewind | null, ConversationRewindError>;
  /** Returns false on any changed identity/control or competing reservation. */
  readonly reserve: (
    input: ProviderPrepareConversationRollbackInput,
    original: ProviderSession,
  ) => Effect.Effect<boolean, ConversationRewindError>;
  readonly prepared: (
    input: ProviderConversationRewindIdentity,
    candidate: ProviderSession,
  ) => Effect.Effect<boolean, ConversationRewindError>;
  readonly commit: (
    input: ProviderConversationRewindIdentity,
  ) => Effect.Effect<boolean, ConversationRewindError>;
  readonly finish: (
    input: ProviderFinishConversationRollbackInput,
  ) => Effect.Effect<boolean, ConversationRewindError>;
  /** A definitive pre-filesystem refusal releases only its untouched fence. */
  readonly refuse: (
    input: ProviderConversationRewindIdentity,
  ) => Effect.Effect<boolean, ConversationRewindError>;
  readonly acceptsEvent: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<boolean, ConversationRewindError>;
  /** One SQL observation separates exact original preparation-time events,
   * proven retired replay and unknown pending identity. Preparing has not
   * authorized any filesystem mutation; prepared proves source retirement. */
  readonly classifyEvent: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<"accepted" | "pending" | "retired", ConversationRewindError>;
}

export const isPendingConversationRewind = (rewind: ConversationRewind | null): boolean =>
  rewind !== null &&
  rewind.phase !== "aborted" &&
  rewind.phase !== "finished" &&
  rewind.phase !== "refused";
