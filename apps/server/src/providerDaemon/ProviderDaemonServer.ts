// @effect-diagnostics nodeBuiltinImport:off
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import { performance } from "node:perf_hooks";

import {
  PROVIDER_DAEMON_EVENTS_PATH,
  PROVIDER_DAEMON_HEALTH_PATH,
  PROVIDER_DAEMON_LEASES_PATH,
  PROVIDER_DAEMON_RPC_PATH,
  ProviderDaemonLeaseRequest,
  type ProviderDaemonProcessDiagnostic,
  ProviderDaemonRpcRequest,
  type ProviderDaemonCapability,
  type ProviderDaemonEventRecord,
  type ProviderDaemonLeaseResponse,
  type ProviderDaemonRecentRpcFailure,
  type ProviderDaemonRpcEnvelope,
  type ProviderDaemonRpcRequest as ProviderDaemonRpcRequestValue,
  type ProviderDaemonSupervisorProcess,
  type ProviderDaemonTransport,
  type ProviderRuntimeProcessMode,
} from "@cafecode/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { type ProviderServiceError } from "../provider/Errors.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SQLITE_BUSY_TIMEOUT_MS } from "../persistence/Layers/Sqlite.ts";
import { ProviderSupervisorRegistry } from "../providerSupervisor/ProviderSupervisorRegistry.ts";
import {
  makePersistentProviderDaemonEventJournal,
  type ProviderDaemonPersistentEventJournal,
} from "./EventJournal.ts";
import { makeProviderDaemonCommandLedger } from "./CommandLedger.ts";
import {
  buildProviderDaemonErrorDiagnostics,
  summarizeProviderDaemonError,
} from "./ErrorDiagnostics.ts";
import { ProviderRuntimeInventory } from "./ProviderRuntimeInventory.ts";

const MAX_RPC_BODY_BYTES = 5 * 1024 * 1024;
const PROVIDER_DAEMON_EVENT_JOURNAL_CAPACITY = 50_000;
const PROVIDER_DAEMON_HEALTH_EVENT_DIAGNOSTICS_WINDOW = 100;
const PROVIDER_DAEMON_HEALTH_SNAPSHOT_BACKFILL_EVENT_LIMIT = 20;
const PROVIDER_DAEMON_HEALTH_RUNTIME_DIAGNOSTIC_EVENT_LIMIT = 20;
const PROVIDER_DAEMON_RECENT_RPC_FAILURE_LIMIT = 20;
const PROVIDER_DAEMON_PROCESS_DIAGNOSTIC_LIMIT = 50;

const decodeRpcRequest = Schema.decodeUnknownEffect(ProviderDaemonRpcRequest);
const decodeLeaseRequest = Schema.decodeUnknownEffect(ProviderDaemonLeaseRequest);

class ProviderDaemonListenError extends Data.TaggedError("ProviderDaemonListenError")<{
  readonly cause: unknown;
}> {}

export interface ProviderDaemonServerOptions {
  readonly mode?: ProviderRuntimeProcessMode;
  readonly transport?: ProviderDaemonTransport;
  readonly host?: string;
  readonly port?: number;
  readonly socketPath?: string;
  readonly token: string;
  readonly version: string;
  readonly runtimeBuildId?: string;
  readonly protocolVersion?: number;
  readonly supervisorProcess?: ProviderDaemonSupervisorProcess;
}

export interface ProviderDaemonServerSnapshot {
  readonly mode: ProviderRuntimeProcessMode;
  readonly transport: ProviderDaemonTransport;
  readonly host: string | null;
  readonly port: number | null;
  readonly socketPath: string | null;
  readonly startedAt: string;
  readonly pid: number;
  readonly eventCursor: number;
  readonly retainedEventCount: number;
}

interface ProviderDaemonLease {
  readonly leaseId: string;
  readonly token: string;
  readonly clientKind: string;
  readonly capabilities: ReadonlySet<ProviderDaemonCapability>;
  readonly issuedAt: string;
  readonly bootstrap: boolean;
}

interface ProviderDaemonRpcMetricsState {
  totalRpcCount: number;
  mutatingRpcCount: number;
  failedRpcCount: number;
  totalRpcDurationMs: number;
  maxRpcDurationMs: number;
  lastRpcMethod: string | null;
  lastRpcAt: string | null;
  lastRpcDurationMs: number | null;
  recentFailures: ProviderDaemonRecentRpcFailure[];
}

const initialRpcMetrics = (): ProviderDaemonRpcMetricsState => ({
  totalRpcCount: 0,
  mutatingRpcCount: 0,
  failedRpcCount: 0,
  totalRpcDurationMs: 0,
  maxRpcDurationMs: 0,
  lastRpcMethod: null,
  lastRpcAt: null,
  lastRpcDurationMs: null,
  recentFailures: [],
});

let processDiagnosticListenerInstalled = false;
let processDiagnosticTotalCount = 0;
const recentProcessDiagnostics: ProviderDaemonProcessDiagnostic[] = [];

function nowIsoUnsafe(): string {
  return Effect.runSync(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

export function captureProviderDaemonProcessDiagnostic(
  kind: ProviderDaemonProcessDiagnostic["kind"],
  error: unknown,
  origin?: string,
): void {
  processDiagnosticTotalCount += 1;
  recentProcessDiagnostics.push({
    capturedAt: nowIsoUnsafe(),
    kind,
    ...(origin === undefined || origin.length === 0 ? {} : { origin }),
    diagnostics: buildProviderDaemonErrorDiagnostics(error),
  });
  if (recentProcessDiagnostics.length > PROVIDER_DAEMON_PROCESS_DIAGNOSTIC_LIMIT) {
    recentProcessDiagnostics.splice(
      0,
      recentProcessDiagnostics.length - PROVIDER_DAEMON_PROCESS_DIAGNOSTIC_LIMIT,
    );
  }
}

function readProviderDaemonProcessDiagnosticsSnapshot(): {
  readonly totalCount: number;
  readonly recentLimit: number;
  readonly recent: ReadonlyArray<ProviderDaemonProcessDiagnostic>;
} {
  return {
    totalCount: processDiagnosticTotalCount,
    recentLimit: PROVIDER_DAEMON_PROCESS_DIAGNOSTIC_LIMIT,
    recent: recentProcessDiagnostics.slice(),
  };
}

function installProviderDaemonProcessDiagnosticListeners(): void {
  if (processDiagnosticListenerInstalled) {
    return;
  }
  processDiagnosticListenerInstalled = true;
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    captureProviderDaemonProcessDiagnostic("uncaughtException", error, origin);
  });
  process.on("unhandledRejection", (reason) => {
    captureProviderDaemonProcessDiagnostic("unhandledRejection", reason);
  });
  process.on("warning", (warning) => {
    captureProviderDaemonProcessDiagnostic("warning", warning, warning.name);
  });
}

function eventRawMethod(record: ProviderDaemonEventRecord): string | undefined {
  const method = record.event.raw?.method;
  return typeof method === "string" && method.length > 0 ? method : undefined;
}

function eventDiagnosticRecord(record: ProviderDaemonEventRecord): Record<string, unknown> {
  const rawMethod = eventRawMethod(record);
  return {
    cursor: record.cursor,
    emittedAt: record.emittedAt,
    eventId: record.event.eventId,
    type: record.event.type,
    ...(record.event.threadId ? { threadId: record.event.threadId } : {}),
    ...(record.event.turnId ? { turnId: record.event.turnId } : {}),
    ...(record.event.itemId ? { itemId: record.event.itemId } : {}),
    ...(rawMethod ? { rawMethod } : {}),
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function runtimeEventPayload(record: ProviderDaemonEventRecord): Record<string, unknown> {
  return readRecord(record.event.payload) ?? {};
}

function runtimeEventDetail(
  record: ProviderDaemonEventRecord,
): Record<string, unknown> | undefined {
  return readRecord(runtimeEventPayload(record).detail);
}

function runtimeEventUsage(record: ProviderDaemonEventRecord): Record<string, unknown> | undefined {
  return readRecord(runtimeEventPayload(record).usage);
}

function runtimeEventMessage(record: ProviderDaemonEventRecord): string | undefined {
  const payload = runtimeEventPayload(record);
  return (
    readString(payload.message) ?? readString(payload.summary) ?? readString(payload.description)
  );
}

function runtimeEventDiagnosticText(record: ProviderDaemonEventRecord): string {
  const detail = runtimeEventDetail(record);
  const detailError = readRecord(detail?.error);
  return [
    runtimeEventMessage(record),
    readString(detail?.message),
    readString(detail?.additionalDetails),
    readString(detailError?.message),
    readString(detailError?.additionalDetails),
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n");
}

function eventRuntimeDiagnosticRecord(record: ProviderDaemonEventRecord): Record<string, unknown> {
  const base = eventDiagnosticRecord(record);
  const payload = readRecord(record.event.payload);
  const message = typeof payload?.message === "string" ? payload.message : undefined;
  return {
    ...base,
    ...(message ? { message } : {}),
    ...(payload?.detail !== undefined ? { detail: payload.detail } : {}),
  };
}

function isSnapshotBackfillEvent(record: ProviderDaemonEventRecord): boolean {
  return String(record.event.eventId).startsWith("codex-snapshot:");
}

function recordEventTime(record: ProviderDaemonEventRecord): string {
  return record.event.createdAt ?? record.emittedAt;
}

function durationBetweenIso(
  start: string | undefined,
  end: string | undefined,
): number | undefined {
  if (!start || !end) {
    return undefined;
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return undefined;
  }
  return roundMs(Math.max(0, endMs - startMs));
}

function textIncludes(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle.toLowerCase());
}

function isTransportRetryDiagnostic(record: ProviderDaemonEventRecord): boolean {
  const payload = runtimeEventPayload(record);
  const detail = runtimeEventDetail(record);
  return (
    record.event.type === "runtime.warning" &&
    (readRecord(payload.detail)?.willRetry === true ||
      detail?.willRetry === true ||
      textIncludes(runtimeEventDiagnosticText(record), "reconnecting..."))
  );
}

function isResponseStreamDisconnectedDiagnostic(record: ProviderDaemonEventRecord): boolean {
  const text = runtimeEventDiagnosticText(record);
  return (
    textIncludes(text, "stream disconnected before completion") ||
    (textIncludes(text, "websocket closed") && textIncludes(text, "response.completed"))
  );
}

function isHttpFallbackDiagnostic(record: ProviderDaemonEventRecord): boolean {
  const text = runtimeEventDiagnosticText(record);
  return (
    textIncludes(text, "falling back from websockets to https transport") ||
    textIncludes(text, "falling back to http") ||
    eventRawMethod(record) === "codex.transportPolicy/applied"
  );
}

interface TurnTimingAccumulator {
  threadId: string;
  turnId: string;
  acceptedAt?: string;
  turnStartedAt?: string;
  firstAssistantItemStartedAt?: string;
  firstAssistantDeltaAt?: string;
  assistantCompletedAt?: string;
  turnCompletedAt?: string;
  lastEventAt?: string;
  lastAssistantDeltaAt?: string;
  firstAssistantDeltaTextBytes?: number;
  assistantDeltaCount: number;
  assistantDeltaTextBytes: number;
  largestAssistantDeltaTextBytes: number;
  maxAssistantDeltaGapMs?: number;
  transportRetryCount: number;
  responseStreamDisconnectedCount: number;
  runtimeWarningCount: number;
  runtimeErrorCount: number;
  httpFallbackAt?: string;
  model?: string;
  effort?: string;
  inputByteLength?: number;
}

function buildTurnTimingDiagnostics(
  records: ReadonlyArray<ProviderDaemonEventRecord>,
): ReadonlyArray<Record<string, unknown>> {
  const turns = new Map<string, TurnTimingAccumulator>();

  const getTurn = (record: ProviderDaemonEventRecord): TurnTimingAccumulator | undefined => {
    const threadId = record.event.threadId;
    const turnId = record.event.turnId;
    if (!threadId || !turnId) {
      return undefined;
    }
    const key = `${threadId}\u0000${turnId}`;
    const existing = turns.get(key);
    if (existing) {
      return existing;
    }
    const created: TurnTimingAccumulator = {
      threadId,
      turnId,
      assistantDeltaCount: 0,
      assistantDeltaTextBytes: 0,
      largestAssistantDeltaTextBytes: 0,
      transportRetryCount: 0,
      responseStreamDisconnectedCount: 0,
      runtimeWarningCount: 0,
      runtimeErrorCount: 0,
    };
    turns.set(key, created);
    return created;
  };

  for (const record of records) {
    const turn = getTurn(record);
    if (!turn) {
      continue;
    }

    const eventTime = recordEventTime(record);
    turn.lastEventAt = eventTime;
    const payload = runtimeEventPayload(record);
    const usage = runtimeEventUsage(record);

    if (eventRawMethod(record) === "codex.turnStart/accepted") {
      turn.acceptedAt = turn.acceptedAt ?? eventTime;
      const model = readString(usage?.model);
      const effort = readString(usage?.effort);
      const inputByteLength = readNumber(usage?.promptByteLength);
      if (turn.model === undefined && model !== undefined) turn.model = model;
      if (turn.effort === undefined && effort !== undefined) turn.effort = effort;
      if (turn.inputByteLength === undefined && inputByteLength !== undefined) {
        turn.inputByteLength = inputByteLength;
      }
    }

    if (record.event.type === "turn.started") {
      turn.turnStartedAt = turn.turnStartedAt ?? eventTime;
      const model = readString(payload.model);
      const effort = readString(payload.effort);
      if (turn.model === undefined && model !== undefined) turn.model = model;
      if (turn.effort === undefined && effort !== undefined) turn.effort = effort;
    }

    if (record.event.type === "item.started" && payload.itemType === "assistant_message") {
      turn.firstAssistantItemStartedAt = turn.firstAssistantItemStartedAt ?? eventTime;
    }

    if (record.event.type === "content.delta" && payload.streamKind === "assistant_text") {
      turn.firstAssistantDeltaAt = turn.firstAssistantDeltaAt ?? eventTime;
      const delta = readString(payload.delta) ?? "";
      const deltaBytes = Buffer.byteLength(delta, "utf8");
      const previousAssistantDeltaAt = turn.lastAssistantDeltaAt;
      turn.lastAssistantDeltaAt = eventTime;
      turn.assistantDeltaCount += 1;
      turn.assistantDeltaTextBytes += deltaBytes;
      turn.largestAssistantDeltaTextBytes = Math.max(
        turn.largestAssistantDeltaTextBytes,
        deltaBytes,
      );
      turn.firstAssistantDeltaTextBytes ??= deltaBytes;
      const assistantDeltaGapMs = durationBetweenIso(previousAssistantDeltaAt, eventTime);
      if (assistantDeltaGapMs !== undefined) {
        turn.maxAssistantDeltaGapMs = Math.max(
          turn.maxAssistantDeltaGapMs ?? 0,
          assistantDeltaGapMs,
        );
      }
    }

    if (record.event.type === "item.completed" && payload.itemType === "assistant_message") {
      turn.assistantCompletedAt = turn.assistantCompletedAt ?? eventTime;
    }

    if (record.event.type === "turn.completed") {
      turn.turnCompletedAt = turn.turnCompletedAt ?? eventTime;
    }

    if (record.event.type === "runtime.warning") {
      turn.runtimeWarningCount += 1;
    }

    if (record.event.type === "runtime.error") {
      turn.runtimeErrorCount += 1;
    }

    if (isTransportRetryDiagnostic(record)) {
      turn.transportRetryCount += 1;
    }

    if (isResponseStreamDisconnectedDiagnostic(record)) {
      turn.responseStreamDisconnectedCount += 1;
    }

    if (isHttpFallbackDiagnostic(record)) {
      turn.httpFallbackAt = turn.httpFallbackAt ?? eventTime;
    }
  }

  return Array.from(turns.values())
    .map((turn) => {
      const acceptedToTurnStartedMs = durationBetweenIso(turn.acceptedAt, turn.turnStartedAt);
      const acceptedToFirstAssistantDeltaMs = durationBetweenIso(
        turn.acceptedAt,
        turn.firstAssistantDeltaAt,
      );
      const acceptedToTurnCompletedMs = durationBetweenIso(turn.acceptedAt, turn.turnCompletedAt);
      const turnStartedToFirstAssistantDeltaMs = durationBetweenIso(
        turn.turnStartedAt,
        turn.firstAssistantDeltaAt,
      );
      const diagnostic: Record<string, unknown> = {
        threadId: turn.threadId,
        turnId: turn.turnId,
        transportRetryCount: turn.transportRetryCount,
        responseStreamDisconnectedCount: turn.responseStreamDisconnectedCount,
        runtimeWarningCount: turn.runtimeWarningCount,
        runtimeErrorCount: turn.runtimeErrorCount,
        assistantDeltaCount: turn.assistantDeltaCount,
        assistantDeltaTextBytes: turn.assistantDeltaTextBytes,
        largestAssistantDeltaTextBytes: turn.largestAssistantDeltaTextBytes,
      };
      if (turn.acceptedAt) diagnostic.acceptedAt = turn.acceptedAt;
      if (turn.turnStartedAt) diagnostic.turnStartedAt = turn.turnStartedAt;
      if (turn.firstAssistantItemStartedAt) {
        diagnostic.firstAssistantItemStartedAt = turn.firstAssistantItemStartedAt;
      }
      if (turn.firstAssistantDeltaAt) {
        diagnostic.firstAssistantDeltaAt = turn.firstAssistantDeltaAt;
      }
      if (turn.lastAssistantDeltaAt) {
        diagnostic.lastAssistantDeltaAt = turn.lastAssistantDeltaAt;
      }
      if (turn.firstAssistantDeltaTextBytes !== undefined) {
        diagnostic.firstAssistantDeltaTextBytes = turn.firstAssistantDeltaTextBytes;
      }
      if (turn.maxAssistantDeltaGapMs !== undefined) {
        diagnostic.maxAssistantDeltaGapMs = turn.maxAssistantDeltaGapMs;
      }
      if (turn.assistantCompletedAt) diagnostic.assistantCompletedAt = turn.assistantCompletedAt;
      if (turn.turnCompletedAt) diagnostic.turnCompletedAt = turn.turnCompletedAt;
      if (turn.lastEventAt) diagnostic.lastEventAt = turn.lastEventAt;
      if (acceptedToTurnStartedMs !== undefined) {
        diagnostic.acceptedToTurnStartedMs = acceptedToTurnStartedMs;
      }
      if (acceptedToFirstAssistantDeltaMs !== undefined) {
        diagnostic.acceptedToFirstAssistantDeltaMs = acceptedToFirstAssistantDeltaMs;
      }
      if (acceptedToTurnCompletedMs !== undefined) {
        diagnostic.acceptedToTurnCompletedMs = acceptedToTurnCompletedMs;
      }
      if (turnStartedToFirstAssistantDeltaMs !== undefined) {
        diagnostic.turnStartedToFirstAssistantDeltaMs = turnStartedToFirstAssistantDeltaMs;
      }
      if (turn.httpFallbackAt) diagnostic.httpFallbackAt = turn.httpFallbackAt;
      if (turn.model) diagnostic.model = turn.model;
      if (turn.effort) diagnostic.effort = turn.effort;
      if (turn.inputByteLength !== undefined) diagnostic.inputByteLength = turn.inputByteLength;
      return diagnostic;
    })
    .toSorted((left, right) =>
      String(right.lastEventAt ?? "").localeCompare(String(left.lastEventAt ?? "")),
    )
    .slice(0, 12);
}

function buildRuntimeEventDiagnostics(
  records: ReadonlyArray<ProviderDaemonEventRecord>,
): Record<string, unknown> {
  const recentRecords = records.slice(-PROVIDER_DAEMON_HEALTH_EVENT_DIAGNOSTICS_WINDOW);
  const methodCounts = new Map<string, number>();
  let snapshotBackfillEventCount = 0;
  let assistantTextDeltaCount = 0;
  let assistantMessageCompletedCount = 0;
  let turnStartedCount = 0;
  let turnCompletedCount = 0;
  let runtimeWarningCount = 0;
  let runtimeErrorCount = 0;
  let lastSnapshotBackfillAt: string | undefined;
  const snapshotBackfillEvents: ProviderDaemonEventRecord[] = [];
  const runtimeDiagnosticEvents: ProviderDaemonEventRecord[] = [];

  for (const record of recentRecords) {
    const rawMethod = eventRawMethod(record) ?? "unknown";
    const key = `${record.event.type}:${rawMethod}`;
    methodCounts.set(key, (methodCounts.get(key) ?? 0) + 1);

    if (isSnapshotBackfillEvent(record)) {
      snapshotBackfillEventCount += 1;
      lastSnapshotBackfillAt = record.emittedAt;
      snapshotBackfillEvents.push(record);
    }

    if (
      record.event.type === "content.delta" &&
      record.event.payload.streamKind === "assistant_text"
    ) {
      assistantTextDeltaCount += 1;
    }
    if (
      record.event.type === "item.completed" &&
      record.event.payload.itemType === "assistant_message"
    ) {
      assistantMessageCompletedCount += 1;
    }
    if (record.event.type === "turn.started") {
      turnStartedCount += 1;
    }
    if (record.event.type === "turn.completed") {
      turnCompletedCount += 1;
    }
    if (record.event.type === "runtime.warning") {
      runtimeWarningCount += 1;
      runtimeDiagnosticEvents.push(record);
    }
    if (record.event.type === "runtime.error") {
      runtimeErrorCount += 1;
      runtimeDiagnosticEvents.push(record);
    }
  }

  const lastRecord = recentRecords.at(-1);
  const lastRawMethod = lastRecord ? eventRawMethod(lastRecord) : undefined;
  return {
    recentWindowSize: PROVIDER_DAEMON_HEALTH_EVENT_DIAGNOSTICS_WINDOW,
    recentEventCount: recentRecords.length,
    snapshotBackfillEventCount,
    assistantTextDeltaCount,
    assistantMessageCompletedCount,
    turnStartedCount,
    turnCompletedCount,
    runtimeWarningCount,
    runtimeErrorCount,
    ...(lastRecord
      ? {
          lastEventAt: lastRecord.emittedAt,
          lastEventType: lastRecord.event.type,
          ...(lastRawMethod ? { lastRawMethod } : {}),
          ...(lastRecord.event.threadId ? { lastThreadId: lastRecord.event.threadId } : {}),
          ...(lastRecord.event.turnId ? { lastTurnId: lastRecord.event.turnId } : {}),
        }
      : {}),
    ...(lastSnapshotBackfillAt ? { lastSnapshotBackfillAt } : {}),
    recentMethodCounts: Array.from(methodCounts.entries())
      .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([key, count]) => ({ key, count })),
    recentSnapshotBackfillEvents: snapshotBackfillEvents
      .slice(-PROVIDER_DAEMON_HEALTH_SNAPSHOT_BACKFILL_EVENT_LIMIT)
      .map(eventDiagnosticRecord),
    recentRuntimeDiagnosticEvents: runtimeDiagnosticEvents
      .slice(-PROVIDER_DAEMON_HEALTH_RUNTIME_DIAGNOSTIC_EVENT_LIMIT)
      .map(eventRuntimeDiagnosticRecord),
    recentTurnTimings: buildTurnTimingDiagnostics(recentRecords),
  };
}

function constantTimeTokenEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function bearerToken(request: http.IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") {
    return null;
  }
  const prefix = "Bearer ";
  return authorization.startsWith(prefix) ? authorization.slice(prefix.length) : null;
}

function makeDaemonToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function makeLeaseId(): string {
  return crypto.randomBytes(16).toString("hex");
}

function writeJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function writeText(response: http.ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let receivedBytes = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > MAX_RPC_BODY_BYTES) {
        reject(new Error("provider daemon request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw.length === 0 ? {} : JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function toRpcError(error: unknown): Extract<ProviderDaemonRpcEnvelope, { readonly ok: false }> {
  const record =
    error !== null && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const diagnostics = buildProviderDaemonErrorDiagnostics(error);
  const tag = typeof record._tag === "string" ? record._tag : diagnostics.tag;
  const message = summarizeProviderDaemonError(error);
  return {
    ok: false,
    error: {
      tag,
      message,
      diagnostics,
    },
  };
}

const executeRpcRequest = (
  providerService: ProviderServiceShape,
  request: ProviderDaemonRpcRequestValue,
): Effect.Effect<unknown, ProviderServiceError> => {
  switch (request.method) {
    case "startSession":
      return providerService.startSession(request.payload.threadId, request.payload);
    case "sendTurn":
      return providerService.sendTurn(request.payload);
    case "steerTurn":
      return providerService.steerTurn(request.payload);
    case "interruptTurn":
      return providerService.interruptTurn(request.payload);
    case "respondToRequest":
      return providerService.respondToRequest(request.payload);
    case "respondToUserInput":
      return providerService.respondToUserInput(request.payload);
    case "stopSession":
      return providerService.stopSession(request.payload);
    case "listSessions":
      return providerService.listSessions();
    case "getCapabilities":
      return providerService.getCapabilities(request.payload.instanceId);
    case "getInstanceInfo":
      return providerService.getInstanceInfo(request.payload.instanceId);
    case "rollbackConversation":
      return providerService.rollbackConversation(request.payload);
    default:
      request satisfies never;
      return Effect.void;
  }
};

function requestCommandId(request: ProviderDaemonRpcRequestValue): string | undefined {
  return "commandId" in request ? request.commandId : undefined;
}

function parseAfterCursor(raw: string | null): number {
  if (raw === null || raw.trim().length === 0) {
    return 0;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function writeEventRecord(response: http.ServerResponse, record: unknown): void {
  response.write(`${JSON.stringify(record)}\n`);
}

function handleEventStream(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  journal: ProviderDaemonPersistentEventJournal,
  records: ReadonlyArray<unknown>,
  onCleanup: () => void,
): void {
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    connection: "keep-alive",
  });

  for (const record of records) {
    writeEventRecord(response, record);
  }

  const unsubscribe = journal.subscribe((record) => writeEventRecord(response, record));
  const cleanup = () => {
    unsubscribe();
    onCleanup();
    response.end();
  };
  request.once("close", cleanup);
  request.once("aborted", cleanup);
}

const closeHttpServer = (server: http.Server): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void));
  });

export const runProviderDaemonServer = (
  options: ProviderDaemonServerOptions,
): Effect.Effect<
  ProviderDaemonServerSnapshot,
  never,
  | Scope.Scope
  | ProviderService
  | ProviderRuntimeInventory
  | ServerSettingsService
  | ProviderSupervisorRegistry
  | SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    installProviderDaemonProcessDiagnosticListeners();

    const providerService = yield* ProviderService;
    const runtimeInventory = yield* ProviderRuntimeInventory;
    const serverSettings = yield* ServerSettingsService;
    const supervisorRegistry = yield* ProviderSupervisorRegistry;
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    const mode = options.mode ?? "provider-daemon";
    const transport = options.transport ?? "tcp";
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 3774;
    const journal = yield* makePersistentProviderDaemonEventJournal({
      capacity: PROVIDER_DAEMON_EVENT_JOURNAL_CAPACITY,
      ownerKey: mode,
    });
    const commandLedger = yield* makeProviderDaemonCommandLedger({ ownerKey: mode });
    const leases = new Map<string, ProviderDaemonLease>();
    const rpcMetrics = initialRpcMetrics();
    let activeStreamCount = 0;

    const appendRecentRpcFailure = (failure: ProviderDaemonRecentRpcFailure): void => {
      rpcMetrics.recentFailures.push(failure);
      if (rpcMetrics.recentFailures.length > PROVIDER_DAEMON_RECENT_RPC_FAILURE_LIMIT) {
        rpcMetrics.recentFailures.splice(
          0,
          rpcMetrics.recentFailures.length - PROVIDER_DAEMON_RECENT_RPC_FAILURE_LIMIT,
        );
      }
    };

    leases.set(options.token, {
      leaseId: "bootstrap",
      token: options.token,
      clientKind: "desktop-bootstrap",
      capabilities: new Set(["health", "events", "rpc", "lease"]),
      issuedAt: startedAt,
      bootstrap: true,
    });

    yield* serverSettings.start.pipe(
      Effect.catch((error) =>
        Effect.logWarning("provider daemon settings runtime failed to start", {
          detail: error.detail,
          settingsPath: error.settingsPath,
        }),
      ),
      Effect.forkScoped,
    );

    yield* Stream.runForEach(providerService.streamEvents, (event) => journal.publish(event)).pipe(
      Effect.forkScoped,
    );

    const providerRuntimeContext = yield* Effect.context<
      | ProviderService
      | ProviderRuntimeInventory
      | ServerSettingsService
      | ProviderSupervisorRegistry
    >();
    const runProviderEffect = Effect.runPromiseWith(providerRuntimeContext);

    const findLease = (request: http.IncomingMessage): ProviderDaemonLease | null => {
      const token = bearerToken(request);
      if (token === null) {
        return null;
      }
      for (const lease of leases.values()) {
        if (constantTimeTokenEquals(token, lease.token)) {
          return lease;
        }
      }
      return null;
    };

    const hasCapability = (
      request: http.IncomingMessage,
      capability: ProviderDaemonCapability,
    ): boolean => findLease(request)?.capabilities.has(capability) ?? false;

    const server = http.createServer((request, response) => {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", `http://${host}:${port}`);
      void (async () => {
        if (url.pathname === PROVIDER_DAEMON_HEALTH_PATH && method === "GET") {
          if (!hasCapability(request, "health")) {
            writeJson(response, 401, { error: "unauthorized" });
            return;
          }
          const health = await runProviderEffect(
            Effect.gen(function* () {
              const [sessions, inventorySnapshot] = yield* Effect.all([
                providerService.listSessions(),
                runtimeInventory.snapshot,
              ]);
              const journalSnapshot = yield* journal.snapshot;
              const recentEventRecords = yield* journal.replayAfter(
                Math.max(
                  0,
                  journalSnapshot.eventCursor - PROVIDER_DAEMON_HEALTH_EVENT_DIAGNOSTICS_WINDOW,
                ),
              );
              const commandSnapshot = yield* commandLedger.snapshot;
              const supervisorSnapshot = yield* supervisorRegistry.snapshot;
              return {
                ok: true,
                mode,
                protocolVersion: options.protocolVersion,
                pid: process.pid,
                ppid: process.ppid,
                version: options.version,
                ...(options.runtimeBuildId !== undefined
                  ? { runtimeBuildId: options.runtimeBuildId }
                  : {}),
                startedAt,
                activeSessionCount: sessions.length,
                configuredInstanceCount: inventorySnapshot.configuredInstanceCount,
                eventCursor: journalSnapshot.eventCursor,
                transport,
                activeStreamCount,
                retainedEventCount: journalSnapshot.retainedEventCount,
                oldestEventCursor: journalSnapshot.oldestCursor,
                newestEventCursor: journalSnapshot.newestCursor,
                leaseCount: leases.size,
                commandCount: commandSnapshot.commandCount,
                completedCommandCount: commandSnapshot.completedCommandCount,
                failedCommandCount: commandSnapshot.failedCommandCount,
                runningCommandCount: commandSnapshot.runningCommandCount,
                recentCompletedCommands: commandSnapshot.recentCompletedCommands,
                recentRunningCommands: commandSnapshot.recentRunningCommands,
                recentFailedCommands: commandSnapshot.recentFailedCommands,
                persistence: {
                  sqliteBusyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
                },
                rpc: {
                  totalRpcCount: rpcMetrics.totalRpcCount,
                  mutatingRpcCount: rpcMetrics.mutatingRpcCount,
                  failedRpcCount: rpcMetrics.failedRpcCount,
                  totalRpcDurationMs: roundMs(rpcMetrics.totalRpcDurationMs),
                  maxRpcDurationMs: roundMs(rpcMetrics.maxRpcDurationMs),
                  ...(rpcMetrics.totalRpcCount === 0
                    ? {}
                    : {
                        meanRpcDurationMs: roundMs(
                          rpcMetrics.totalRpcDurationMs / rpcMetrics.totalRpcCount,
                        ),
                      }),
                  ...(rpcMetrics.lastRpcMethod === null
                    ? {}
                    : { lastRpcMethod: rpcMetrics.lastRpcMethod }),
                  ...(rpcMetrics.lastRpcAt === null ? {} : { lastRpcAt: rpcMetrics.lastRpcAt }),
                  ...(rpcMetrics.lastRpcDurationMs === null
                    ? {}
                    : { lastRpcDurationMs: roundMs(rpcMetrics.lastRpcDurationMs) }),
                  ...(rpcMetrics.recentFailures.length === 0
                    ? {}
                    : { recentFailures: rpcMetrics.recentFailures.slice(-10) }),
                },
                runtimeEvents: buildRuntimeEventDiagnostics(recentEventRecords),
                supervisor: {
                  sessionCount: supervisorSnapshot.sessionCount,
                  runningSessionCount: supervisorSnapshot.runningSessionCount,
                  transferringSessionCount: supervisorSnapshot.transferringSessionCount,
                  detachedSessionCount: supervisorSnapshot.detachedSessionCount,
                  stoppedSessionCount: supervisorSnapshot.stoppedSessionCount,
                  errorSessionCount: supervisorSnapshot.errorSessionCount,
                  maxRawByteCursor: supervisorSnapshot.maxRawByteCursor,
                  maxParserCursor: supervisorSnapshot.maxParserCursor,
                },
                ...(inventorySnapshot.upstreamSupervisor !== undefined
                  ? { upstreamSupervisor: inventorySnapshot.upstreamSupervisor }
                  : {}),
                ...(options.supervisorProcess !== undefined
                  ? { supervisorProcess: options.supervisorProcess }
                  : {}),
                processDiagnostics: readProviderDaemonProcessDiagnosticsSnapshot(),
              } as const;
            }),
          );
          writeJson(response, 200, health);
          return;
        }

        if (url.pathname === PROVIDER_DAEMON_LEASES_PATH && method === "POST") {
          if (!hasCapability(request, "lease")) {
            writeJson(response, 401, { error: "unauthorized" });
            return;
          }
          const rawBody = await readJsonBody(request);
          const envelope: ProviderDaemonLeaseResponse | ProviderDaemonRpcEnvelope =
            await runProviderEffect(
              decodeLeaseRequest(rawBody).pipe(
                Effect.flatMap((leaseRequest) =>
                  Effect.gen(function* () {
                    const token = makeDaemonToken();
                    const leaseId = makeLeaseId();
                    const issuedAt = DateTime.formatIso(yield* DateTime.now);
                    leases.set(token, {
                      leaseId,
                      token,
                      clientKind: leaseRequest.clientKind,
                      capabilities: new Set(leaseRequest.capabilities),
                      issuedAt,
                      bootstrap: false,
                    });
                    return {
                      leaseId,
                      token,
                      capabilities: leaseRequest.capabilities,
                      issuedAt,
                    } satisfies ProviderDaemonLeaseResponse;
                  }),
                ),
                Effect.catch((error) => Effect.succeed(toRpcError(error))),
              ),
            );
          writeJson(response, "ok" in envelope && envelope.ok === false ? 400 : 200, envelope);
          return;
        }

        if (url.pathname === PROVIDER_DAEMON_EVENTS_PATH && method === "GET") {
          if (!hasCapability(request, "events")) {
            writeJson(response, 401, { error: "unauthorized" });
            return;
          }
          const records = await runProviderEffect(
            journal.replayAfter(parseAfterCursor(url.searchParams.get("after"))),
          );
          activeStreamCount += 1;
          handleEventStream(request, response, journal, records, () => {
            activeStreamCount = Math.max(0, activeStreamCount - 1);
          });
          return;
        }

        if (url.pathname === PROVIDER_DAEMON_RPC_PATH && method === "POST") {
          if (!hasCapability(request, "rpc")) {
            writeJson(response, 401, { error: "unauthorized" });
            return;
          }
          const rawBody = await readJsonBody(request);
          const rpcStartedAtMs = performance.now();
          let rpcMethod: ProviderDaemonRpcRequestValue["method"] | null = null;
          let rpcCommandId: string | undefined;
          let envelope: ProviderDaemonRpcEnvelope;
          try {
            envelope = await runProviderEffect(
              decodeRpcRequest(rawBody).pipe(
                Effect.tap((rpcRequest) =>
                  Effect.sync(() => {
                    rpcMethod = rpcRequest.method;
                    rpcCommandId = requestCommandId(rpcRequest);
                  }),
                ),
                Effect.flatMap((rpcRequest) =>
                  commandLedger.runOnce(
                    rpcRequest,
                    executeRpcRequest(providerService, rpcRequest).pipe(
                      Effect.map(
                        (value): ProviderDaemonRpcEnvelope => ({
                          ok: true,
                          value: value === undefined ? null : value,
                        }),
                      ),
                      Effect.catch((error) => Effect.succeed(toRpcError(error))),
                    ),
                  ),
                ),
                Effect.catch((error) => Effect.succeed(toRpcError(error))),
              ),
            );
          } catch (error) {
            envelope = toRpcError(error);
          }
          const rpcDurationMs = roundMs(performance.now() - rpcStartedAtMs);
          const rpcCompletedAt = await runProviderEffect(
            DateTime.now.pipe(Effect.map(DateTime.formatIso)),
          );
          rpcMetrics.totalRpcCount += 1;
          rpcMetrics.totalRpcDurationMs += rpcDurationMs;
          rpcMetrics.maxRpcDurationMs = Math.max(rpcMetrics.maxRpcDurationMs, rpcDurationMs);
          rpcMetrics.lastRpcMethod = rpcMethod;
          rpcMetrics.lastRpcAt = rpcCompletedAt;
          rpcMetrics.lastRpcDurationMs = rpcDurationMs;
          if (rpcMethod !== null && commandLedger.isMutating(rpcMethod)) {
            rpcMetrics.mutatingRpcCount += 1;
          }
          if (!envelope.ok) {
            rpcMetrics.failedRpcCount += 1;
            appendRecentRpcFailure({
              failedAt: rpcCompletedAt,
              ...(rpcMethod === null ? {} : { method: rpcMethod }),
              ...(rpcCommandId === undefined ? {} : { commandId: rpcCommandId }),
              durationMs: rpcDurationMs,
              tag: envelope.error.tag,
              message: envelope.error.message,
              ...(envelope.error.diagnostics === undefined
                ? {}
                : { diagnostics: envelope.error.diagnostics }),
            });
            await runProviderEffect(
              Effect.logError("provider daemon rpc failed", {
                mode,
                method: rpcMethod,
                commandId: rpcCommandId,
                durationMs: rpcDurationMs,
                error: envelope.error,
              }),
            );
          }
          writeJson(response, envelope.ok ? 200 : 400, envelope);
          return;
        }

        if (url.pathname === PROVIDER_DAEMON_RPC_PATH) {
          response.writeHead(405, {
            allow: "POST",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          response.end();
          return;
        }

        writeText(response, 404, "not found\n");
      })().catch((error) => {
        const envelope = toRpcError(error);
        void runProviderEffect(
          Effect.logError("provider daemon http request failed", {
            mode,
            method,
            path: url.pathname,
            error: envelope.error,
          }),
        ).catch(() => undefined);
        writeJson(response, 500, envelope);
      });
    });

    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => {
            server.off("listening", onListening);
            reject(error);
          };
          const onListening = () => {
            server.off("error", onError);
            resolve();
          };
          server.once("error", onError);
          server.once("listening", onListening);
          if (transport === "ipc" && options.socketPath !== undefined) {
            server.listen(options.socketPath);
          } else {
            server.listen(port, host);
          }
        }),
      catch: (cause) => new ProviderDaemonListenError({ cause }),
    }).pipe(
      Effect.catch((error) =>
        Effect.die(
          error instanceof Error
            ? error
            : new Error(`Provider daemon failed to listen: ${String(error)}`),
        ),
      ),
    );

    yield* Effect.addFinalizer(() =>
      closeHttpServer(server).pipe(
        Effect.andThen(
          transport === "ipc" && options.socketPath !== undefined
            ? Effect.tryPromise({
                try: () => fs.rm(options.socketPath as string, { force: true }),
                catch: () => undefined,
              }).pipe(Effect.ignore)
            : Effect.void,
        ),
      ),
    );
    const journalSnapshot = yield* journal.snapshot;

    return {
      mode,
      transport,
      host: transport === "tcp" ? host : null,
      port: transport === "tcp" ? port : null,
      socketPath: transport === "ipc" ? (options.socketPath ?? null) : null,
      startedAt,
      pid: process.pid,
      eventCursor: journalSnapshot.eventCursor,
      retainedEventCount: journalSnapshot.retainedEventCount,
    };
  });

export const runProviderDaemonServerForever = (
  options: ProviderDaemonServerOptions,
): Effect.Effect<
  never,
  never,
  | Scope.Scope
  | ProviderService
  | ProviderRuntimeInventory
  | ServerSettingsService
  | ProviderSupervisorRegistry
  | SqlClient.SqlClient
> =>
  runProviderDaemonServer(options).pipe(
    Effect.tap((snapshot) =>
      Effect.logInfo("provider daemon listening", {
        mode: snapshot.mode,
        transport: snapshot.transport,
        host: snapshot.host,
        port: snapshot.port,
        socketPath: snapshot.socketPath,
        pid: snapshot.pid,
      }),
    ),
    Effect.andThen(Effect.never),
  );
