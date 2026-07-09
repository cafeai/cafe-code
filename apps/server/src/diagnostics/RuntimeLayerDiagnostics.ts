import {
  PROVIDER_DAEMON_HEALTH_PATH,
  ProviderDaemonHealth,
  type ProviderDaemonCommandDiagnostic,
  type ProviderDaemonHealth as ProviderDaemonHealthType,
  type ServerOrchestratorProjectorCursor,
  type ServerOrchestratorRecentEventTypeCount,
  type ServerOrchestratorStaleStateFlag,
  type ServerProviderDaemonDiagnostics,
  type ServerProviderDaemonRecentCommandSummary,
  type ServerProviderDaemonRuntimeEventSummary,
  type ServerProviderRuntimeIngestionDiagnostics,
  type ServerProviderSupervisorDiagnostics,
  type ServerRuntimeLayerDiagnosticsInput,
  type ServerRuntimeLayerDiagnosticsResult,
  type ServerRuntimeLayerOwnerKind,
  type ServerRuntimeLayerProcess,
  type ServerRuntimeLayerResourceSummary,
  type ServerRuntimeLayerRole,
  type ServerRuntimeLayerStatus,
  type ServerRuntimeLayerSummary,
} from "@cafecode/contracts";
import { requestProviderDaemonJson } from "@cafecode/shared/providerDaemonHttp";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { performance } from "node:perf_hooks";

import { ServerConfig } from "../config.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { ProjectionStateRepository } from "../persistence/Services/ProjectionState.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PROVIDER_DAEMON_RUNTIME_CURSOR_PROJECTOR } from "../providerDaemon/ProviderDaemonRuntimeCursor.ts";
import {
  isDiagnosticsQueryProcess,
  sanitizeProcessCommand,
  type ProcessRow,
  readProcessRows,
} from "./ProcessDiagnostics.ts";

export { sanitizeProcessCommand } from "./ProcessDiagnostics.ts";

const DEFAULT_WINDOW_MS = 5 * 60_000;
const DEFAULT_BUCKET_MS = 30_000;
const RECENT_EVENT_WINDOW_LIMIT = 250;
const MAX_EVENT_TYPE_ROWS = 12;
const MAX_DAEMON_COMMAND_ROWS = 8;
const PROVIDER_RUNTIME_INGESTION_OFFLINE_EVENT_LAG = 1_000;
// The daemon can be busy while it is streaming provider output or compacting its
// retained event journal. Diagnostics should not falsely mark that daemon as
// unreachable merely because a health snapshot took slightly longer than a UI
// refresh cadence.
const DAEMON_HEALTH_TIMEOUT_MS = 5_000;

const decodeProviderDaemonHealthJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderDaemonHealth),
);

const LatestEventSequenceRow = Schema.Struct({
  latestEventSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const RecentEventTypeCountRow = Schema.Struct({
  eventType: Schema.String.check(Schema.isNonEmpty()),
  actorKind: Schema.NullOr(Schema.String),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lastSeenAt: Schema.String.check(Schema.isNonEmpty()),
});

const ActiveTurnCountsRow = Schema.Struct({
  pendingTurnCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  runningTurnCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const StaleStateCountsRow = Schema.Struct({
  terminalActiveSessionCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  terminalStreamingMessageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

type RecentEventTypeCountRow = typeof RecentEventTypeCountRow.Type;
type ActiveTurnCountsRow = typeof ActiveTurnCountsRow.Type;
type StaleStateCountsRow = typeof StaleStateCountsRow.Type;

class RuntimeLayerDiagnosticsReadError extends Schema.TaggedErrorClass<RuntimeLayerDiagnosticsReadError>()(
  "RuntimeLayerDiagnosticsReadError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    const causeMessage = describeSafeCause(this.cause);
    if (causeMessage === null || this.detail.includes(causeMessage)) {
      return `${this.operation}: ${this.detail}`;
    }
    return `${this.operation}: ${this.detail} (${causeMessage})`;
  }
}

export interface RuntimeLayerDiagnosticsShape {
  readonly read: (
    input?: ServerRuntimeLayerDiagnosticsInput,
  ) => Effect.Effect<ServerRuntimeLayerDiagnosticsResult>;
}

export class RuntimeLayerDiagnostics extends Context.Service<
  RuntimeLayerDiagnostics,
  RuntimeLayerDiagnosticsShape
>()("cafecode/diagnostics/RuntimeLayerDiagnostics") {}

function describeSafeCause(cause: unknown): string | null {
  if (cause === undefined || cause === null) return null;
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  if (typeof cause === "object" && "message" in cause) {
    const message = (cause as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }
  return null;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeProcessCommand(message, { maxLength: 360 });
}

function commandLabel(command: string, fallback: string): string {
  const sanitized = sanitizeProcessCommand(command, { maxLength: 96 });
  const first =
    sanitized.match(/"([^"]+)"|'([^']+)'|(\S+)/)?.[1] ??
    sanitized.match(/"([^"]+)"|'([^']+)'|(\S+)/)?.[2] ??
    sanitized.match(/"([^"]+)"|'([^']+)'|(\S+)/)?.[3];
  if (!first) return fallback;
  const basename = first.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? first;
  return basename.length > 0 ? basename : fallback;
}

function childrenByParent(rows: ReadonlyArray<ProcessRow>): Map<number, ReadonlyArray<ProcessRow>> {
  const map = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const children = map.get(row.ppid) ?? [];
    children.push(row);
    map.set(row.ppid, children);
  }
  for (const [parent, children] of map) {
    map.set(
      parent,
      children.toSorted((left, right) => left.pid - right.pid),
    );
  }
  return map;
}

interface RuntimeProcessTarget {
  readonly pid: number;
  readonly role: ServerRuntimeLayerRole;
  readonly ownerKind: ServerRuntimeLayerOwnerKind;
  readonly attribution: string;
  readonly notes?: ReadonlyArray<string>;
}

function descendantRole(target: RuntimeProcessTarget): ServerRuntimeLayerRole {
  switch (target.role) {
    case "provider-daemon":
    case "provider-supervisor":
      return "provider-runtime";
    case "backend":
      return "unknown-child";
    default:
      return target.role;
  }
}

function descendantOwnerKind(target: RuntimeProcessTarget): ServerRuntimeLayerOwnerKind {
  switch (target.role) {
    case "provider-daemon":
      return "daemon-descendant";
    case "provider-supervisor":
      return "supervisor-descendant";
    case "backend":
      return "backend-descendant";
    default:
      return "unknown";
  }
}

export function buildRuntimeProcessEntries(input: {
  readonly rows: ReadonlyArray<ProcessRow>;
  readonly serverPid: number;
  readonly readAt: string;
  readonly targets: ReadonlyArray<RuntimeProcessTarget>;
}): ReadonlyArray<ServerRuntimeLayerProcess> {
  const rows = input.rows.filter((row) => !isDiagnosticsQueryProcess(row, input.serverPid));
  const byPid = new Map(rows.map((row) => [row.pid, row] as const));
  const byParent = childrenByParent(rows);
  const entries = new Map<number, ServerRuntimeLayerProcess>();

  const insertRow = (
    row: ProcessRow,
    target: RuntimeProcessTarget,
    depth: number,
    role: ServerRuntimeLayerRole,
    ownerKind: ServerRuntimeLayerOwnerKind,
  ) => {
    const existing = entries.get(row.pid);
    const targetPriority = depth === 0 ? 0 : 1;
    const existingPriority = existing?.depth ?? Number.MAX_SAFE_INTEGER;
    if (existing && existingPriority < targetPriority) return;
    const children = [...(byParent.get(row.pid) ?? [])];
    entries.set(row.pid, {
      role,
      ownerKind,
      pid: row.pid,
      ppid: row.ppid,
      status: row.status || "unknown",
      cpuPercent: Math.max(0, row.cpuPercent),
      rssBytes: Math.max(0, row.rssBytes),
      elapsed: row.elapsed || null,
      commandLabel: commandLabel(row.command, role),
      sanitizedCommand: sanitizeProcessCommand(row.command),
      depth,
      childPids: children.map((child) => child.pid),
      attribution: target.attribution,
      lastSeenAt: input.readAt,
      notes: [...(target.notes ?? [])].filter((note) => note.trim().length > 0),
    });
  };

  for (const target of input.targets) {
    const root = byPid.get(target.pid);
    if (!root) {
      entries.set(target.pid, {
        role: target.role,
        ownerKind: target.ownerKind,
        pid: target.pid,
        ppid: null,
        status: "missing",
        cpuPercent: 0,
        rssBytes: 0,
        elapsed: null,
        commandLabel: `${target.role} missing`,
        sanitizedCommand: `${target.role} process is not visible`,
        depth: 0,
        childPids: [],
        attribution: target.attribution,
        lastSeenAt: null,
        notes: [...(target.notes ?? []), "Known PID was not present in the process table."],
      });
      continue;
    }

    const queue: Array<{ readonly row: ProcessRow; readonly depth: number }> = [
      { row: root, depth: 0 },
    ];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next || seen.has(next.row.pid)) continue;
      seen.add(next.row.pid);
      const isRoot = next.depth === 0;
      insertRow(
        next.row,
        target,
        next.depth,
        isRoot ? target.role : descendantRole(target),
        isRoot ? target.ownerKind : descendantOwnerKind(target),
      );
      queue.push(
        ...[...(byParent.get(next.row.pid) ?? [])].map((row) => ({
          row,
          depth: next.depth + 1,
        })),
      );
    }
  }

  return [...entries.values()].toSorted((left, right) => {
    if (left.depth !== right.depth) return left.depth - right.depth;
    return (left.pid ?? 0) - (right.pid ?? 0);
  });
}

function mapCommand(
  command: ProviderDaemonCommandDiagnostic,
): ServerProviderDaemonRecentCommandSummary {
  const error = command.errorMessage ?? command.errorTag ?? null;
  return {
    status: command.status ?? "unknown",
    method: sanitizeProcessCommand(command.method, { maxLength: 80 }),
    durationMs: command.durationMs ?? null,
    updatedAt: command.updatedAt,
    error: error ? sanitizeProcessCommand(error, { maxLength: 160 }) : null,
  };
}

function boundedCommands(
  commands: ReadonlyArray<ProviderDaemonCommandDiagnostic | undefined>,
): ReadonlyArray<ServerProviderDaemonRecentCommandSummary> {
  return commands
    .filter((command): command is ProviderDaemonCommandDiagnostic => command !== undefined)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_DAEMON_COMMAND_ROWS)
    .map(mapCommand);
}

function runtimeEventSummaries(
  health: ProviderDaemonHealthType,
): ReadonlyArray<ServerProviderDaemonRuntimeEventSummary> {
  const runtimeEvents = health.runtimeEvents;
  if (!runtimeEvents) return [];
  return runtimeEvents.recentMethodCounts.slice(0, MAX_EVENT_TYPE_ROWS).map((entry) => ({
    eventType: sanitizeProcessCommand(entry.key, { maxLength: 120 }),
    count: entry.count,
    lastSeenAt: runtimeEvents.lastEventAt ?? null,
  }));
}

export function mapProviderDaemonHealth(input: {
  readonly health: ProviderDaemonHealthType | null;
  readonly configured: boolean;
  readonly reachable: boolean;
  readonly healthLatencyMs: number | null;
  readonly error: string | null;
}): ServerProviderDaemonDiagnostics {
  const health = input.health;
  return {
    available: input.configured,
    reachable: input.reachable,
    status: !input.configured ? "offline" : input.reachable ? "online" : "degraded",
    pid: health?.pid ?? null,
    ppid: health?.ppid ?? null,
    mode: health?.mode ?? null,
    transport: health?.transport ?? null,
    healthLatencyMs: input.healthLatencyMs,
    startedAt: health?.startedAt ?? null,
    activeSessionCount: health?.activeSessionCount ?? 0,
    activeStreamCount: health?.activeStreamCount ?? 0,
    retainedEventCount: health?.retainedEventCount ?? 0,
    eventCursor: health?.eventCursor ?? 0,
    leaseCount: health?.leaseCount ?? 0,
    commandCount: health?.commandCount ?? 0,
    runningCommandCount: health?.runningCommandCount ?? 0,
    completedCommandCount: health?.completedCommandCount ?? 0,
    failedCommandCount: health?.failedCommandCount ?? 0,
    totalRpcCount: health?.rpc?.totalRpcCount ?? 0,
    failedRpcCount: health?.rpc?.failedRpcCount ?? 0,
    maxRpcDurationMs: health?.rpc?.maxRpcDurationMs ?? 0,
    meanRpcDurationMs: health?.rpc?.meanRpcDurationMs ?? null,
    sqliteBusyTimeoutMs: health?.persistence?.sqliteBusyTimeoutMs ?? null,
    recentCommands: boundedCommands([
      ...(health?.recentRunningCommands ?? []),
      ...(health?.recentFailedCommands ?? []),
      ...(health?.recentCompletedCommands ?? []),
    ]),
    runtimeEventSummaries: health ? runtimeEventSummaries(health) : [],
    error: input.error,
  };
}

export function mapProviderSupervisorHealth(input: {
  readonly daemonHealth: ProviderDaemonHealthType | null;
  readonly daemonConfigured: boolean;
  readonly daemonReachable: boolean;
}): ServerProviderSupervisorDiagnostics {
  const upstream = input.daemonHealth?.upstreamSupervisor;
  const process = input.daemonHealth?.supervisorProcess;
  const configured = upstream?.configured ?? Boolean(process);
  const reachable = upstream?.reachable ?? Boolean(process);
  const sessionCounts: Record<string, number> = {};
  if (upstream?.activeSessionCount !== undefined) {
    sessionCounts.active = upstream.activeSessionCount;
  }
  if (upstream?.activeStreamCount !== undefined) {
    sessionCounts.streaming = upstream.activeStreamCount;
  }
  if (!configured && !input.daemonConfigured) {
    sessionCounts.unavailable = 1;
  }

  return {
    configured,
    reachable,
    status: !configured ? "offline" : reachable ? "online" : "degraded",
    pid: upstream?.pid ?? process?.pid ?? null,
    ppid: upstream?.ppid ?? null,
    transport: upstream?.endpointTransport ?? process?.transport ?? null,
    healthLatencyMs: upstream?.healthLatencyMs ?? null,
    activeSessionCount: upstream?.activeSessionCount ?? 0,
    activeStreamCount: upstream?.activeStreamCount ?? 0,
    retainedEventCount: upstream?.retainedEventCount ?? 0,
    commandCount: upstream?.commandCount ?? 0,
    runningCommandCount: upstream?.runningCommandCount ?? 0,
    completedCommandCount: upstream?.completedCommandCount ?? 0,
    failedCommandCount: upstream?.failedCommandCount ?? 0,
    sessionCounts,
    error:
      upstream?.lastError !== undefined
        ? sanitizeProcessCommand(upstream.lastError, { maxLength: 240 })
        : input.daemonConfigured && !input.daemonReachable
          ? "Provider daemon is not reachable, so supervisor health is unavailable."
          : null,
  };
}

export function buildProjectorCursors(input: {
  readonly latestEventSequence: number;
  readonly projectors: ReadonlyArray<{
    readonly projector: string;
    readonly lastAppliedSequence: number;
    readonly updatedAt: string;
  }>;
}): ReadonlyArray<ServerOrchestratorProjectorCursor> {
  return input.projectors.map((projector) => {
    const lag = Math.max(0, input.latestEventSequence - projector.lastAppliedSequence);
    const status: ServerRuntimeLayerStatus =
      lag === 0 ? "online" : lag < 25 ? "degraded" : "offline";
    return {
      projector: projector.projector,
      cursor: projector.lastAppliedSequence,
      lag,
      updatedAt: projector.updatedAt,
      status,
    };
  });
}

function isProjectionProjector(projector: string): boolean {
  return projector.startsWith("projection.");
}

export function buildProjectionProgress(input: {
  readonly latestEventSequence: number;
  readonly projectorCursors: ReadonlyArray<
    Pick<ServerOrchestratorProjectorCursor, "projector" | "cursor">
  >;
}): {
  readonly projectionSequence: number;
  readonly projectionLag: number;
} {
  // `projection_state` also contains operational cursors such as
  // `provider-daemon-runtime-ingestion`. Those rows track daemon replay/reconciliation
  // progress and can validly lag far behind durable UI projections. The Orchestrator
  // layer status should describe renderer-visible projections only, otherwise an idle
  // backend with caught-up projections can be reported as offline.
  const projectionCursors = input.projectorCursors.filter((cursor) =>
    isProjectionProjector(cursor.projector),
  );
  const projectionSequence =
    projectionCursors.length === 0
      ? 0
      : Math.min(...projectionCursors.map((projector) => projector.cursor));
  const projectionLag = Math.max(0, input.latestEventSequence - projectionSequence);

  return { projectionSequence, projectionLag };
}

function statusForProviderRuntimeIngestionLag(lag: number): ServerRuntimeLayerStatus {
  if (lag <= 0) {
    return "online";
  }
  if (lag < PROVIDER_RUNTIME_INGESTION_OFFLINE_EVENT_LAG) {
    return "degraded";
  }
  return "offline";
}

export function buildProviderRuntimeIngestionDiagnostics(input: {
  readonly daemonEventCursor: number;
  readonly lastDaemonEventAt: string | null;
  readonly projectorCursors: ReadonlyArray<
    Pick<ServerOrchestratorProjectorCursor, "projector" | "cursor" | "updatedAt">
  >;
}): ServerProviderRuntimeIngestionDiagnostics {
  const cursor = input.projectorCursors.find(
    (projector) => projector.projector === PROVIDER_DAEMON_RUNTIME_CURSOR_PROJECTOR,
  );
  const daemonEventCursor = Math.max(0, input.daemonEventCursor);
  const ingestionCursor = Math.max(0, cursor?.cursor ?? 0);
  const lag = Math.max(0, daemonEventCursor - ingestionCursor);

  return {
    cursor: ingestionCursor,
    daemonEventCursor,
    lag,
    updatedAt: cursor?.updatedAt ?? null,
    lastDaemonEventAt: input.lastDaemonEventAt,
    status: statusForProviderRuntimeIngestionLag(lag),
  };
}

export function buildStaleStateFlags(input: {
  readonly counts: StaleStateCountsRow;
  readonly daemonActiveStreams: number;
  readonly activeTurnCount: number;
}): ReadonlyArray<ServerOrchestratorStaleStateFlag> {
  const flags: ServerOrchestratorStaleStateFlag[] = [];
  if (input.counts.terminalActiveSessionCount > 0) {
    flags.push({
      kind: "terminal-active-session",
      count: input.counts.terminalActiveSessionCount,
      severity: "danger",
      message: "Projected sessions still point at terminal turns.",
    });
  }
  if (input.counts.terminalStreamingMessageCount > 0) {
    flags.push({
      kind: "terminal-streaming-message",
      count: input.counts.terminalStreamingMessageCount,
      severity: "warning",
      message: "Assistant messages are still marked streaming after terminal turns.",
    });
  }
  if (input.daemonActiveStreams > 0 && input.activeTurnCount === 0) {
    flags.push({
      kind: "daemon-stream-without-active-turn",
      count: input.daemonActiveStreams,
      severity: "warning",
      message: "Daemon reports active streams while projections show no active turns.",
    });
  }
  return flags;
}

export function buildLayerSummaries(input: {
  readonly serverPid: number;
  readonly serverStartedAt: string | null;
  readonly processes: ReadonlyArray<ServerRuntimeLayerProcess>;
  readonly daemon: ServerProviderDaemonDiagnostics;
  readonly supervisor: ServerProviderSupervisorDiagnostics;
  readonly orchestratorLag: number;
  readonly readAt: string;
}): ReadonlyArray<ServerRuntimeLayerSummary> {
  const byRole = new Map<ServerRuntimeLayerRole, ServerRuntimeLayerProcess[]>();
  for (const process of input.processes) {
    byRole.set(process.role, [...(byRole.get(process.role) ?? []), process]);
  }
  const summarize = (
    role: ServerRuntimeLayerRole,
    status: ServerRuntimeLayerStatus,
    pid: number | null,
    notes: ReadonlyArray<string>,
    lastEventAt: string | null = null,
  ): ServerRuntimeLayerSummary => {
    const roleProcesses = byRole.get(role) ?? [];
    return {
      role,
      status,
      pid,
      rssBytes: roleProcesses.reduce((total, process) => total + process.rssBytes, 0),
      cpuPercent: roleProcesses.reduce((total, process) => total + process.cpuPercent, 0),
      uptimeLabel: roleProcesses[0]?.elapsed ?? null,
      lastEventAt,
      notes: notes.filter((note) => note.trim().length > 0),
    };
  };

  return [
    summarize("backend", "online", input.serverPid, ["Main backend process."], input.readAt),
    summarize(
      "orchestrator",
      input.orchestratorLag === 0 ? "online" : input.orchestratorLag < 25 ? "degraded" : "offline",
      null,
      [
        `Projection lag: ${input.orchestratorLag}`,
        `In-process subsystem hosted by backend PID ${input.serverPid}.`,
      ],
      input.readAt,
    ),
    summarize(
      "provider-daemon",
      input.daemon.status,
      input.daemon.pid,
      input.daemon.error ? [input.daemon.error] : ["Provider daemon health summary."],
      input.daemon.startedAt,
    ),
    summarize(
      "provider-supervisor",
      input.supervisor.status,
      input.supervisor.pid,
      input.supervisor.error ? [input.supervisor.error] : ["Provider supervisor health summary."],
      null,
    ),
  ];
}

function buildResourceSummaries(
  processes: ReadonlyArray<ServerRuntimeLayerProcess>,
): ReadonlyArray<ServerRuntimeLayerResourceSummary> {
  return processes.map((process) => ({
    processKey: `${process.role}:${process.pid ?? "missing"}:${process.commandLabel}`,
    role: process.role,
    pid: process.pid,
    currentRssBytes: process.rssBytes,
    maxRssBytes: process.rssBytes,
    currentCpuPercent: process.cpuPercent,
    avgCpuPercent: process.cpuPercent,
    maxCpuPercent: process.cpuPercent,
    sampleCount: process.pid === null ? 0 : 1,
    lastSeenAt: process.lastSeenAt,
  }));
}

function normalizeRecentEventRows(
  rows: ReadonlyArray<RecentEventTypeCountRow>,
): ReadonlyArray<ServerOrchestratorRecentEventTypeCount> {
  return rows.map((row) => ({
    eventType: row.eventType,
    actorKind: row.actorKind,
    count: row.count,
    lastSeenAt: row.lastSeenAt,
  }));
}

export const make = Effect.fn("makeRuntimeLayerDiagnostics")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionStateRepository = yield* ProjectionStateRepository;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const readLatestEventSequence = SqlSchema.findOne({
    Request: Schema.Void,
    Result: LatestEventSequenceRow,
    execute: () =>
      sql`
        SELECT COALESCE(MAX(sequence), 0) AS "latestEventSequence"
        FROM orchestration_events
      `,
  });

  const readRecentEventCounts = SqlSchema.findAll({
    Request: Schema.Struct({ limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
    Result: RecentEventTypeCountRow,
    execute: ({ limit }) =>
      sql`
        WITH recent AS (
          SELECT event_type, actor_kind, occurred_at
          FROM orchestration_events
          ORDER BY sequence DESC
          LIMIT ${limit}
        )
        SELECT
          event_type AS "eventType",
          actor_kind AS "actorKind",
          COUNT(*) AS "count",
          MAX(occurred_at) AS "lastSeenAt"
        FROM recent
        GROUP BY event_type, actor_kind
        ORDER BY COUNT(*) DESC, MAX(occurred_at) DESC
        LIMIT ${MAX_EVENT_TYPE_ROWS}
      `,
  });

  const readActiveTurnCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ActiveTurnCountsRow,
    execute: () =>
      sql`
        SELECT
          COALESCE(SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END), 0) AS "pendingTurnCount",
          COALESCE(SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END), 0) AS "runningTurnCount"
        FROM projection_turns
      `,
  });

  const readStaleStateCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: StaleStateCountsRow,
    execute: () =>
      sql`
        SELECT
          (
            SELECT COUNT(*)
            FROM projection_thread_sessions sessions
            JOIN projection_turns turns
              ON turns.thread_id = sessions.thread_id
             AND turns.turn_id = sessions.active_turn_id
            WHERE sessions.active_turn_id IS NOT NULL
              AND turns.state IN ('completed', 'error', 'interrupted')
          ) AS "terminalActiveSessionCount",
          (
            SELECT COUNT(*)
            FROM projection_thread_messages messages
            JOIN projection_turns turns
              ON turns.thread_id = messages.thread_id
             AND turns.turn_id = messages.turn_id
            WHERE messages.role = 'assistant'
              AND messages.is_streaming = 1
              AND turns.state IN ('completed', 'error', 'interrupted')
          ) AS "terminalStreamingMessageCount"
      `,
  });

  const readDaemonHealth = Effect.gen(function* () {
    const endpoint = config.providerDaemon ?? config.providerSupervisor;
    if (!endpoint) {
      return {
        health: null,
        configured: false,
        reachable: false,
        healthLatencyMs: null,
        error: "Provider daemon endpoint is not configured.",
      } as const;
    }

    const startedAt = performance.now();
    const healthResult = yield* Effect.tryPromise({
      try: () =>
        requestProviderDaemonJson(endpoint, PROVIDER_DAEMON_HEALTH_PATH, {
          timeoutMs: DAEMON_HEALTH_TIMEOUT_MS,
        }),
      catch: (cause) =>
        new RuntimeLayerDiagnosticsReadError({
          operation: "provider-daemon-health",
          detail: "Provider daemon health request failed.",
          cause,
        }),
    }).pipe(
      Effect.flatMap((response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return Effect.fail(
            new RuntimeLayerDiagnosticsReadError({
              operation: "provider-daemon-health",
              detail: `Provider daemon health returned HTTP ${response.statusCode}.`,
            }),
          );
        }
        return Effect.try({
          try: () => decodeProviderDaemonHealthJson(response.body),
          catch: (cause) =>
            new RuntimeLayerDiagnosticsReadError({
              operation: "provider-daemon-health",
              detail: "Provider daemon health payload did not match the expected schema.",
              cause,
            }),
        });
      }),
      Effect.result,
    );
    const healthLatencyMs = Math.round((performance.now() - startedAt) * 100) / 100;

    if (healthResult._tag === "Failure") {
      return {
        health: null,
        configured: true,
        reachable: false,
        healthLatencyMs,
        error: sanitizeError(healthResult.failure),
      } as const;
    }
    return {
      health: healthResult.success,
      configured: true,
      reachable: true,
      healthLatencyMs,
      error: null,
    } as const;
  });

  const read: RuntimeLayerDiagnosticsShape["read"] = (input = {}) =>
    Effect.gen(function* () {
      const readAtDate = yield* DateTime.now;
      const readAt = DateTime.formatIso(readAtDate);
      const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS;
      const bucketMs = input.bucketMs ?? DEFAULT_BUCKET_MS;
      const errors: Array<{ source: string; message: string }> = [];

      const [
        latestEventResult,
        eventCountsResult,
        activeTurnCountsResult,
        staleCountsResult,
        projectionCountsResult,
        projectorRowsResult,
        engineSnapshotResult,
        daemonHealth,
        processRowsResult,
      ] = yield* Effect.all(
        [
          readLatestEventSequence(undefined).pipe(
            Effect.mapError(toPersistenceSqlError("RuntimeLayerDiagnostics.latestEventSequence")),
            Effect.result,
          ),
          readRecentEventCounts({ limit: RECENT_EVENT_WINDOW_LIMIT }).pipe(
            Effect.mapError(toPersistenceSqlError("RuntimeLayerDiagnostics.recentEventCounts")),
            Effect.result,
          ),
          readActiveTurnCounts(undefined).pipe(
            Effect.mapError(toPersistenceSqlError("RuntimeLayerDiagnostics.activeTurnCounts")),
            Effect.result,
          ),
          readStaleStateCounts(undefined).pipe(
            Effect.mapError(toPersistenceSqlError("RuntimeLayerDiagnostics.staleStateCounts")),
            Effect.result,
          ),
          projectionSnapshotQuery.getCounts().pipe(Effect.result),
          projectionStateRepository.listAll().pipe(Effect.result),
          orchestrationEngine.diagnosticsSnapshot.pipe(Effect.result),
          readDaemonHealth,
          readProcessRows().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.result,
          ),
        ],
        { concurrency: "unbounded" },
      );

      const latestEventSequence =
        latestEventResult._tag === "Success" ? latestEventResult.success.latestEventSequence : 0;
      if (latestEventResult._tag === "Failure") {
        errors.push({
          source: "orchestration-events",
          message: sanitizeError(latestEventResult.failure),
        });
      }

      const eventCounts =
        eventCountsResult._tag === "Success"
          ? normalizeRecentEventRows(eventCountsResult.success)
          : [];
      if (eventCountsResult._tag === "Failure") {
        errors.push({
          source: "orchestration-events",
          message: sanitizeError(eventCountsResult.failure),
        });
      }

      const activeTurnCounts =
        activeTurnCountsResult._tag === "Success"
          ? activeTurnCountsResult.success
          : { pendingTurnCount: 0, runningTurnCount: 0 };
      if (activeTurnCountsResult._tag === "Failure") {
        errors.push({
          source: "projection-turns",
          message: sanitizeError(activeTurnCountsResult.failure),
        });
      }

      const staleCounts =
        staleCountsResult._tag === "Success"
          ? staleCountsResult.success
          : { terminalActiveSessionCount: 0, terminalStreamingMessageCount: 0 };
      if (staleCountsResult._tag === "Failure") {
        errors.push({
          source: "projection-stale-state",
          message: sanitizeError(staleCountsResult.failure),
        });
      }

      const projectionCounts =
        projectionCountsResult._tag === "Success"
          ? projectionCountsResult.success
          : { projectCount: 0, threadCount: 0 };
      if (projectionCountsResult._tag === "Failure") {
        errors.push({
          source: "projection-counts",
          message: sanitizeError(projectionCountsResult.failure),
        });
      }

      const projectorRows =
        projectorRowsResult._tag === "Success" ? projectorRowsResult.success : [];
      if (projectorRowsResult._tag === "Failure") {
        errors.push({
          source: "projection-cursors",
          message: sanitizeError(projectorRowsResult.failure),
        });
      }
      const projectorCursors = buildProjectorCursors({
        latestEventSequence,
        projectors: projectorRows,
      });
      const { projectionSequence, projectionLag } = buildProjectionProgress({
        latestEventSequence,
        projectorCursors,
      });

      const engineSnapshot =
        engineSnapshotResult._tag === "Success"
          ? engineSnapshotResult.success
          : {
              commandQueueDepth: 0,
              acceptedCommandCount: 0,
              rejectedCommandCount: 0,
              failedCommandCount: 0,
              commandReadModelSequence: 0,
            };
      if (engineSnapshotResult._tag === "Failure") {
        errors.push({
          source: "orchestrator-engine",
          message: sanitizeError(engineSnapshotResult.failure),
        });
      }

      const providerDaemon = mapProviderDaemonHealth(daemonHealth);
      const providerSupervisor = mapProviderSupervisorHealth({
        daemonHealth: daemonHealth.health,
        daemonConfigured: daemonHealth.configured,
        daemonReachable: daemonHealth.reachable,
      });
      const providerRuntimeIngestion = buildProviderRuntimeIngestionDiagnostics({
        daemonEventCursor:
          daemonHealth.health?.newestEventCursor ??
          daemonHealth.health?.eventCursor ??
          providerDaemon.eventCursor,
        lastDaemonEventAt: daemonHealth.health?.runtimeEvents?.lastEventAt ?? null,
        projectorCursors,
      });
      if (daemonHealth.error) {
        errors.push({ source: "provider-daemon", message: daemonHealth.error });
      }

      const rows = processRowsResult._tag === "Success" ? processRowsResult.success : [];
      if (processRowsResult._tag === "Failure") {
        errors.push({
          source: "process-table",
          message: sanitizeError(processRowsResult.failure),
        });
      }

      const targets: RuntimeProcessTarget[] = [
        {
          pid: process.pid,
          role: "backend",
          ownerKind: "backend-root",
          attribution: "main backend process",
        },
      ];
      if (providerDaemon.pid !== null) {
        targets.push({
          pid: providerDaemon.pid,
          role: "provider-daemon",
          ownerKind: "daemon-marker",
          attribution: "daemon health PID",
        });
      }
      if (providerSupervisor.pid !== null) {
        targets.push({
          pid: providerSupervisor.pid,
          role: "provider-supervisor",
          ownerKind: "supervisor-marker",
          attribution: "supervisor health PID",
        });
      }

      const subprocesses = buildRuntimeProcessEntries({
        rows,
        serverPid: process.pid,
        readAt,
        targets,
      });
      const activeTurnCount = activeTurnCounts.pendingTurnCount + activeTurnCounts.runningTurnCount;
      const staleStateFlags = buildStaleStateFlags({
        counts: staleCounts,
        daemonActiveStreams: providerDaemon.activeStreamCount,
        activeTurnCount,
      });
      const runtimeLayers = buildLayerSummaries({
        serverPid: process.pid,
        serverStartedAt: null,
        processes: subprocesses,
        daemon: providerDaemon,
        supervisor: providerSupervisor,
        orchestratorLag: projectionLag,
        readAt,
      });

      return {
        readAt,
        platform: process.platform,
        windowMs,
        bucketMs,
        collectionSource: "server-runtime",
        partialFailure: errors.length > 0,
        runtimeLayers,
        orchestrator: {
          latestEventSequence,
          projectionSequence,
          projectionLag,
          commandQueueDepth: engineSnapshot.commandQueueDepth,
          acceptedCommandCount: engineSnapshot.acceptedCommandCount,
          rejectedCommandCount: engineSnapshot.rejectedCommandCount,
          failedCommandCount: engineSnapshot.failedCommandCount,
          projectCount: projectionCounts.projectCount,
          threadCount: projectionCounts.threadCount,
          pendingTurnCount: activeTurnCounts.pendingTurnCount,
          runningTurnCount: activeTurnCounts.runningTurnCount,
          activeTurnCount,
          recentEventTypeCounts: eventCounts,
          projectorCursors,
          providerRuntimeIngestion,
          staleStateFlags,
        },
        subprocesses,
        providerDaemon,
        providerSupervisor,
        resources: {
          sampleIntervalMs: 0,
          retainedSampleCount: subprocesses.filter((process) => process.pid !== null).length,
          buckets: [],
          processes: buildResourceSummaries(subprocesses),
        },
        errors,
      } satisfies ServerRuntimeLayerDiagnosticsResult;
    });

  return RuntimeLayerDiagnostics.of({ read });
});

export const layer = Layer.effect(RuntimeLayerDiagnostics, make());
