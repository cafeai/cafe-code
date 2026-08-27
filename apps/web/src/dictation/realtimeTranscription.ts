import {
  DICTATION_FALLBACK_TRANSCRIPTION_MODEL,
  DICTATION_PROVIDER_ERROR_CODES,
  DICTATION_PROVIDER_ERROR_TYPES,
  DICTATION_TRANSCRIPTION_MODEL,
  type DictationErrorCode,
  type DictationRealtimeClientSecret,
  type DictationTranscriptionModel,
} from "@cafecode/contracts";

import {
  beginDictationDiagnosticOperation,
  readSafeOpenAiResponseHeaders,
  type DictationDiagnosticOutcome,
  type DictationDiagnosticStage,
  type DictationDiagnosticUpdate,
} from "./diagnostics";
import { DICTATION_RPC_ERROR_MESSAGES, readDictationRpcErrorCode } from "./errors";

export const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

// Realtime SDP exchanges should normally finish within a few seconds. A
// bounded setup prevents a dead upstream connection from retaining an active
// microphone indefinitely after the user has granted access.
const REALTIME_SETUP_TIMEOUT_MS = 20_000;

// Match the OpenAI SDKs' conservative transient-failure policy: one initial
// attempt plus two retries. Keep the delays short because the ephemeral token,
// microphone, and one overall 20-second setup deadline remain live throughout.
const REALTIME_CALL_MAX_ATTEMPTS = 3;
const REALTIME_CALL_RETRY_DELAYS_MS = [250, 750] as const;

// The final completion event can trail input_audio_buffer.commit. Ten seconds
// is deliberately generous for a short composer utterance while still giving
// Stop deterministic cleanup semantics when the upstream session disappears.
const REALTIME_FINALIZATION_TIMEOUT_MS = 10_000;
const MIN_CLIENT_SECRET_LIFETIME_MS = 5_000;
const MAX_SDP_ANSWER_BYTES = 1_048_576;
const MAX_REALTIME_ERROR_BODY_BYTES = 64 * 1_024;
const MAX_EVENT_CHARS = 256_000;
const MAX_ITEM_ID_CHARS = 256;
const MAX_TRANSCRIPT_CHARS = 128_000;
const providerErrorTypes: ReadonlySet<string> = new Set(DICTATION_PROVIDER_ERROR_TYPES);
const providerErrorCodes: ReadonlySet<string> = new Set(DICTATION_PROVIDER_ERROR_CODES);
const textEncoder = new TextEncoder();

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
function realtimeCallResponseError(
  status: number,
  attemptedModel: DictationTranscriptionModel,
): RealtimeTranscriptionError {
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
    if (attemptedModel === DICTATION_FALLBACK_TRANSCRIPTION_MODEL) {
      return new RealtimeTranscriptionError(
        "upstream_unavailable",
        `OpenAI could not allocate either supported Realtime dictation model (HTTP ${status}). The microphone is available; verify this key belongs to a paid API project with Realtime access, or retry shortly.`,
      );
    }
    return new RealtimeTranscriptionError(
      "upstream_unavailable",
      `OpenAI returned a temporary HTTP ${status} error while starting dictation. Cafe retried the request; try again shortly.`,
    );
  }
  if (status === 408 || status === 409) {
    return new RealtimeTranscriptionError(
      "upstream_unavailable",
      `OpenAI returned a temporary HTTP ${status} error while starting dictation. Cafe retried the request; try again shortly.`,
    );
  }
  return connectionError();
}

function isRetryableRealtimeCallStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);
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
  readonly waitForRetry: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly setTimeout: (callback: () => void, delayMs: number) => number;
  readonly clearTimeout: (timerId: number) => void;
}

function waitForBrowserRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("Dictation setup was aborted."));
  return new Promise<void>((resolve, reject) => {
    let timerId: number | null = null;
    const handleAbort = () => {
      if (timerId !== null) window.clearTimeout(timerId);
      reject(new Error("Dictation setup was aborted."));
    };
    timerId = window.setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function browserDependencies(): RealtimeTranscriptionDependencies {
  return {
    createPeerConnection: () => new RTCPeerConnection(),
    fetch: window.fetch.bind(window),
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    now: () => Date.now(),
    waitForRetry: waitForBrowserRetry,
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timerId) => window.clearTimeout(timerId),
  };
}

/**
 * Wait until the browser has folded every gathered ICE candidate into
 * `localDescription`. `createOffer()` returns only the initial SDP template;
 * posting that stale value can omit all candidates and make OpenAI fail the
 * call allocation with an otherwise opaque HTTP 500. Cafe does not retain or
 * diagnose the finalized SDP because it can contain private network details.
 *
 * The operation is bounded by the session's existing setup abort/timeout.
 * Removing both listeners on every exit is important because a closed peer may
 * never emit another gathering event.
 */
function waitForIceGatheringComplete(
  connection: RTCPeerConnection,
  signal: AbortSignal,
): Promise<void> {
  if (connection.iceGatheringState === "complete") return Promise.resolve();

  return new Promise<void>((resolve) => {
    const cleanup = () => {
      connection.removeEventListener("icegatheringstatechange", handleStateChange);
      signal.removeEventListener("abort", handleAbort);
    };
    const handleStateChange = () => {
      if (connection.iceGatheringState !== "complete") return;
      cleanup();
      resolve();
    };
    const handleAbort = () => {
      cleanup();
      // `interruptSetup` records the precise cancellation or timeout error
      // before it aborts this signal. Resolve here so awaitSetup's mandatory
      // liveness fence rethrows that authoritative error instead of racing it
      // with a generic transport failure.
      resolve();
    };

    connection.addEventListener("icegatheringstatechange", handleStateChange);
    signal.addEventListener("abort", handleAbort, { once: true });

    // Close the race in which gathering completed between the initial state
    // read and listener registration.
    handleStateChange();
    if (signal.aborted) handleAbort();
  });
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

interface RealtimeErrorResponseMetadata {
  readonly providerErrorType: string | null;
  readonly providerErrorCode: string | null;
  readonly responseBodyBytes: number | null;
  readonly responseBodySha256: string | null;
  readonly responseBodyTruncated: boolean | null;
}

/** Collapse provider-controlled identifiers before they leave the body reader. */
function categorizeProviderError(value: unknown, allowlist: ReadonlySet<string>): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && allowlist.has(value) ? value : "other";
}

async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  if (bytes.byteLength === 0 || globalThis.crypto?.subtle === undefined) return null;
  try {
    // Copy the bounded prefix into a plain ArrayBuffer so TypeScript and the
    // WebCrypto implementation cannot retain a view into a larger body chunk.
    const digestInput = bytes.slice().buffer;
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", digestInput));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/**
 * Read only a bounded error-body prefix and immediately reduce it to safe
 * structural metadata. Provider messages are never extracted; the temporary
 * bytes/string/JSON object remain local to this call and are discarded before
 * anything reaches Cafe's diagnostics snapshot.
 */
async function readBoundedRealtimeErrorMetadata(
  response: Response,
  signal: AbortSignal,
): Promise<RealtimeErrorResponseMetadata> {
  if (!response.body) {
    return {
      providerErrorType: null,
      providerErrorCode: null,
      responseBodyBytes: 0,
      responseBodySha256: null,
      responseBodyTruncated: false,
    };
  }

  const declaredLength = parseValidContentLength(response);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  let streamFinished = false;
  let truncated = declaredLength !== null && declaredLength > MAX_REALTIME_ERROR_BODY_BYTES;
  const handleAbort = () => {
    // Response-body reads are independent from the fetch signal once headers
    // have arrived. Explicitly cancel the reader so an upstream that stalls
    // mid-error cannot retain a background stream after Cafe times out.
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", handleAbort, { once: true });

  try {
    if (signal.aborted) {
      handleAbort();
      return {
        providerErrorType: null,
        providerErrorCode: null,
        responseBodyBytes: null,
        responseBodySha256: null,
        responseBodyTruncated: null,
      };
    }
    while (byteCount < MAX_REALTIME_ERROR_BODY_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) {
        streamFinished = true;
        break;
      }
      const remaining = MAX_REALTIME_ERROR_BODY_BYTES - byteCount;
      if (chunk.value.byteLength > remaining) {
        chunks.push(chunk.value.slice(0, remaining));
        byteCount += remaining;
        truncated = true;
        break;
      }
      const copiedChunk = chunk.value.slice();
      chunks.push(copiedChunk);
      byteCount += copiedChunk.byteLength;
    }

    // Do not perform a look-ahead read at the byte ceiling. A single stream
    // chunk has no browser-enforced upper bound, and a server can also leave a
    // look-ahead pending indefinitely. When EOF was not observed within the
    // ceiling, conservatively mark the prefix truncated and cancel the body.
    if (!streamFinished && byteCount === MAX_REALTIME_ERROR_BODY_BYTES) truncated = true;
    if (truncated || !streamFinished) await reader.cancel().catch(() => undefined);

    const bytes = new Uint8Array(byteCount);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const responseBodySha256 = await sha256Hex(bytes);
    let providerErrorType: string | null = null;
    let providerErrorCode: string | null = null;
    if (!truncated && bytes.byteLength > 0) {
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const parsed: unknown = JSON.parse(decoded);
        if (isRecord(parsed) && isRecord(parsed.error)) {
          providerErrorType = categorizeProviderError(parsed.error.type, providerErrorTypes);
          providerErrorCode = categorizeProviderError(parsed.error.code, providerErrorCodes);
        }
      } catch {
        // Non-JSON or invalid UTF-8 provider messages remain fingerprint-only.
      }
    }

    return {
      providerErrorType,
      providerErrorCode,
      responseBodyBytes: byteCount,
      responseBodySha256,
      responseBodyTruncated: truncated,
    };
  } catch {
    await reader.cancel().catch(() => undefined);
    return {
      providerErrorType: null,
      providerErrorCode: null,
      responseBodyBytes: null,
      responseBodySha256: null,
      responseBodyTruncated: null,
    };
  } finally {
    signal.removeEventListener("abort", handleAbort);
    reader.releaseLock();
  }
}

interface SdpShapeDiagnostics {
  readonly bytes: number;
  readonly lineCount: number;
  readonly mediaSectionCount: number;
  readonly audioSectionCount: number;
  readonly applicationSectionCount: number;
  readonly candidateCount: number;
  readonly hasOpus: boolean;
  readonly hasIceCandidate: boolean;
}

/** Derive protocol-shape facts without retaining or hashing SDP contents. */
function summarizeSdpShape(sdp: string): SdpShapeDiagnostics {
  const lines = sdp.split(/\r\n|\r|\n/u);
  if (lines.at(-1) === "") lines.pop();
  let mediaSectionCount = 0;
  let audioSectionCount = 0;
  let applicationSectionCount = 0;
  let candidateCount = 0;
  let hasOpus = false;

  for (const line of lines) {
    if (line.startsWith("m=")) mediaSectionCount += 1;
    if (line.startsWith("m=audio ")) audioSectionCount += 1;
    if (line.startsWith("m=application ")) applicationSectionCount += 1;
    if (line.startsWith("a=candidate:")) candidateCount += 1;
    if (/^a=rtpmap:\d+\s+opus\/\d+/iu.test(line)) hasOpus = true;
  }

  return {
    bytes: textEncoder.encode(sdp).byteLength,
    lineCount: lines.length,
    mediaSectionCount,
    audioSectionCount,
    applicationSectionCount,
    candidateCount,
    hasOpus,
    hasIceCandidate: candidateCount > 0,
  };
}

function readAudioDiagnostics(
  stream: MediaStream,
  track: MediaStreamTrack,
): Partial<DictationDiagnosticUpdate> {
  let settings: Record<string, unknown> = {};
  try {
    if (typeof track.getSettings === "function") {
      settings = track.getSettings() as Record<string, unknown>;
    }
  } catch {
    // A browser may revoke the device between capture and inspection. Track
    // lifecycle state below remains useful even when settings become unreadable.
  }
  return {
    audioTrackCount: stream.getAudioTracks().length,
    audioTrackState: track.readyState,
    audioTrackEnabled: track.enabled,
    audioTrackMuted: track.muted,
    audioSampleRate: typeof settings.sampleRate === "number" ? settings.sampleRate : null,
    audioChannelCount: typeof settings.channelCount === "number" ? settings.channelCount : null,
    audioSampleSize: typeof settings.sampleSize === "number" ? settings.sampleSize : null,
    audioEchoCancellation:
      typeof settings.echoCancellation === "boolean" ? settings.echoCancellation : null,
    audioNoiseSuppression:
      typeof settings.noiseSuppression === "boolean" ? settings.noiseSuppression : null,
    audioAutoGainControl:
      typeof settings.autoGainControl === "boolean" ? settings.autoGainControl : null,
  };
}

/**
 * Response.text() buffers without a caller-controlled ceiling. Read the SDP
 * stream ourselves so a malicious or broken upstream cannot allocate an
 * arbitrarily large renderer string before Cafe notices the protocol error.
 */
async function readBoundedSdpAnswer(response: Response, signal: AbortSignal): Promise<string> {
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
  const handleAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", handleAbort, { once: true });
  try {
    if (signal.aborted) {
      handleAbort();
      throw connectionError();
    }
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
    signal.removeEventListener("abort", handleAbort);
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
  readonly getClientSecret: (
    model: DictationTranscriptionModel,
  ) => Promise<DictationRealtimeClientSecret>;
  readonly onTranscript: (snapshot: {
    readonly transcript: string;
    readonly event: RealtimeTranscriptEvent;
  }) => boolean | void;
  readonly onFatalError?: (error: RealtimeTranscriptionError) => void;
  readonly signal?: AbortSignal;
}

function stopStreamTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.enabled = false;
    track.stop();
  }
}

/**
 * Connect one browser microphone to an OpenAI Realtime transcription session.
 * The permanent API key remains on Cafe's backend; this function receives only
 * short-lived client secrets and never stores them after setup. Each retry is
 * deliberately a new OpenAI call creation: it mints another credential and
 * builds another peer connection and SDP offer. OpenAI does not document call
 * creation as idempotent, so replaying one token/offer can repeatedly hit the
 * same failed allocation rather than forming an independent attempt.
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
  let openDeferred = deferred<void>();
  let finalizationDeferred: Deferred<void> | null = null;
  let requiredCompletedItemCount = 0;
  let fatalErrorReported = false;
  let stopPromise: Promise<void> | null = null;
  const setupAbortController = new AbortController();
  const setupInterrupted = deferred<never>();
  let setupInterruptionError: RealtimeTranscriptionError | null = null;
  let diagnosticsTerminal = false;
  const transportIsClosed = () => lifecycle === "closed";
  let diagnosticStage: DictationDiagnosticStage = "client_secret";
  let diagnosticAttempt: number | null = null;
  let diagnosticHttpStatus: number | null = null;
  let diagnosticRequestId: string | null = null;
  let diagnosticDetails: Omit<
    Partial<DictationDiagnosticUpdate>,
    | "nowMs"
    | "stage"
    | "outcome"
    | "attempt"
    | "maxAttempts"
    | "httpStatus"
    | "requestId"
    | "errorCode"
  > = {};
  const recordOperationDiagnostic = beginDictationDiagnosticOperation();

  const readCurrentTransportDiagnostics = (): Partial<DictationDiagnosticUpdate> => {
    const audioTrack = mediaStream?.getAudioTracks()[0] ?? null;
    return {
      peerConnectionState: peerConnection?.connectionState ?? null,
      iceConnectionState: peerConnection?.iceConnectionState ?? null,
      iceGatheringState: peerConnection?.iceGatheringState ?? null,
      signalingState: peerConnection?.signalingState ?? null,
      dataChannelState: dataChannel?.readyState ?? null,
      ...(mediaStream !== null && audioTrack !== null
        ? readAudioDiagnostics(mediaStream, audioTrack)
        : {
            audioTrackCount: null,
            audioTrackState: null,
            audioTrackEnabled: null,
            audioTrackMuted: null,
            audioSampleRate: null,
            audioChannelCount: null,
            audioSampleSize: null,
            audioEchoCancellation: null,
            audioNoiseSuppression: null,
            audioAutoGainControl: null,
          }),
    };
  };

  const recordDiagnostic = (
    outcome: DictationDiagnosticOutcome,
    errorCode: RealtimeTranscriptionErrorCode | null = null,
  ) => {
    // A timed-out or cancelled setup can still have an uncancellable browser
    // promise settle later. Never let that stale continuation replace the
    // terminal snapshot which explains why the visible operation ended.
    if (diagnosticsTerminal) return;
    recordOperationDiagnostic({
      ...diagnosticDetails,
      ...readCurrentTransportDiagnostics(),
      nowMs: dependencies.now(),
      stage: diagnosticStage,
      outcome,
      attempt: diagnosticAttempt,
      maxAttempts: diagnosticAttempt === null ? null : REALTIME_CALL_MAX_ATTEMPTS,
      httpStatus: diagnosticHttpStatus,
      requestId: diagnosticRequestId,
      errorCode,
    });
  };

  const recordTerminalDiagnostic = (
    outcome: Extract<DictationDiagnosticOutcome, "cancelled" | "completed" | "failed">,
    errorCode: RealtimeTranscriptionErrorCode | null = null,
  ) => {
    if (diagnosticsTerminal) return;
    recordDiagnostic(outcome, errorCode);
    diagnosticsTerminal = true;
  };

  const assertSetupLive = () => {
    if (setupInterruptionError !== null) throw setupInterruptionError;
    if (input.signal?.aborted) throw cancelledError();
    if (transportIsClosed()) throw connectionError();
  };

  /**
   * Browser media/WebRTC methods are not uniformly abortable. Racing every
   * setup await against one private cancellation promise makes Cafe settle
   * immediately, while post-await liveness checks keep late results from
   * mutating diagnostics or attaching resources to a closed session.
   */
  const awaitSetup = async <T>(promise: Promise<T>): Promise<T> => {
    const value = await Promise.race([promise, setupInterrupted.promise]);
    assertSetupLive();
    return value;
  };

  const interruptSetup = (error: RealtimeTranscriptionError) => {
    if (setupInterruptionError !== null) return;
    setupInterruptionError = error;
    setupAbortController.abort();
    openDeferred.reject(error);
    setupInterrupted.reject(error);
  };

  const resetPerAttemptDiagnostics = () => {
    diagnosticDetails = {
      ...diagnosticDetails,
      requestDurationMs: null,
      openAiProcessingMs: null,
      retryAfterMs: null,
      responseContentTypeCategory: null,
      responseContentLengthBytes: null,
      providerErrorType: null,
      providerErrorCode: null,
      responseBodyBytes: null,
      responseBodySha256: null,
      responseBodyTruncated: null,
      offerSdpBytes: null,
      offerSdpLineCount: null,
      offerMediaSectionCount: null,
      offerAudioSectionCount: null,
      offerApplicationSectionCount: null,
      offerCandidateCount: null,
      offerHasOpus: null,
      offerHasIceCandidate: null,
      answerSdpBytes: null,
      answerSdpLineCount: null,
      answerMediaSectionCount: null,
      answerAudioSectionCount: null,
      answerApplicationSectionCount: null,
      answerCandidateCount: null,
      answerHasOpus: null,
      answerHasIceCandidate: null,
    };
  };

  const stopMediaTracks = () => {
    if (!mediaStream) return;
    stopStreamTracks(mediaStream);
  };

  const removeTransportListeners = (
    connection: RTCPeerConnection | null,
    channel: RTCDataChannel | null,
  ) => {
    channel?.removeEventListener("open", handleDataChannelOpen);
    channel?.removeEventListener("message", handleDataChannelMessage);
    channel?.removeEventListener("close", handleDataChannelClose);
    channel?.removeEventListener("error", handleDataChannelError);
    connection?.removeEventListener("connectionstatechange", handleConnectionStateChange);
    connection?.removeEventListener("iceconnectionstatechange", handleIceConnectionStateChange);
    connection?.removeEventListener("icegatheringstatechange", handlePeerStateObservation);
    connection?.removeEventListener("signalingstatechange", handlePeerStateObservation);
  };

  /**
   * Retire only the current WebRTC attempt while keeping the one captured
   * microphone stream alive for the next attempt. Listeners are detached
   * before close so the expected retirement cannot be misclassified as an
   * active-session transport failure.
   */
  const discardCurrentTransportAttempt = () => {
    const discardedConnection = peerConnection;
    const discardedChannel = dataChannel;
    removeTransportListeners(discardedConnection, discardedChannel);
    if (discardedChannel && discardedChannel.readyState !== "closed") {
      discardedChannel.close();
    }
    discardedConnection?.close();
    if (dataChannel === discardedChannel) dataChannel = null;
    if (peerConnection === discardedConnection) peerConnection = null;
  };

  const cleanup = () => {
    if (lifecycle === "closed") return;
    lifecycle = "closed";
    setupAbortController.abort();
    stopMediaTracks();
    input.signal?.removeEventListener("abort", handleExternalAbort);
    discardCurrentTransportAttempt();
    mediaStream = null;
  };

  const failTransport = (error: RealtimeTranscriptionError) => {
    const shouldReport = lifecycle === "active" || lifecycle === "finalizing";
    if (lifecycle === "connecting") interruptSetup(error);
    recordTerminalDiagnostic("failed", error.code);
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
    interruptSetup(error);
    recordTerminalDiagnostic("cancelled", error.code);
    openDeferred.reject(error);
    finalizationDeferred?.reject(error);
    cleanup();
  }

  function handleDataChannelOpen(): void {
    recordDiagnostic("starting");
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
    recordDiagnostic("starting");
    if (peerConnection?.connectionState === "failed") failTransport(connectionError());
  }

  function handleIceConnectionStateChange(): void {
    recordDiagnostic("starting");
    if (peerConnection?.iceConnectionState === "failed") failTransport(connectionError());
  }

  function handlePeerStateObservation(): void {
    recordDiagnostic("starting");
  }

  const mintUsableClientSecret = async (
    attempt: number | null,
    requestedModel: DictationTranscriptionModel,
  ): Promise<DictationRealtimeClientSecret> => {
    resetPerAttemptDiagnostics();
    diagnosticDetails = {
      ...diagnosticDetails,
      sessionProfile: null,
      clientSecretModel: null,
      clientSecretLifetimeMs: null,
      clientSecretRequestId: null,
      clientSecretRequestDurationMs: null,
      clientSecretOpenAiProcessingMs: null,
      clientSecretEffectiveProfile: null,
    };
    diagnosticStage = "client_secret";
    diagnosticAttempt = attempt;
    diagnosticHttpStatus = null;
    diagnosticRequestId = null;
    recordDiagnostic("starting");
    let clientSecret: DictationRealtimeClientSecret;
    try {
      clientSecret = await awaitSetup(input.getClientSecret(requestedModel));
    } catch (error) {
      // Setup cancellation/timeout is already a sanitized local error. Only
      // errors originating at the RPC boundary are decoded as credential
      // failures, so a retry timeout cannot be mislabeled session_setup_failed.
      if (error instanceof RealtimeTranscriptionError) throw error;
      throw normalizeClientSecretError(error, input.signal?.aborted === true);
    }
    if (clientSecret.expiresAt * 1_000 <= dependencies.now() + MIN_CLIENT_SECRET_LIFETIME_MS) {
      throw new RealtimeTranscriptionError(
        "session_expired",
        "The dictation session expired before it could start. Please try again.",
      );
    }
    diagnosticDetails = {
      ...diagnosticDetails,
      sessionProfile: clientSecret.sessionProfile ?? null,
      clientSecretModel: clientSecret.model,
      clientSecretLifetimeMs: Math.max(0, clientSecret.expiresAt * 1_000 - dependencies.now()),
      clientSecretRequestId: clientSecret.clientSecretRequestId ?? null,
      clientSecretRequestDurationMs: clientSecret.clientSecretRequestDurationMs ?? null,
      clientSecretOpenAiProcessingMs: clientSecret.clientSecretOpenAiProcessingMs ?? null,
      clientSecretEffectiveProfile: clientSecret.clientSecretEffectiveProfile ?? null,
    };
    recordDiagnostic("completed");
    return clientSecret;
  };

  try {
    // Listen before the first RPC so route changes and explicit cancellation
    // settle immediately even if the client-secret request itself is stuck.
    input.signal?.addEventListener("abort", handleExternalAbort, { once: true });
    if (input.signal?.aborted) handleExternalAbort();
    assertSetupLive();

    // Resolve a usable ephemeral credential before prompting for microphone
    // access. Status can race with a Settings clear, and a missing key must be
    // a true no-op that never opens a browser permission prompt.
    let nextAttemptModel: DictationTranscriptionModel = DICTATION_TRANSCRIPTION_MODEL;
    let clientSecret = await mintUsableClientSecret(null, nextAttemptModel);
    assertSetupLive();

    diagnosticStage = "microphone";
    diagnosticAttempt = null;
    diagnosticHttpStatus = null;
    diagnosticRequestId = null;
    recordDiagnostic("starting");
    const mediaPromise = dependencies.getUserMedia({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
    // If cancellation wins the race, getUserMedia can still resolve later.
    // Stop that late stream immediately so no browser track survives a closed
    // Cafe session merely because the permission prompt was uncancellable.
    void mediaPromise.then(
      (lateStream) => {
        if (setupInterruptionError !== null || transportIsClosed()) {
          stopStreamTracks(lateStream);
        }
      },
      () => undefined,
    );
    // Acquire and transfer ownership in this one async continuation. Calling
    // the generic async awaitSetup helper here would introduce another
    // microtask between its liveness check and this assignment: an abort in
    // that gap could close the session before Cafe owned (and could stop) the
    // newly resolved microphone stream.
    const capturedStream = await Promise.race([mediaPromise, setupInterrupted.promise]);
    if (setupInterruptionError !== null || input.signal?.aborted === true || transportIsClosed()) {
      stopStreamTracks(capturedStream);
      assertSetupLive();
    }
    mediaStream = capturedStream;

    const audioTrack = mediaStream.getAudioTracks()[0];
    if (!audioTrack) {
      throw new RealtimeTranscriptionError(
        "microphone_unavailable",
        "No usable microphone is available.",
      );
    }

    assertSetupLive();
    recordDiagnostic("completed");

    const exchangePromise = (async () => {
      for (let attempt = 1; attempt <= REALTIME_CALL_MAX_ATTEMPTS; attempt += 1) {
        assertSetupLive();

        // A browser permission prompt can outlive the first credential. It is
        // safe to mint a replacement now because the initial preflight already
        // proved that dictation is configured before Cafe touched the mic.
        // Every later attempt always mints a fresh credential: OpenAI does not
        // document replaying call creation with one ephemeral token as an
        // idempotent operation.
        if (
          attempt > 1 ||
          clientSecret.expiresAt * 1_000 <= dependencies.now() + MIN_CLIENT_SECRET_LIFETIME_MS
        ) {
          clientSecret = await mintUsableClientSecret(attempt, nextAttemptModel);
          // mintUsableClientSecret has its own async return continuation. An
          // abort can land after its internal liveness check but before this
          // caller resumes, so fence again before allocating a retry peer.
          assertSetupLive();
        }
        if (clientSecret.expiresAt * 1_000 <= dependencies.now() + MIN_CLIENT_SECRET_LIFETIME_MS) {
          throw new RealtimeTranscriptionError(
            "session_expired",
            "The dictation session expired before it could start. Please try again.",
          );
        }

        resetPerAttemptDiagnostics();
        diagnosticDetails = {
          ...diagnosticDetails,
          clientSecretLifetimeMs: Math.max(0, clientSecret.expiresAt * 1_000 - dependencies.now()),
        };
        diagnosticStage = "sdp_exchange";
        diagnosticAttempt = attempt;
        diagnosticHttpStatus = null;
        diagnosticRequestId = null;
        recordDiagnostic("starting");

        // A retry owns a wholly independent WebRTC transport and SDP offer.
        // The microphone stream remains single-owner and is attached to each
        // short-lived peer in turn, avoiding a second permission prompt.
        discardCurrentTransportAttempt();
        openDeferred = deferred<void>();
        const attemptConnection = dependencies.createPeerConnection();
        // Take ownership before createDataChannel: some WebRTC shims can throw
        // there, and cleanup must still close the newly allocated peer.
        peerConnection = attemptConnection;
        const attemptChannel = attemptConnection.createDataChannel("oai-events");
        dataChannel = attemptChannel;
        attemptChannel.addEventListener("open", handleDataChannelOpen);
        attemptChannel.addEventListener("message", handleDataChannelMessage);
        attemptChannel.addEventListener("close", handleDataChannelClose);
        attemptChannel.addEventListener("error", handleDataChannelError);
        attemptConnection.addEventListener("connectionstatechange", handleConnectionStateChange);
        attemptConnection.addEventListener(
          "iceconnectionstatechange",
          handleIceConnectionStateChange,
        );
        attemptConnection.addEventListener("icegatheringstatechange", handlePeerStateObservation);
        attemptConnection.addEventListener("signalingstatechange", handlePeerStateObservation);
        attemptConnection.addTrack(audioTrack, mediaStream);

        const offer = await awaitSetup(attemptConnection.createOffer());
        assertSetupLive();
        if (!offer.sdp) throw protocolError();
        await awaitSetup(attemptConnection.setLocalDescription(offer));
        assertSetupLive();
        await awaitSetup(
          waitForIceGatheringComplete(attemptConnection, setupAbortController.signal),
        );
        assertSetupLive();

        // Only the post-gather local description is authoritative. Never fall
        // back to `offer.sdp`: doing so silently reintroduces the candidate-free
        // request that this wait is designed to prevent.
        const finalizedOffer = attemptConnection.localDescription;
        const offerSdp = finalizedOffer?.type === "offer" ? finalizedOffer.sdp : undefined;
        if (!offerSdp) throw protocolError();
        const offerShape = summarizeSdpShape(offerSdp);
        diagnosticDetails = {
          ...diagnosticDetails,
          offerSdpBytes: offerShape.bytes,
          offerSdpLineCount: offerShape.lineCount,
          offerMediaSectionCount: offerShape.mediaSectionCount,
          offerAudioSectionCount: offerShape.audioSectionCount,
          offerApplicationSectionCount: offerShape.applicationSectionCount,
          offerCandidateCount: offerShape.candidateCount,
          offerHasOpus: offerShape.hasOpus,
          offerHasIceCandidate: offerShape.hasIceCandidate,
        };
        recordDiagnostic("starting");

        let response: Response;
        const requestStartedAtMs = dependencies.now();
        try {
          // Re-check immediately before the irreversible network side effect;
          // an abort can land between any async helper's return and its caller.
          assertSetupLive();
          response = await awaitSetup(
            dependencies.fetch(OPENAI_REALTIME_CALLS_URL, {
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
            }),
          );
          assertSetupLive();
        } catch (error) {
          diagnosticDetails = {
            ...diagnosticDetails,
            requestDurationMs: Math.max(0, dependencies.now() - requestStartedAtMs),
          };
          if (error instanceof RealtimeTranscriptionError) throw error;
          if (input.signal?.aborted) throw cancelledError();
          if (setupAbortController.signal.aborted || transportIsClosed()) throw connectionError();
          if (attempt === REALTIME_CALL_MAX_ATTEMPTS) throw connectionError();
          recordDiagnostic("retrying", "connection_failed");
          discardCurrentTransportAttempt();
          await awaitSetup(
            dependencies.waitForRetry(
              REALTIME_CALL_RETRY_DELAYS_MS[attempt - 1] ?? 0,
              setupAbortController.signal,
            ),
          );
          assertSetupLive();
          continue;
        }

        diagnosticHttpStatus = response.status;
        const responseHeaders = readSafeOpenAiResponseHeaders(response.headers, dependencies.now());
        diagnosticRequestId = responseHeaders.requestId;
        diagnosticDetails = {
          ...diagnosticDetails,
          requestDurationMs: Math.max(0, dependencies.now() - requestStartedAtMs),
          openAiProcessingMs: responseHeaders.openAiProcessingMs,
          retryAfterMs: responseHeaders.retryAfterMs,
          responseContentTypeCategory: responseHeaders.contentTypeCategory,
          responseContentLengthBytes: responseHeaders.contentLengthBytes,
        };
        if (!response.ok) {
          const errorMetadata = await awaitSetup(
            readBoundedRealtimeErrorMetadata(response, setupAbortController.signal),
          );
          assertSetupLive();
          diagnosticDetails = { ...diagnosticDetails, ...errorMetadata };
          if (
            isRetryableRealtimeCallStatus(response.status) &&
            attempt < REALTIME_CALL_MAX_ATTEMPTS
          ) {
            // A generic 5xx or capacity response can be isolated to one
            // Realtime transcription allocator even when the API project is
            // otherwise healthy. Retry with OpenAI's other supported streaming
            // transcription model, using a newly token-bound session. Network
            // timeouts retain the current model because they do not establish
            // that OpenAI reached model allocation.
            if (
              clientSecret.model === DICTATION_TRANSCRIPTION_MODEL &&
              (response.status === 429 || response.status >= 500)
            ) {
              nextAttemptModel = DICTATION_FALLBACK_TRANSCRIPTION_MODEL;
            }
            recordDiagnostic(
              "retrying",
              response.status === 429 ? "upstream_rate_limited" : "upstream_unavailable",
            );
            discardCurrentTransportAttempt();
            await awaitSetup(
              dependencies.waitForRetry(
                Math.max(
                  REALTIME_CALL_RETRY_DELAYS_MS[attempt - 1] ?? 0,
                  responseHeaders.retryAfterMs ?? 0,
                ),
                setupAbortController.signal,
              ),
            );
            assertSetupLive();
            continue;
          }
          throw realtimeCallResponseError(response.status, clientSecret.model);
        }

        const answerSdp = await awaitSetup(
          readBoundedSdpAnswer(response, setupAbortController.signal),
        );
        assertSetupLive();
        const answerShape = summarizeSdpShape(answerSdp);
        diagnosticDetails = {
          ...diagnosticDetails,
          responseBodyBytes: answerShape.bytes,
          responseBodySha256: null,
          responseBodyTruncated: false,
          answerSdpBytes: answerShape.bytes,
          answerSdpLineCount: answerShape.lineCount,
          answerMediaSectionCount: answerShape.mediaSectionCount,
          answerAudioSectionCount: answerShape.audioSectionCount,
          answerApplicationSectionCount: answerShape.applicationSectionCount,
          answerCandidateCount: answerShape.candidateCount,
          answerHasOpus: answerShape.hasOpus,
          answerHasIceCandidate: answerShape.hasIceCandidate,
        };
        recordDiagnostic("completed");
        diagnosticStage = "peer_connect";
        recordDiagnostic("starting");
        assertSetupLive();
        await awaitSetup(
          attemptConnection.setRemoteDescription({ type: "answer", sdp: answerSdp }),
        );
        assertSetupLive();
        await awaitSetup(
          attemptChannel.readyState === "open" ? Promise.resolve() : openDeferred.promise,
        );
        assertSetupLive();
        return;
      }
    })();

    await withTimeout({
      promise: exchangePromise,
      timeoutMs: REALTIME_SETUP_TIMEOUT_MS,
      dependencies,
      onTimeout: () => interruptSetup(connectionError()),
      timeoutError: connectionError,
    });
    assertSetupLive();

    lifecycle = "active";
    diagnosticStage = "active";
    recordDiagnostic("connected");

    const stopAndFinalize = (): Promise<void> => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        if (lifecycle !== "active" || !dataChannel || dataChannel.readyState !== "open") {
          const error = connectionError();
          recordTerminalDiagnostic("failed", error.code);
          cleanup();
          throw error;
        }

        lifecycle = "finalizing";
        diagnosticStage = "finalizing";
        recordDiagnostic("starting");
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
          recordTerminalDiagnostic("completed");
        } catch (error) {
          const normalized =
            error instanceof RealtimeTranscriptionError ? error : connectionError();
          recordTerminalDiagnostic(
            normalized.code === "cancelled" ? "cancelled" : "failed",
            normalized.code,
          );
          throw normalized;
        } finally {
          cleanup();
        }
      })();
      return stopPromise;
    };

    return {
      stopAndFinalize,
      cancel: () => {
        if (lifecycle === "closed") return;
        const error = cancelledError();
        finalizationDeferred?.reject(error);
        diagnosticStage = "closed";
        recordTerminalDiagnostic("cancelled", error.code);
        cleanup();
      },
    };
  } catch (error) {
    const normalized = normalizeSetupError(error, input.signal?.aborted === true);
    recordTerminalDiagnostic(
      normalized.code === "cancelled" ? "cancelled" : "failed",
      normalized.code,
    );
    cleanup();
    throw normalized;
  }
}
