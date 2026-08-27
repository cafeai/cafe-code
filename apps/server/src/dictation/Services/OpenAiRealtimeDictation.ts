import type {
  DictationCredentialStatus,
  DictationError,
  DictationRealtimeClientSecret,
  DictationTranscriptionModel,
} from "@cafecode/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface OpenAiRealtimeDictationShape {
  /** Reads only whether the server-side credential is present and valid. */
  readonly getStatus: Effect.Effect<Omit<DictationCredentialStatus, "canManage">, DictationError>;
  /** Replaces the permanent key in Cafe's restrictive server secret store. */
  readonly setApiKey: (apiKey: string) => Effect.Effect<void, DictationError>;
  /** Idempotently removes the permanent key. */
  readonly clearApiKey: Effect.Effect<void, DictationError>;
  /**
   * Mints one short-lived, transcription-only OpenAI Realtime credential.
   * `safetyIdentifier` must already be a privacy-preserving stable digest.
   */
  readonly createClientSecret: (input: {
    readonly safetyIdentifier: string;
    readonly model?: DictationTranscriptionModel;
  }) => Effect.Effect<DictationRealtimeClientSecret, DictationError>;
}

export class OpenAiRealtimeDictation extends Context.Service<
  OpenAiRealtimeDictation,
  OpenAiRealtimeDictationShape
>()("cafecode/dictation/Services/OpenAiRealtimeDictation") {}
