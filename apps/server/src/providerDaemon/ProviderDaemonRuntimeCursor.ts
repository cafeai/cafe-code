import type { ProviderRuntimeEvent } from "@cafecode/contracts";

export const PROVIDER_DAEMON_RUNTIME_CURSOR_PROJECTOR = "provider-daemon-runtime-ingestion";
export const PROVIDER_SUPERVISOR_RUNTIME_CURSOR_PROJECTOR = "provider-supervisor-runtime-ingestion";

const PROVIDER_DAEMON_RUNTIME_EVENT_CURSOR_PROPERTY = "__cafecodeProviderDaemonCursor";

type ProviderRuntimeEventWithDaemonCursor = ProviderRuntimeEvent & {
  readonly [PROVIDER_DAEMON_RUNTIME_EVENT_CURSOR_PROPERTY]?: number;
};

function normalizeCursor(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function rewindProviderDaemonCursorForReplay(cursor: number, overlap: number): number {
  return Math.max(0, normalizeCursor(cursor) - normalizeCursor(overlap));
}

export function attachProviderDaemonRuntimeEventCursor(
  event: ProviderRuntimeEvent,
  cursor: number,
): ProviderRuntimeEvent {
  const eventWithCursor = { ...event } as ProviderRuntimeEventWithDaemonCursor;
  Object.defineProperty(eventWithCursor, PROVIDER_DAEMON_RUNTIME_EVENT_CURSOR_PROPERTY, {
    value: normalizeCursor(cursor),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return eventWithCursor;
}

export function readProviderDaemonRuntimeEventCursor(
  event: ProviderRuntimeEvent,
): number | undefined {
  const cursor = (event as ProviderRuntimeEventWithDaemonCursor)[
    PROVIDER_DAEMON_RUNTIME_EVENT_CURSOR_PROPERTY
  ];
  return typeof cursor === "number" && Number.isFinite(cursor) && cursor >= 0
    ? Math.trunc(cursor)
    : undefined;
}
