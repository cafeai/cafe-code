import type { DictationErrorCode, DictationRealtimeClientSecret } from "@cafecode/contracts";

import { DICTATION_RPC_ERROR_MESSAGES, readDictationRpcErrorCode } from "./errors";

export const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

// Realtime SDP exchanges should normally finish within a few seconds. A
// bounded setup prevents a dead upstream connection from retaining an active
// microphone indefinitely after the user has granted access.
const REALTIME_SETUP_TIMEOUT_MS = 20_000;

// The final completion event can trail input_audio_buffer.commit. Ten seconds
// is deliberately generous for a short composer utterance while still giving
// Stop deterministic cleanup semantics when the upstream session disappears.
const REALTIME_FINALIZATION_TIMEOUT_MS = 10_000;
const MIN_CLIENT_SECRET_LIFETIME_MS = 5_000;
const MAX_SDP_ANSWER_BYTES = 1_048_576;
const MAX_EVENT_CHARS = 256_000;
const MAX_ITEM_ID_CHARS = 256;
const MAX_TRANSCRIPT_CHARS = 128_000;

export type RealtimeTranscriptionErrorCode =
  | DictationErrorCode
  | "cancelled"
  | "connection_failed"
  | "finalization_timeout"
  | "microphone_denied"
  | "microphone_unavailable"
  | "protocol_error"
  | "session_rejected"
  | "session_expired"
  | "session_setup_failed"
  | "transcript_conflict"
  | "unsupported";

/**
 * Every public message is fixed and sanitized. In particular, never attach a
 * fetch Response, SDP body, server event, or client secret as a serializable
 * cause: browser tooling and renderer diagnostics may retain thrown values.
 */
export class RealtimeTranscriptionError extends Error {
  readonly code: RealtimeTranscriptionErrorCode;

  constructor(code: RealtimeTranscriptionErrorCode, message: string) {
    super(message);
    this.name = "RealtimeTranscriptionError";
    this.code = code;
  }
}

const cancelledError = () =>
  new RealtimeTranscriptionError("cancelled", "Dictation was cancelled.");

const connectionError = () =>
  new RealtimeTranscriptionError(
    "connection_failed",
    "Cafe could not connect the microphone to OpenAI.",
  );

const sessionSetupError = () =>
  new RealtimeTranscriptionError("session_setup_failed", "Cafe could not start dictation.");

/**
 * The client-secret RPC returns a typed, sanitized DictationError. Rebuild the
 * error from its allowlisted code so a hostile or older server cannot smuggle
 * its message, cause, provider body, or credential into a renderer toast.
 */
function normalizeClientSecretError(
  error: unknown,
  externallyCancelled: boolean,
): RealtimeTranscriptionError {
  if (externallyCancelled) return cancelledError();
  const code = readDictationRpcErrorCode(error);
  return code === null
    ? sessionSetupError()
    : new RealtimeTranscriptionError(code, DICTATION_RPC_ERROR_MESSAGES[code]);
}

/** Classify only the public HTTP status; never read an error response body. */
function realtimeCallResponseError(status: number): RealtimeTranscriptionError {
  if (status === 401 || status === 403) {
    return new RealtimeTranscriptionError(
      "session_rejected",
      "OpenAI rejected the Realtime dictation session. Check this API project's model access.",
    );
  }
  if (status === 429) {
    return new RealtimeTranscriptionError(
      "upstream_rate_limited",
      DICTATION_RPC_ERROR_MESSAGES.upstream_rate_limited,
    );
  }
  if (status === 400 || status === 404 || status === 422) {
    return new RealtimeTranscriptionError(
      "session_rejected",
      "OpenAI rejected Cafe's Realtime dictation session configuration.",
    );
  }
  if (status >= 500 && status <= 599) {
    return new RealtimeTranscriptionError(
      "upstream_unavailable",
      "OpenAI is temporarily unavailable for dictation.",
    );
  }
  return connectionError();
}

const protocolError = () =>
  new RealtimeTranscriptionError("protocol_error", "OpenAI returned an invalid dictation event.");

export interface DictationBrowserCapability {
  readonly supported: boolean;
  readonly unavailableReason: "insecure_context" | "missing_browser_api" | null;
}

/**
 * getUserMedia is available only in a secure context. Cafe deliberately hides
 * the microphone rather than allowing a click that is guaranteed to fail in
 * an insecure browser or an older embedded renderer.
 */
export function readDictationBrowserCapability(): DictationBrowserCapability {
  if (typeof window === "undefined" || !window.isSecureContext) {
    return { supported: false, unavailableReason: "insecure_context" };
  }
  if (
    typeof RTCPeerConnection !== "function" ||
    typeof navigator.mediaDevices?.getUserMedia !== "function"
  ) {
    return { supported: false, unavailableReason: "missing_browser_api" };
  }
  return { supported: true, unavailableReason: null };
}

export interface RealtimeTranscriptItem {
  readonly partial: string;
  readonly final: string | null;
}

export interface RealtimeTranscriptState {
  readonly order: readonly string[];
  readonly items: ReadonlyMap<string, RealtimeTranscriptItem>;
  readonly displayedCharacterCount: number;
}

export type RealtimeTranscriptEvent =
  | {
      readonly type: "conversation.item.input_audio_transcription.delta";
      readonly itemId: string;
      readonly delta: string;
    }
  | {
      readonly type: "conversation.item.input_audio_transcription.completed";
      readonly itemId: string;
      readonly transcript: string;
    };

interface RealtimeServerErrorEvent {
  readonly type: "error";
  readonly code: string | null;
}

type DecodedRealtimeServerEvent = RealtimeTranscriptEvent | RealtimeServerErrorEvent | null;

export function createRealtimeTranscriptState(): RealtimeTranscriptState {
  return {
    order: [],
    items: new Map(),
    displayedCharacterCount: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function decodeItemId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ITEM_ID_CHARS ||
    containsAsciiControlCharacter(value)
  ) {
    throw protocolError();
  }
  return value;
}

function decodeTranscriptText(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_TRANSCRIPT_CHARS) {
    throw protocolError();
  }
  return value;
}

/** Decode only allowlisted fields from the untrusted Realtime data channel. */
export function decodeRealtimeServerEvent(data: unknown): DecodedRealtimeServerEvent {
  if (typeof data !== "string") return null;
  if (data.length > MAX_EVENT_CHARS) throw protocolError();

  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    throw protocolError();
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return null;

  if (parsed.type === "conversation.item.input_audio_transcription.delta") {
    return {
      type: parsed.type,
      itemId: decodeItemId(parsed.item_id),
      delta: decodeTranscriptText(parsed.delta),
    };
  }

  if (parsed.type === "conversation.item.input_audio_transcription.completed") {
    return {
      type: parsed.type,
      itemId: decodeItemId(parsed.item_id),
      transcript: decodeTranscriptText(parsed.transcript),
    };
  }

  if (parsed.type === "error") {
    const nestedError = isRecord(parsed.error) ? parsed.error : null;
    const rawCode = nestedError?.code;
    return {
      type: "error",
      code:
        typeof rawCode === "string" &&
        rawCode.length <= 160 &&
        !containsAsciiControlCharacter(rawCode)
          ? rawCode
          : null,
    };
  }

  // Realtime emits many lifecycle events that the composer does not need.
  return null;
}

/**
 * Deltas are incremental, while completed.transcript is authoritative for its
 * item. Item order is based on first observation because completion events for
 * separate turns are explicitly allowed to arrive out of order.
 */
export function reduceRealtimeTranscript(
  state: RealtimeTranscriptState,
  event: RealtimeTranscriptEvent,
): RealtimeTranscriptState {
  const previous = state.items.get(event.itemId) ?? { partial: "", final: null };
  const previousDisplayed = previous.final ?? previous.partial;
  const nextItem: RealtimeTranscriptItem =
    event.type === "conversation.item.input_audio_transcription.delta"
      ? previous.final === null
        ? { partial: `${previous.partial}${event.delta}`, final: null }
        : previous
      : { partial: previous.partial, final: event.transcript };
  const nextDisplayed = nextItem.final ?? nextItem.partial;
  const displayedCharacterCount =
    state.displayedCharacterCount - previousDisplayed.length + nextDisplayed.length;
  if (displayedCharacterCount > MAX_TRANSCRIPT_CHARS) {
    throw new RealtimeTranscriptionError(
      "protocol_error",
      "Dictation exceeded the maximum transcript length.",
    );
  }

  const items = new Map(state.items);
  items.set(event.itemId, nextItem);
  return {
    order: state.items.has(event.itemId) ? state.order : [...state.order, event.itemId],
    items,
    displayedCharacterCount,
  };
}

function appendTranscriptSegment(current: string, next: string): string {
  if (next.length === 0) return current;
  if (current.length === 0) return next;
  return /\s$/u.test(current) || /^\s/u.test(next) ? `${current}${next}` : `${current} ${next}`;
}

export function selectRealtimeTranscript(state: RealtimeTranscriptState): string {
  let transcript = "";
  for (const itemId of state.order) {
    const item = state.items.get(itemId);
    if (!item) continue;
    transcript = appendTranscriptSegment(transcript, item.final ?? item.partial);
  }
  return transcript;
}

/**
 * The owned range includes boundary whitespace, so every interim update can
 * replace exactly the prior insertion without touching pre-existing prompt
 * text on either side of the caret.
 */
export function formatComposerDictationInsertion(
  originalPrompt: string,
  insertionOffset: number,
  transcript: string,
): string {
  if (transcript.length === 0) return "";
  const boundedOffset = Math.max(0, Math.min(originalPrompt.length, insertionOffset));
  const needsLeadingSpace =
    boundedOffset > 0 &&
    !/\s$/u.test(originalPrompt.slice(0, boundedOffset)) &&
    !/^\s/u.test(transcript);
  const needsTrailingSpace =
    boundedOffset < originalPrompt.length &&
    !/^\s/u.test(originalPrompt.slice(boundedOffset)) &&
    !/\s$/u.test(transcript);
  return `${needsLeadingSpace ? " " : ""}${transcript}${needsTrailingSpace ? " " : ""}`;
}

interface RealtimeTranscriptionDependencies {
  readonly createPeerConnection: () => RTCPeerConnection;
  readonly fetch: typeof globalThis.fetch;
  readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => number;
  readonly clearTimeout: (timerId: number) => void;
}

function browserDependencies(): RealtimeTranscriptionDependencies {
  return {
    createPeerConnection: () => new RTCPeerConnection(),
    fetch: window.fetch.bind(window),
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timerId) => window.clearTimeout(timerId),
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // A route-abort can reject a setup deferred before the async setup path has
  // reached its await. Attach a handler immediately to prevent a transient
  // unhandled-rejection report; callers still observe the original promise.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

async function withTimeout<T>(input: {
  readonly promise: Promise<T>;
  readonly timeoutMs: number;
  readonly dependencies: RealtimeTranscriptionDependencies;
  readonly onTimeout: () => void;
  readonly timeoutError: () => RealtimeTranscriptionError;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timerId = input.dependencies.setTimeout(() => {
      input.onTimeout();
      reject(input.timeoutError());
    }, input.timeoutMs);
    input.promise.then(
      (value) => {
        input.dependencies.clearTimeout(timerId);
        resolve(value);
      },
      (error: unknown) => {
        input.dependencies.clearTimeout(timerId);
        reject(error);
      },
    );
  });
}

function normalizeSetupError(
  error: unknown,
  externallyCancelled: boolean,
): RealtimeTranscriptionError {
  if (error instanceof RealtimeTranscriptionError) return error;
  if (externallyCancelled) return cancelledError();
  const name = isRecord(error) && typeof error.name === "string" ? error.name : null;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new RealtimeTranscriptionError(
      "microphone_denied",
      "Microphone access was denied. Allow microphone access to use dictation.",
    );
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return new RealtimeTranscriptionError(
      "microphone_unavailable",
      "No usable microphone is available.",
    );
  }
  return connectionError();
}

function parseValidContentLength(response: Response): number | null {
  const header = response.headers.get("content-length");
  if (header === null || !/^\d+$/u.test(header)) return null;
  const length = Number(header);
  return Number.isSafeInteger(length) ? length : null;
}

/**
 * Response.text() buffers without a caller-controlled ceiling. Read the SDP
 * stream ourselves so a malicious or broken upstream cannot allocate an
 * arbitrarily large renderer string before Cafe notices the protocol error.
 */
async function readBoundedSdpAnswer(response: Response): Promise<string> {
  const contentLength = parseValidContentLength(response);
  if (contentLength !== null && contentLength > MAX_SDP_ANSWER_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw protocolError();
  }
  if (!response.body) throw protocolError();

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteCount = 0;
  let answer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteCount += chunk.value.byteLength;
      if (byteCount > MAX_SDP_ANSWER_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw protocolError();
      }
      answer += decoder.decode(chunk.value, { stream: true });
    }
    answer += decoder.decode();
  } catch (error) {
    if (error instanceof RealtimeTranscriptionError) throw error;
    throw protocolError();
  } finally {
    reader.releaseLock();
  }

  if (answer.length === 0 || answer.length > MAX_SDP_ANSWER_BYTES) throw protocolError();
  return answer;
}

export interface RealtimeTranscriptionSession {
  /** Stop capture, commit the buffer, and await the authoritative transcript. */
  readonly stopAndFinalize: () => Promise<void>;
  /** Immediately release resources without committing or waiting for a final. */
  readonly cancel: () => void;
}

export interface StartRealtimeTranscriptionInput {
  readonly getClientSecret: () => Promise<DictationRealtimeClientSecret>;
  readonly onTranscript: (snapshot: {
    readonly transcript: string;
    readonly event: RealtimeTranscriptEvent;
  }) => boolean | void;
  readonly onFatalError?: (error: RealtimeTranscriptionError) => void;
  readonly signal?: AbortSignal;
}

/**
 * Connect one browser microphone to an OpenAI Realtime transcription session.
 * The permanent API key remains on Cafe's backend; this function receives only
 * a single-use, short-lived client secret and never stores it after setup.
 */
export async function startRealtimeTranscription(
  input: StartRealtimeTranscriptionInput,
  dependencies: RealtimeTranscriptionDependencies = browserDependencies(),
): Promise<RealtimeTranscriptionSession> {
  if (input.signal?.aborted) throw cancelledError();

  let lifecycle: "connecting" | "active" | "finalizing" | "closed" = "connecting";
  let mediaStream: MediaStream | null = null;
  let peerConnection: RTCPeerConnection | null = null;
  let dataChannel: RTCDataChannel | null = null;
  let transcriptState = createRealtimeTranscriptState();
  const completedItemIds = new Set<string>();
  const openDeferred = deferred<void>();
  let finalizationDeferred: Deferred<void> | null = null;
  let requiredCompletedItemCount = 0;
  let fatalErrorReported = false;
  let stopPromise: Promise<void> | null = null;
  const setupAbortController = new AbortController();
  const transportIsClosed = () => lifecycle === "closed";
  let awaitingClientSecret = true;

  const stopMediaTracks = () => {
    if (!mediaStream) return;
    for (const track of mediaStream.getTracks()) {
      track.enabled = false;
      track.stop();
    }
  };

  const removeTransportListeners = () => {
    dataChannel?.removeEventListener("open", handleDataChannelOpen);
    dataChannel?.removeEventListener("message", handleDataChannelMessage);
    dataChannel?.removeEventListener("close", handleDataChannelClose);
    dataChannel?.removeEventListener("error", handleDataChannelError);
    peerConnection?.removeEventListener("connectionstatechange", handleConnectionStateChange);
    input.signal?.removeEventListener("abort", handleExternalAbort);
  };

  const cleanup = () => {
    if (lifecycle === "closed") return;
    lifecycle = "closed";
    setupAbortController.abort();
    stopMediaTracks();
    removeTransportListeners();
    if (dataChannel && dataChannel.readyState !== "closed") dataChannel.close();
    peerConnection?.close();
    dataChannel = null;
    peerConnection = null;
    mediaStream = null;
  };

  const failTransport = (error: RealtimeTranscriptionError) => {
    const shouldReport = lifecycle === "active" || lifecycle === "finalizing";
    openDeferred.reject(error);
    finalizationDeferred?.reject(error);
    cleanup();
    if (shouldReport && !fatalErrorReported) {
      fatalErrorReported = true;
      input.onFatalError?.(error);
    }
  };

  function handleExternalAbort(): void {
    const error = cancelledError();
    openDeferred.reject(error);
    finalizationDeferred?.reject(error);
    cleanup();
  }

  function handleDataChannelOpen(): void {
    openDeferred.resolve(undefined);
  }

  function handleDataChannelMessage(event: MessageEvent<unknown>): void {
    try {
      const decoded = decodeRealtimeServerEvent(event.data);
      if (decoded === null) return;

      if (decoded.type === "error") {
        // Committing an entirely silent buffer is a valid user action. OpenAI
        // reports it as an error because no item exists, but Cafe treats it as
        // a successful empty dictation and still performs normal cleanup.
        if (lifecycle === "finalizing" && decoded.code === "input_audio_buffer_commit_empty") {
          finalizationDeferred?.resolve(undefined);
          return;
        }
        failTransport(connectionError());
        return;
      }

      transcriptState = reduceRealtimeTranscript(transcriptState, decoded);
      const accepted = input.onTranscript({
        transcript: selectRealtimeTranscript(transcriptState),
        event: decoded,
      });
      if (accepted === false) {
        failTransport(
          new RealtimeTranscriptionError(
            "transcript_conflict",
            "Dictation stopped because the composer changed unexpectedly.",
          ),
        );
        return;
      }

      if (decoded.type === "conversation.item.input_audio_transcription.completed") {
        completedItemIds.add(decoded.itemId);
        if (lifecycle === "finalizing" && completedItemIds.size >= requiredCompletedItemCount) {
          finalizationDeferred?.resolve(undefined);
        }
      }
    } catch {
      failTransport(protocolError());
    }
  }

  function handleDataChannelClose(): void {
    if (lifecycle !== "closed") failTransport(connectionError());
  }

  function handleDataChannelError(): void {
    if (lifecycle !== "closed") failTransport(connectionError());
  }

  function handleConnectionStateChange(): void {
    if (peerConnection?.connectionState === "failed") failTransport(connectionError());
  }

  try {
    // Resolve a usable ephemeral credential before prompting for microphone
    // access. Status can race with a Settings clear, and a missing key must be
    // a true no-op that never opens a browser permission prompt.
    const clientSecret = await input.getClientSecret();
    awaitingClientSecret = false;
    if (input.signal?.aborted || transportIsClosed()) throw cancelledError();
    if (clientSecret.expiresAt * 1_000 <= dependencies.now() + MIN_CLIENT_SECRET_LIFETIME_MS) {
      throw new RealtimeTranscriptionError(
        "session_expired",
        "The dictation session expired before it could start. Please try again.",
      );
    }

    mediaStream = await dependencies.getUserMedia({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
    if (input.signal?.aborted) throw cancelledError();

    // Register abort immediately after capture so a route change stops the
    // microphone while the SDP exchange or peer negotiation is in flight.
    input.signal?.addEventListener("abort", handleExternalAbort, { once: true });

    const audioTrack = mediaStream.getAudioTracks()[0];
    if (!audioTrack) {
      throw new RealtimeTranscriptionError(
        "microphone_unavailable",
        "No usable microphone is available.",
      );
    }

    // Permission prompts can remain open past the short-lived credential's
    // TTL. Recheck after the user responds and before any OpenAI connection.
    if (input.signal?.aborted || transportIsClosed()) throw cancelledError();
    if (clientSecret.expiresAt * 1_000 <= dependencies.now() + MIN_CLIENT_SECRET_LIFETIME_MS) {
      throw new RealtimeTranscriptionError(
        "session_expired",
        "The dictation session expired before it could start. Please try again.",
      );
    }

    peerConnection = dependencies.createPeerConnection();
    dataChannel = peerConnection.createDataChannel("oai-events");
    dataChannel.addEventListener("open", handleDataChannelOpen);
    dataChannel.addEventListener("message", handleDataChannelMessage);
    dataChannel.addEventListener("close", handleDataChannelClose);
    dataChannel.addEventListener("error", handleDataChannelError);
    peerConnection.addEventListener("connectionstatechange", handleConnectionStateChange);
    peerConnection.addTrack(audioTrack, mediaStream);

    const offer = await peerConnection.createOffer();
    const offerSdp = offer.sdp;
    if (!offerSdp) throw protocolError();
    await peerConnection.setLocalDescription(offer);

    const exchangePromise = (async () => {
      const response = await dependencies.fetch(OPENAI_REALTIME_CALLS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientSecret.clientSecret}`,
          "Content-Type": "application/sdp",
        },
        body: offerSdp,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: setupAbortController.signal,
      });
      if (!response.ok) throw realtimeCallResponseError(response.status);
      const answerSdp = await readBoundedSdpAnswer(response);
      await peerConnection?.setRemoteDescription({ type: "answer", sdp: answerSdp });
    })();

    await withTimeout({
      promise: exchangePromise,
      timeoutMs: REALTIME_SETUP_TIMEOUT_MS,
      dependencies,
      onTimeout: () => setupAbortController.abort(),
      timeoutError: connectionError,
    });
    if (input.signal?.aborted || transportIsClosed()) throw cancelledError();

    await withTimeout({
      promise: dataChannel.readyState === "open" ? Promise.resolve() : openDeferred.promise,
      timeoutMs: REALTIME_SETUP_TIMEOUT_MS,
      dependencies,
      onTimeout: () => setupAbortController.abort(),
      timeoutError: connectionError,
    });
    if (input.signal?.aborted || transportIsClosed()) throw cancelledError();
    lifecycle = "active";

    const stopAndFinalize = (): Promise<void> => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        if (lifecycle !== "active" || !dataChannel || dataChannel.readyState !== "open") {
          cleanup();
          throw connectionError();
        }

        lifecycle = "finalizing";
        stopMediaTracks();
        finalizationDeferred = deferred<void>();
        requiredCompletedItemCount = completedItemIds.size + 1;

        try {
          dataChannel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          await withTimeout({
            promise: finalizationDeferred.promise,
            timeoutMs: REALTIME_FINALIZATION_TIMEOUT_MS,
            dependencies,
            onTimeout: () => undefined,
            timeoutError: () =>
              new RealtimeTranscriptionError(
                "finalization_timeout",
                "Dictation stopped before OpenAI returned the final transcript.",
              ),
          });
        } finally {
          cleanup();
        }
      })();
      return stopPromise;
    };

    return {
      stopAndFinalize,
      cancel: cleanup,
    };
  } catch (error) {
    const normalized = awaitingClientSecret
      ? normalizeClientSecretError(error, input.signal?.aborted === true)
      : normalizeSetupError(error, input.signal?.aborted === true);
    cleanup();
    throw normalized;
  }
}
