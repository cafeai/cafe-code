import type { RealtimeTranscriptionErrorCode } from "./realtimeTranscription";

const MAX_OPENAI_REQUEST_ID_CHARS = 128;
const OPENAI_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MAX_DIAGNOSTIC_ATTEMPTS = 8;

export type DictationDiagnosticStage =
  | "client_secret"
  | "microphone"
  | "sdp_exchange"
  | "peer_connect"
  | "active"
  | "finalizing"
  | "closed";

export type DictationDiagnosticOutcome =
  | "starting"
  | "retrying"
  | "connected"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * This is the complete allowlist for dictation data that may enter Cafe's
 * renderer debug snapshot. It deliberately excludes audio, transcripts, SDP,
 * headers, credentials, response bodies, and raw Error/cause objects.
 */
export interface DictationDiagnosticSnapshot {
  readonly capturedAt: string;
  readonly stage: DictationDiagnosticStage;
  readonly outcome: DictationDiagnosticOutcome;
  readonly attempt: number | null;
  readonly maxAttempts: number | null;
  readonly httpStatus: number | null;
  readonly requestId: string | null;
  readonly errorCode: RealtimeTranscriptionErrorCode | null;
}

export interface DictationDiagnosticUpdate {
  readonly nowMs: number;
  readonly stage: DictationDiagnosticStage;
  readonly outcome: DictationDiagnosticOutcome;
  readonly attempt?: number | null;
  readonly maxAttempts?: number | null;
  readonly httpStatus?: number | null;
  readonly requestId?: string | null;
  readonly errorCode?: RealtimeTranscriptionErrorCode | null;
}

let latestSnapshot: DictationDiagnosticSnapshot | null = null;
let currentOperationGeneration = 0;

/** Accept only OpenAI's documented opaque request-id token shape. */
function normalizeOpenAiRequestId(value: string | null | undefined): string | null {
  return value !== null &&
    value !== undefined &&
    value.length > 0 &&
    value.length <= MAX_OPENAI_REQUEST_ID_CHARS &&
    OPENAI_REQUEST_ID_PATTERN.test(value)
    ? value
    : null;
}

export function readSafeOpenAiRequestId(headers: Pick<Headers, "get">): string | null {
  return normalizeOpenAiRequestId(headers.get("x-request-id"));
}

function normalizeAttempt(value: number | null | undefined): number | null {
  return Number.isSafeInteger(value) &&
    value !== undefined &&
    value !== null &&
    value > 0 &&
    value <= MAX_DIAGNOSTIC_ATTEMPTS
    ? value
    : null;
}

function normalizeHttpStatus(value: number | null | undefined): number | null {
  return Number.isSafeInteger(value) &&
    value !== undefined &&
    value !== null &&
    value >= 100 &&
    value <= 599
    ? value
    : null;
}

function recordDictationDiagnostic(input: DictationDiagnosticUpdate): void {
  const capturedAtMs = Number.isFinite(input.nowMs) ? input.nowMs : 0;
  latestSnapshot = Object.freeze({
    capturedAt: new Date(capturedAtMs).toISOString(),
    stage: input.stage,
    outcome: input.outcome,
    attempt: normalizeAttempt(input.attempt),
    maxAttempts: normalizeAttempt(input.maxAttempts),
    httpStatus: normalizeHttpStatus(input.httpStatus),
    requestId: normalizeOpenAiRequestId(input.requestId),
    errorCode: input.errorCode ?? null,
  });
}

/**
 * Give each capture attempt an in-memory generation fence. A canceled older
 * WebRTC operation may settle after a replacement is already active; its late
 * promise handlers must not overwrite the current operation's debug state.
 * The generation is intentionally never exposed through the debug endpoint.
 */
export function beginDictationDiagnosticOperation(): (input: DictationDiagnosticUpdate) => void {
  currentOperationGeneration += 1;
  const operationGeneration = currentOperationGeneration;
  return (input) => {
    if (operationGeneration !== currentOperationGeneration) return;
    recordDictationDiagnostic(input);
  };
}

/** Return an immutable, content-free diagnostic suitable for `/debug`. */
export function getDictationDiagnosticSnapshot(): DictationDiagnosticSnapshot | null {
  return latestSnapshot;
}

export const __dictationDiagnosticsTestApi = {
  reset(): void {
    latestSnapshot = null;
    currentOperationGeneration = 0;
  },
};
