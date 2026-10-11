import { DEFAULT_SERVER_SETTINGS, ServerSettings, WS_METHODS } from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __enableInMemoryClientTracingForTests,
  __resetClientTracingForTests,
} from "../observability/clientTracing";
import {
  getSlowRpcAckRequests,
  resetRequestLatencyStateForTests,
  setSlowRpcAckThresholdMsForTests,
} from "../rpc/requestLatencyState";
import {
  getWsConnectionStatus,
  getWsConnectionUiState,
  getWsReconnectDelayMsForRetry,
  recordWsConnectionTerminalError,
  resetWsConnectionStateForTests,
} from "../rpc/wsConnectionState";
import { computeNonTransportSubscriptionRetryDelayMs, WsTransport } from "./wsTransport";
import { createWsRpcClient } from "./wsRpcClient";

const encodeServerSettings = Schema.encodeSync(ServerSettings);

type WsEventType = "open" | "message" | "close" | "error";
type WsEvent = { code?: number; data?: unknown; reason?: string; type?: string };
type WsListener = (event?: WsEvent) => void;

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly url: string;
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  addEventListener(type: WsEventType, listener: WsListener) {
    const listeners = this.listeners.get(type) ?? new Set<WsListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: WsEventType, listener: WsListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: unknown) {
    this.emit("message", { data, type: "message" });
  }

  error() {
    this.emit("error", { type: "error" });
  }

  private emit(type: WsEventType, event?: WsEvent) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;
const transports: WsTransport[] = [];

function getSocket(): MockWebSocket {
  const socket = sockets.at(-1);
  if (!socket) {
    throw new Error("Expected a websocket instance");
  }
  return socket;
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let turn = 0; turn < 20; turn += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      // Subscription retries intentionally pass through `setTimeout`, even
      // when their configured delay is zero. Progress whichever timer system
      // the current test uses so this poll observes retries consistently on
      // every supported Node event-loop implementation.
      if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(0);
      } else {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
    }
  }
  throw lastError;
}

function createTransport(...args: ConstructorParameters<typeof WsTransport>): WsTransport {
  const transport = new WsTransport(...args);
  transports.push(transport);
  return transport;
}

beforeEach(() => {
  vi.useRealTimers();
  sockets.length = 0;
  transports.length = 0;
  resetRequestLatencyStateForTests();
  resetWsConnectionStateForTests();

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "http://localhost:3020",
        hostname: "localhost",
        port: "3020",
        protocol: "http:",
      },
      desktopBridge: undefined,
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { onLine: true },
  });

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(async () => {
  await Promise.allSettled(transports.map((transport) => transport.dispose()));
  transports.length = 0;
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
  resetRequestLatencyStateForTests();
  resetWsConnectionStateForTests();
  await __resetClientTracingForTests();
  vi.restoreAllMocks();
});

describe("WsTransport", () => {
  it("backs off repeated recoverable application stream failures", () => {
    expect(computeNonTransportSubscriptionRetryDelayMs(250, 1)).toBe(250);
    expect(computeNonTransportSubscriptionRetryDelayMs(250, 2)).toBe(500);
    expect(computeNonTransportSubscriptionRetryDelayMs(250, 3)).toBe(1_000);
    expect(computeNonTransportSubscriptionRetryDelayMs(250, 20)).toBe(10_000);
    expect(computeNonTransportSubscriptionRetryDelayMs(0, 20)).toBe(0);
  });

  it("normalizes root websocket urls to /ws and preserves query params", async () => {
    const transport = createTransport("ws://localhost:3020/?token=secret-token");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("ws://localhost:3020/ws?token=secret-token");
    await transport.dispose();
  });

  it("uses an explicit secure websocket base url", async () => {
    const transport = createTransport("wss://app.example.com");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("wss://app.example.com/ws");
    await transport.dispose();
  });

  it("uses an explicit insecure websocket base url for remote backends", async () => {
    const transport = createTransport("ws://192.168.1.44:3773");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("ws://192.168.1.44:3773/ws");
    await transport.dispose();
  });

  it("supports async websocket url providers", async () => {
    const transport = createTransport(async () => "wss://remote.example.com/?wsToken=dynamic");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("wss://remote.example.com/ws?wsToken=dynamic");
    await transport.dispose();
  });

  it("retries rejected URL acquisition without exposing its credential-bearing error", async () => {
    vi.useFakeTimers();
    const provider = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Rejected https://private.test/?token=secret-auth-value"))
      .mockResolvedValue("wss://remote.example.test/?wsToken=fresh-token");
    const onAttempt = vi.fn();
    const onError = vi.fn();
    const transport = createTransport(provider, { onAttempt, onError });

    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(provider).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(0);
    expect(onAttempt).toHaveBeenCalledOnce();
    expect(getWsConnectionStatus()).toMatchObject({
      attemptCount: 1,
      reconnectAttemptCount: 1,
      reconnectPhase: "waiting",
    });
    expect(JSON.stringify(onError.mock.calls)).not.toContain("secret-auth-value");
    expect(JSON.stringify(getWsConnectionStatus())).not.toContain("private.test");

    await vi.advanceTimersByTimeAsync(999);
    expect(provider).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(provider).toHaveBeenCalledTimes(2);
    expect(onAttempt).toHaveBeenCalledTimes(2);
    expect(getSocket().url).toBe("wss://remote.example.test/ws?wsToken=fresh-token");
    getSocket().open();
    await waitFor(() => expect(getWsConnectionStatus().phase).toBe("connected"));
    await transport.dispose();
  });

  it("keeps transient URL failures retrying at the capped delay until token acquisition recovers", async () => {
    vi.useFakeTimers();
    const provider = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("secret-token"));
    const onAttempt = vi.fn();
    const onError = vi.fn();
    const transport = createTransport(provider, { onAttempt, onError });

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await waitFor(() => expect(onError).toHaveBeenCalledTimes(attempt));
      expect(provider).toHaveBeenCalledTimes(attempt);
      expect(onAttempt).toHaveBeenCalledTimes(attempt);
      expect(onError).toHaveBeenCalledTimes(attempt);
      expect(getWsConnectionStatus()).toMatchObject({
        reconnectAttemptCount: attempt,
        reconnectPhase: "waiting",
      });
      const delay = getWsReconnectDelayMsForRetry(attempt - 1);
      if (delay !== null) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(provider).toHaveBeenCalledTimes(attempt);
        await vi.advanceTimersByTimeAsync(1);
      }
    }

    provider.mockResolvedValue("wss://remote.example.test/?wsToken=recovered-token");
    await vi.advanceTimersByTimeAsync(64_000);
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(provider).toHaveBeenCalledTimes(12);
    getSocket().open();
    await waitFor(() => expect(getWsConnectionStatus().phase).toBe("connected"));
    expect(JSON.stringify(onError.mock.calls)).not.toContain("secret-token");
    await transport.dispose();
  });

  it("fails an initially queued request on transient token failure without replaying it after recovery", async () => {
    vi.useFakeTimers();
    const provider = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("private transient rejection: token=secret-value"))
      .mockResolvedValue("wss://remote.example.test/?wsToken=recovered-token");
    const onError = vi.fn();
    const onRequestStart = vi.fn();
    const transport = createTransport(provider, { onError, onRequestStart });
    const requestSettled = vi.fn();
    const pendingRequest = transport
      .request((client) =>
        client[WS_METHODS.serverUpsertKeybinding]({
          command: "commandPalette.toggle",
          key: "ctrl+k",
        }),
      )
      .catch((error: unknown) => error)
      .then((result: unknown) => {
        requestSettled();
        return result;
      });
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(10);
    expect(onRequestStart).toHaveBeenCalledOnce();
    expect(requestSettled).toHaveBeenCalledOnce();
    expect(await pendingRequest).toBeInstanceOf(Error);

    await vi.advanceTimersByTimeAsync(990);
    await waitFor(() => expect(sockets).toHaveLength(1));
    getSocket().open();
    await waitFor(() => expect(getWsConnectionStatus().phase).toBe("connected"));
    expect(getSocket().sent).toHaveLength(0);
    expect(JSON.stringify(onError.mock.calls)).not.toContain("secret-value");
    await transport.dispose();
  });

  it("stops explicitly rejected URL authority and only tries again after a manual reconnect", async () => {
    vi.useFakeTimers();
    const sensitiveFailure = new Error("https://private.test/?bearer=secret-token");
    const provider = vi.fn<() => Promise<string>>().mockRejectedValue(sensitiveFailure);
    const shouldRetryUrlError = vi.fn(() => false);
    const onTerminalError = vi.fn();
    const onError = vi.fn();
    const onRequestStart = vi.fn();
    const transport = createTransport(provider, {
      shouldRetryUrlError,
      onTerminalError,
      onError,
      onRequestStart,
    });
    const requestSettled = vi.fn();
    const pendingRequest = transport
      .request((client) =>
        client[WS_METHODS.serverUpsertKeybinding]({
          command: "commandPalette.toggle",
          key: "ctrl+k",
        }),
      )
      .catch((error: unknown) => error)
      .then((result: unknown) => {
        requestSettled();
        return result;
      });

    await waitFor(() => expect(onTerminalError).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(10);
    expect({
      starts: onRequestStart.mock.calls.length,
      settles: requestSettled.mock.calls.length,
    }).toEqual({ starts: 1, settles: 1 });
    expect(await pendingRequest).toBeInstanceOf(Error);
    expect(shouldRetryUrlError).toHaveBeenCalledWith(sensitiveFailure);
    expect(onError).not.toHaveBeenCalled();
    expect(getWsConnectionStatus()).toMatchObject({
      attemptCount: 1,
      reconnectPhase: "exhausted",
      nextRetryAt: null,
    });
    expect(JSON.stringify(onTerminalError.mock.calls)).not.toContain("secret-token");
    expect(JSON.stringify(getWsConnectionStatus())).not.toContain("private.test");
    await vi.advanceTimersByTimeAsync(256_000);
    expect(provider).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(0);

    provider.mockResolvedValue("wss://remote.example.test/?wsToken=explicit-retry-token");
    await transport.reconnect();
    await waitFor(() => expect(sockets).toHaveLength(1));
    getSocket().open();
    await waitFor(() => expect(getWsConnectionStatus().phase).toBe("connected"));
    expect(provider).toHaveBeenCalledTimes(2);
    await transport.dispose();
  });

  it("ignores rejected URL acquisition belonging to a replaced session", async () => {
    let rejectFirst!: (error: Error) => void;
    const firstUrl = new Promise<string>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const provider = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(firstUrl)
      .mockResolvedValue("wss://remote.example.test/?wsToken=current-token");
    const onError = vi.fn();
    const transport = createTransport(provider, { onError });
    await waitFor(() => expect(provider).toHaveBeenCalledOnce());
    await transport.reconnect();
    await waitFor(() => expect(sockets).toHaveLength(1));
    getSocket().open();
    await waitFor(() => expect(getWsConnectionStatus().phase).toBe("connected"));

    rejectFirst(new Error("stale credential failure"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(onError).not.toHaveBeenCalled();
    expect(getWsConnectionStatus().phase).toBe("connected");
    expect(provider).toHaveBeenCalledTimes(2);
    await transport.dispose();
  });

  it.each(["invalid-url?token=secret-value", "https://private.test/?token=secret-value"])(
    "treats an invalid asynchronously resolved URL as terminal without exposing it: %s",
    async (invalidUrl) => {
      vi.useFakeTimers();
      const provider = vi.fn<() => Promise<string>>().mockResolvedValue(invalidUrl);
      const onTerminalError = vi.fn();
      const transport = createTransport(provider, { onTerminalError });
      const pendingRequest = transport
        .request((client) =>
          client[WS_METHODS.serverUpsertKeybinding]({
            command: "commandPalette.toggle",
            key: "ctrl+k",
          }),
        )
        .catch((error: unknown) => error);
      await waitFor(() => expect(onTerminalError).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(10);
      expect(await pendingRequest).toBeInstanceOf(Error);
      expect(getWsConnectionStatus().reconnectPhase).toBe("exhausted");
      await vi.advanceTimersByTimeAsync(256_000);
      expect(provider).toHaveBeenCalledOnce();
      expect(sockets).toHaveLength(0);
      expect(JSON.stringify(onTerminalError.mock.calls)).not.toContain("secret-value");
      await transport.dispose();
    },
  );

  it("stops a browser constructor policy rejection with a credential-free typed error", async () => {
    vi.useFakeTimers();
    const constructor = vi.fn(() => {
      throw new Error("private constructor rejection: token=secret-value");
    });
    globalThis.WebSocket = constructor as unknown as typeof WebSocket;
    const onTerminalError = vi.fn();
    const transport = createTransport("wss://remote.example.test", { onTerminalError });
    await waitFor(() => expect(onTerminalError).toHaveBeenCalledOnce());
    expect(getWsConnectionStatus()).toMatchObject({
      attemptCount: 1,
      reconnectPhase: "exhausted",
      retryDelayMs: null,
    });
    await vi.advanceTimersByTimeAsync(256_000);
    expect(constructor).toHaveBeenCalledOnce();
    expect(JSON.stringify(onTerminalError.mock.calls)).not.toContain("secret-value");
    await transport.dispose();
  });

  it("tracks initial connection failures for the app error state", async () => {
    const transport = createTransport("ws://localhost:3020");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    expect(getWsConnectionStatus()).toMatchObject({
      attemptCount: 1,
      phase: "connecting",
      socketUrl: "ws://localhost:3020/ws",
    });

    socket.error();
    socket.close(1006, "server unavailable");

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        closeCode: 1006,
        closeReason: "server unavailable",
        hasConnected: false,
        lastError: "Unable to connect to the Cafe Code server WebSocket.",
        phase: "disconnected",
      });
    });
    expect(getWsConnectionUiState(getWsConnectionStatus())).toBe("error");

    await transport.dispose();
  });

  it("enforces the socket-open deadline and rejects its queued request before retrying", async () => {
    vi.useFakeTimers();
    const onSessionStart = vi.fn();
    const transport = createTransport("ws://localhost:3020", { onSessionStart });
    const requestSettled = vi.fn();
    const pendingRequest = transport
      .request((client) =>
        client[WS_METHODS.serverUpsertKeybinding]({
          command: "commandPalette.toggle",
          key: "ctrl+k",
        }),
      )
      .catch((error: unknown) => error)
      .then((result: unknown) => {
        requestSettled();
        return result;
      });
    await waitFor(() => expect(sockets).toHaveLength(1));
    const unopenedSocket = getSocket();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(requestSettled).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => expect(requestSettled).toHaveBeenCalledOnce());
    expect(await pendingRequest).toBeInstanceOf(Error);
    expect(unopenedSocket.sent).toHaveLength(0);
    expect(unopenedSocket.readyState).toBe(MockWebSocket.CLOSED);
    expect(getWsConnectionStatus()).toMatchObject({
      heartbeatTimeoutCount: 0,
      reconnectPhase: "waiting",
      retryDelayMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => expect(sockets).toHaveLength(2));
    getSocket().open();
    await waitFor(() => expect(getWsConnectionStatus().phase).toBe("connected"));
    // The protocol may flush its own queued Ping when the writer opens; an
    // application Request from the failed attempt must never accompany it.
    expect(
      getSocket().sent.filter((message) => JSON.parse(message)._tag === "Request"),
    ).toHaveLength(0);
    expect(onSessionStart).toHaveBeenCalledOnce();
    await transport.dispose();
  });

  it("surfaces reconnecting state after a live socket disconnects", async () => {
    const transport = createTransport("ws://localhost:3020");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        hasConnected: true,
        phase: "connected",
      });
    });

    socket.close(1013, "try again later");

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        closeReason: "try again later",
        hasConnected: true,
      });
    });
    expect(getWsConnectionUiState(getWsConnectionStatus())).toBe("reconnecting");

    await transport.dispose();
  });

  it("refreshes the real retry budget across more than eight healthy socket lifetimes", async () => {
    vi.useFakeTimers();
    const onHeartbeatPong = vi.fn();
    const transport = createTransport("ws://localhost:3020", { onHeartbeatPong });
    await waitFor(() => expect(sockets).toHaveLength(1));

    for (let cycle = 0; cycle < 10; cycle += 1) {
      const socket = getSocket();
      socket.open();
      await waitFor(() => expect(getWsConnectionStatus().phase).toBe("connected"));
      socket.serverMessage(JSON.stringify({ _tag: "Pong" }));
      await waitFor(() => expect(onHeartbeatPong).toHaveBeenCalledTimes(cycle + 1));
      // These are completed socket lifetimes, not repeated failed opens. Each
      // healthy connection restores the outage backoff and its first delay.
      socket.close(1012, "synthetic restart");
      await vi.advanceTimersByTimeAsync(999);
      expect(sockets).toHaveLength(cycle + 1);
      await vi.advanceTimersByTimeAsync(1);
      await waitFor(() => expect(sockets).toHaveLength(cycle + 2));
    }

    getSocket().open();
    await waitFor(() => expect(getWsConnectionStatus().phase).toBe("connected"));
    await transport.dispose();
  });

  it("keeps the exact capped backoff alive beyond eight continuously failed sockets", async () => {
    vi.useFakeTimers();
    const transport = createTransport("ws://localhost:3020");
    await waitFor(() => expect(sockets).toHaveLength(1));

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const socket = getSocket();
      socket.error();
      socket.close(1006, "synthetic unavailable");
      await waitFor(() =>
        expect(getWsConnectionStatus()).toMatchObject({
          reconnectAttemptCount: attempt,
          reconnectPhase: "waiting",
        }),
      );
      const delay = getWsReconnectDelayMsForRetry(attempt - 1);
      if (delay !== null) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(sockets).toHaveLength(attempt);
        await vi.advanceTimersByTimeAsync(1);
        await waitFor(() => expect(sockets).toHaveLength(attempt + 1));
      }
    }

    expect(sockets).toHaveLength(11);
    getSocket().open();
    await waitFor(() => expect(getWsConnectionStatus().phase).toBe("connected"));
    expect(getWsConnectionStatus()).toMatchObject({
      reconnectAttemptCount: 1,
      reconnectPhase: "idle",
      reconnectMaxAttempts: null,
    });
    expect(getWsConnectionStatus().nextRetryAt).toBeNull();
    await transport.dispose();
  });

  it("composes custom lifecycle handlers with default websocket state tracking", async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const transport = createTransport("ws://localhost:3020", {
      onOpen,
      onClose,
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(onOpen).toHaveBeenCalledOnce();
      expect(getWsConnectionStatus()).toMatchObject({
        hasConnected: true,
        phase: "connected",
      });
    });

    // The retry policy intentionally waits one second in production. Drive the
    // Effect clock's host timer explicitly so this unit test does not spend a
    // real second proving the configured reconnect transition.
    vi.useFakeTimers();
    socket.close(1012, "service restart");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onClose).toHaveBeenCalledWith(
      {
        code: 1012,
        reason: "service restart",
      },
      {
        intentional: false,
      },
    );
    expect(getWsConnectionStatus()).toMatchObject({
      attemptCount: 2,
      closeReason: "service restart",
      phase: "connecting",
    });

    vi.useRealTimers();
    await transport.dispose();
  });

  it("does not let an auxiliary transport overwrite primary connection status", async () => {
    const primary = createTransport("ws://localhost:3020", {
      getConnectionLabel: () => "Primary workspace",
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const primarySocket = getSocket();
    primarySocket.open();
    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        connectionLabel: "Primary workspace",
        hasConnected: true,
        phase: "connected",
      });
    });

    const onOpen = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();
    const auxiliary = createTransport("ws://remote.example.test", {
      trackGlobalConnectionStatus: false,
      getConnectionLabel: () => "Saved workspace",
      onOpen,
      onError,
      onClose,
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });
    // Merely starting an auxiliary connection must not regress the primary
    // singleton from connected to connecting.
    expect(getWsConnectionStatus()).toMatchObject({
      connectionLabel: "Primary workspace",
      phase: "connected",
    });

    const auxiliarySocket = getSocket();
    auxiliarySocket.open();
    await waitFor(() => {
      expect(onOpen).toHaveBeenCalledOnce();
    });
    expect(getWsConnectionStatus()).toMatchObject({
      connectionLabel: "Primary workspace",
      phase: "connected",
    });

    auxiliarySocket.error();
    auxiliarySocket.close(1013, "saved workspace unavailable");
    await waitFor(() => {
      expect(onError).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalled();
    });
    expect(getWsConnectionStatus()).toMatchObject({
      connectionLabel: "Primary workspace",
      phase: "connected",
    });
    expect(getWsConnectionUiState(getWsConnectionStatus())).toBe("connected");

    await auxiliary.dispose();
    await primary.dispose();
  });

  it("keeps primary terminal state intact when an actual saved-environment client retries", async () => {
    const savedTransport = createTransport("wss://saved.example.test", {
      trackGlobalConnectionStatus: false,
    });
    const savedClient = createWsRpcClient(savedTransport);
    await waitFor(() => expect(sockets).toHaveLength(1));
    recordWsConnectionTerminalError("Primary connection configuration was rejected.");
    const primaryBeforeRetry = getWsConnectionStatus();
    await savedClient.reconnect();
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(getWsConnectionStatus()).toEqual(primaryBeforeRetry);
    getSocket().open();
    await waitFor(() => expect(getSocket().readyState).toBe(MockWebSocket.OPEN));
    expect(getWsConnectionStatus()).toEqual(primaryBeforeRetry);
    await savedClient.dispose();
  });

  it("does not report an intentional dispose as a reconnectable disconnect", async () => {
    const onClose = vi.fn();
    const transport = createTransport("ws://localhost:3020", {
      getConnectionLabel: () => "Remote Mac mini",
      onClose,
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        connectionLabel: "Remote Mac mini",
        hasConnected: true,
        phase: "connected",
      });
    });

    await transport.dispose();

    expect(onClose).not.toHaveBeenCalled();
    expect(getWsConnectionStatus()).toMatchObject({
      connectionLabel: "Remote Mac mini",
      phase: "connected",
      reconnectPhase: "idle",
    });
  });

  it("reconnects the websocket session without disposing the transport", async () => {
    const transport = createTransport("ws://localhost:3020");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const firstSocket = getSocket();
    firstSocket.open();

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        hasConnected: true,
        phase: "connected",
      });
    });

    await transport.reconnect();

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    const secondSocket = getSocket();
    expect(secondSocket).not.toBe(firstSocket);
    expect(firstSocket.readyState).toBe(MockWebSocket.CLOSED);
    expect(getWsConnectionStatus()).toMatchObject({
      closeCode: null,
      closeReason: null,
      phase: "connecting",
    });

    const requestPromise = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({
        command: "commandPalette.toggle",
        key: "ctrl+k",
      }),
    );

    secondSocket.open();

    await waitFor(() => {
      expect(secondSocket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(secondSocket.sent[0] ?? "{}") as { id: string };
    secondSocket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: {
            keybindings: [],
            issues: [],
          },
        },
      }),
    );

    await expect(requestPromise).resolves.toEqual({
      keybindings: [],
      issues: [],
    });

    await transport.dispose();
  });

  it("reports first-open and reconnect events per transport", async () => {
    const transport = createTransport("ws://localhost:3020");
    const opened = vi.fn();
    const unsubscribe = transport.subscribeConnectionOpened(opened);

    await waitFor(() => expect(sockets).toHaveLength(1));
    getSocket().open();
    await waitFor(() =>
      expect(opened).toHaveBeenLastCalledWith({ openCount: 1, reconnected: false }),
    );

    await transport.reconnect();
    await waitFor(() => expect(sockets).toHaveLength(2));
    getSocket().open();
    await waitFor(() =>
      expect(opened).toHaveBeenLastCalledWith({ openCount: 2, reconnected: true }),
    );

    unsubscribe();
    expect(opened).toHaveBeenCalledTimes(2);
  });

  it("recycles a missing-Pong socket and restores requests/subscriptions without replaying a lost mutation", async () => {
    vi.useFakeTimers();
    const onHeartbeatPing = vi.fn();
    const onHeartbeatPong = vi.fn();
    const onHeartbeatTimeout = vi.fn();
    const onSessionStart = vi.fn();
    const transport = createTransport("ws://localhost:3020", {
      onHeartbeatPing,
      onHeartbeatPong,
      onHeartbeatTimeout,
      onSessionStart,
    });
    const listener = vi.fn();
    const onResubscribe = vi.fn();
    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
      { onResubscribe },
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    const firstSocket = getSocket();
    firstSocket.open();
    await waitFor(() => expect(firstSocket.sent).toHaveLength(1));
    const firstRequest = JSON.parse(firstSocket.sent[0] ?? "{}") as { id: string };
    const welcomeEvent = {
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: {
        environment: {
          environmentId: "environment-local",
          label: "Local environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        cwd: "/tmp/heartbeat-fixture",
        projectName: "heartbeat-fixture",
      },
    };
    firstSocket.serverMessage(
      JSON.stringify({ _tag: "Chunk", requestId: firstRequest.id, values: [welcomeEvent] }),
    );
    await waitFor(() => expect(listener).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(5_000);
    expect(onHeartbeatPing).toHaveBeenCalledOnce();
    expect(firstSocket.sent.some((message) => JSON.parse(message)._tag === "Ping")).toBe(true);
    firstSocket.serverMessage(JSON.stringify({ _tag: "Pong" }));
    await waitFor(() => expect(onHeartbeatPong).toHaveBeenCalledOnce());
    expect(transport.isHeartbeatFresh()).toBe(true);
    // Effect.forever yields between iterations, and the fake host scheduler
    // can place that yield one millisecond after the first deadline.
    await vi.advanceTimersByTimeAsync(5_010);
    expect(onHeartbeatPing).toHaveBeenCalledTimes(2);
    const lostMutationResult = transport
      .request((client) =>
        client[WS_METHODS.serverUpsertKeybinding]({
          command: "commandPalette.toggle",
          key: "ctrl+k",
        }),
      )
      .catch((error: unknown) => error);
    await waitFor(() =>
      expect(
        firstSocket.sent.filter((message) => JSON.parse(message)._tag === "Request"),
      ).toHaveLength(2),
    );
    await vi.advanceTimersByTimeAsync(5_010);
    await waitFor(() => expect(onHeartbeatTimeout).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(onHeartbeatTimeout).toHaveBeenCalledOnce();
    expect(onSessionStart).toHaveBeenCalledOnce();
    expect(getWsConnectionStatus()).toMatchObject({ heartbeatTimeoutCount: 1 });
    expect(getWsConnectionStatus().lastHeartbeatTimeoutAt).not.toBeNull();
    expect(firstSocket.readyState).toBe(MockWebSocket.CLOSED);
    expect(transport.isHeartbeatFresh()).toBe(false);
    expect(await lostMutationResult).toBeInstanceOf(Error);

    const replacement = getSocket();
    replacement.open();
    await vi.advanceTimersByTimeAsync(250);
    await waitFor(() =>
      expect(
        replacement.sent.filter((message) => JSON.parse(message)._tag === "Request"),
      ).toHaveLength(1),
    );
    // The hook fences a fresh snapshot when each subscription attempt starts,
    // including fast failures while the protocol waits for its socket retry.
    // Only one actual stream request reaches the replacement socket above.
    expect(onResubscribe).toHaveBeenCalled();
    const replacementRequest = replacement.sent
      .map((message) => JSON.parse(message) as { _tag: string; id?: string })
      .find((message) => message._tag === "Request");
    replacement.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: replacementRequest?.id,
        values: [{ ...welcomeEvent, sequence: 2 }],
      }),
    );
    await waitFor(() => expect(listener).toHaveBeenCalledTimes(2));

    // Delayed events from the retired generation must not update freshness or
    // connection truth after the new authenticated session has been selected.
    firstSocket.serverMessage(JSON.stringify({ _tag: "Pong" }));
    firstSocket.close(1006, "stale heartbeat close");
    firstSocket.open();
    firstSocket.error();
    expect(onHeartbeatPong).toHaveBeenCalledOnce();
    expect(transport.isHeartbeatFresh()).toBe(false);
    expect(getWsConnectionStatus().phase).toBe("connected");
    const freshMutation = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({
        command: "commandPalette.toggle",
        key: "ctrl+j",
      }),
    );
    await waitFor(() =>
      expect(
        replacement.sent.filter((message) => JSON.parse(message)._tag === "Request"),
      ).toHaveLength(2),
    );
    const freshRequest = replacement.sent
      .map((message) => JSON.parse(message) as { _tag: string; id?: string; tag?: string })
      .find((message) => message.tag === WS_METHODS.serverUpsertKeybinding);
    replacement.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: freshRequest?.id,
        exit: { _tag: "Success", value: { keybindings: [], issues: [] } },
      }),
    );
    await expect(freshMutation).resolves.toEqual({ keybindings: [], issues: [] });
    unsubscribe();
    await transport.dispose();
    await vi.advanceTimersByTimeAsync(128_000);
    expect(sockets).toHaveLength(2);
  });

  it("keeps malformed JSON a live-peer failure rather than a local terminal handler defect", async () => {
    const onTerminalError = vi.fn();
    const onRetryScheduled = vi.fn();
    const transport = createTransport("ws://localhost:3020", {
      onTerminalError,
      onRetryScheduled,
    });
    const failedRequest = transport
      .request((client) =>
        client[WS_METHODS.serverUpsertKeybinding]({
          command: "commandPalette.toggle",
          key: "ctrl+k",
        }),
      )
      .catch((error: unknown) => error);
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = getSocket();
    socket.open();
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.serverMessage("{");
    expect(await failedRequest).toBeInstanceOf(Error);
    expect(onTerminalError).not.toHaveBeenCalled();
    expect(onRetryScheduled).not.toHaveBeenCalled();
    expect(getWsConnectionStatus().phase).toBe("connected");
    const freshRequest = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({
        command: "commandPalette.toggle",
        key: "ctrl+j",
      }),
    );
    await waitFor(() => expect(socket.sent).toHaveLength(2));
    const freshMessage = JSON.parse(socket.sent[1] ?? "{}") as { id: string };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: freshMessage.id,
        exit: { _tag: "Success", value: { keybindings: [], issues: [] } },
      }),
    );
    await expect(freshRequest).resolves.toEqual({ keybindings: [], issues: [] });
    expect(sockets).toHaveLength(1);
    await transport.dispose();
  });

  it("marks a real typed response defect terminal and recovers only through an explicit fresh session", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onTerminalError = vi.fn();
    const onRetryScheduled = vi.fn();
    const onSessionStart = vi.fn();
    const transport = createTransport("ws://localhost:3020", {
      onTerminalError,
      onRetryScheduled,
      onSessionStart,
    });
    const rpcClient = createWsRpcClient(transport);
    const listener = vi.fn();
    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    const firstSocket = getSocket();
    firstSocket.open();
    await waitFor(() => expect(firstSocket.sent).toHaveLength(1));
    const firstRequest = JSON.parse(firstSocket.sent[0] ?? "{}") as { id: string };
    const lostMutation = transport
      .request((client) =>
        client[WS_METHODS.serverUpsertKeybinding]({
          command: "commandPalette.toggle",
          key: "ctrl+k",
        }),
      )
      .catch((error: unknown) => error);
    await waitFor(() => expect(firstSocket.sent).toHaveLength(2));
    // Valid JSON reaches the actual typed stream decoder. Its schema defect
    // ends the handler generation, unlike malformed JSON's live-peer failure
    // broadcast. No fake lifecycle callback substitutes for that distinction.
    firstSocket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: firstRequest.id,
        values: ["invalid-event?token=private-response"],
      }),
    );
    await waitFor(() => expect(onTerminalError).toHaveBeenCalledOnce());
    expect(await lostMutation).toBeInstanceOf(Error);
    expect(getWsConnectionStatus()).toMatchObject({
      reconnectPhase: "exhausted",
      nextRetryAt: null,
      retryDelayMs: null,
    });
    expect(JSON.stringify(onTerminalError.mock.calls)).not.toContain("private-response");
    expect(JSON.stringify(getWsConnectionStatus())).not.toContain("private-response");
    expect(warnSpy).toHaveBeenCalledWith("WebSocket RPC subscription failed", {
      error: "The WebSocket RPC subscription failed.",
      retrying: false,
    });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("private-response");
    await vi.advanceTimersByTimeAsync(256_000);
    expect(sockets).toHaveLength(1);
    expect(onRetryScheduled).not.toHaveBeenCalled();

    unsubscribe();
    await rpcClient.reconnect();
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(onSessionStart).toHaveBeenCalledTimes(2);
    const replacement = getSocket();
    // A schema-invalid stream is deliberately not automatically replayed.
    // Explicit retry restores a fresh protocol scope for a new subscription.
    const unsubscribeReplacement = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
    );
    replacement.open();
    await vi.advanceTimersByTimeAsync(250);
    await waitFor(() =>
      expect(
        replacement.sent.filter((message) => JSON.parse(message)._tag === "Request"),
      ).toHaveLength(1),
    );
    const replacementRequest = replacement.sent
      .map((message) => JSON.parse(message) as { _tag: string; id?: string; tag?: string })
      .find((message) => message._tag === "Request");
    expect(replacementRequest?.tag).toBe(WS_METHODS.subscribeServerLifecycle);
    replacement.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: replacementRequest?.id,
        values: [
          {
            version: 1,
            sequence: 1,
            type: "welcome",
            payload: {
              environment: {
                environmentId: "environment-local",
                label: "Local environment",
                platform: { os: "darwin", arch: "arm64" },
                serverVersion: "0.0.0-test",
                capabilities: { repositoryIdentity: true },
              },
              cwd: "/tmp/protocol-defect-fixture",
              projectName: "protocol-defect-fixture",
            },
          },
        ],
      }),
    );
    await waitFor(() => expect(listener).toHaveBeenCalledOnce());
    firstSocket.serverMessage(JSON.stringify({ _tag: "Pong" }));
    firstSocket.close(1006, "obsolete generation");
    expect(getWsConnectionStatus().phase).toBe("connected");
    expect(onTerminalError).toHaveBeenCalledOnce();
    // Only an explicitly submitted new mutation is allowed on this scope;
    // recovery above has sent the critical stream, not the lost mutation.
    const freshMutation = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({
        command: "commandPalette.toggle",
        key: "ctrl+j",
      }),
    );
    await waitFor(() =>
      expect(
        replacement.sent.filter((message) => JSON.parse(message)._tag === "Request"),
      ).toHaveLength(2),
    );
    const freshRequest = replacement.sent
      .map((message) => JSON.parse(message) as { id?: string; tag?: string })
      .find((message) => message.tag === WS_METHODS.serverUpsertKeybinding);
    replacement.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: freshRequest?.id,
        exit: { _tag: "Success", value: { keybindings: [], issues: [] } },
      }),
    );
    await expect(freshMutation).resolves.toEqual({ keybindings: [], issues: [] });
    unsubscribeReplacement();
    await rpcClient.dispose();
    await vi.advanceTimersByTimeAsync(128_000);
    expect(sockets).toHaveLength(2);
  });

  it("backs off repeated open-without-Pong sockets using the actual scheduled deadlines", async () => {
    vi.useFakeTimers();
    const onHeartbeatTimeout = vi.fn();
    const onRetryScheduled = vi.fn();
    const onSessionStart = vi.fn();
    const transport = createTransport("ws://localhost:3020", {
      onHeartbeatTimeout,
      onRetryScheduled,
      onSessionStart,
    });
    await waitFor(() => expect(sockets).toHaveLength(1));

    for (let cycle = 0; cycle < 3; cycle += 1) {
      getSocket().open();
      await waitFor(() => expect(getWsConnectionStatus().phase).toBe("connected"));
      // Drive the actual Effect pinger, socket cancellation and retry fibers.
      // Timer order is left to the host scheduler; no private recovery method
      // or forged lifecycle callback stands in for the protocol timeout.
      for (let timer = 0; timer < 20 && onRetryScheduled.mock.calls.length <= cycle; timer += 1) {
        await vi.advanceTimersToNextTimerAsync();
      }
      expect(onHeartbeatTimeout).toHaveBeenCalledTimes(cycle + 1);
      expect(onRetryScheduled).toHaveBeenCalledTimes(cycle + 1);
      const scheduled = onRetryScheduled.mock.calls[cycle]?.[0] as {
        retryIndex: number;
        delayMs: number;
        nextRetryAt: string;
      };
      expect(scheduled).toMatchObject({ retryIndex: cycle, delayMs: 1_000 * 2 ** cycle });
      expect(getWsConnectionStatus()).toMatchObject({
        reconnectAttemptCount: cycle + 1,
        nextRetryAt: scheduled.nextRetryAt,
        reconnectPhase: "waiting",
        retryDelayMs: scheduled.delayMs,
      });
      const remainingMs = Date.parse(scheduled.nextRetryAt) - Date.now();
      expect(remainingMs).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(remainingMs - 1);
      expect(sockets).toHaveLength(cycle + 1);
      await vi.advanceTimersByTimeAsync(1);
      await waitFor(() => expect(sockets).toHaveLength(cycle + 2));
    }

    expect(onSessionStart).toHaveBeenCalledOnce();
    await transport.dispose();
    await vi.advanceTimersByTimeAsync(256_000);
    expect(sockets).toHaveLength(4);
  });

  it("ignores stale socket lifecycle events after a reconnect starts a new session", async () => {
    const onClose = vi.fn();
    const transport = createTransport("ws://localhost:3020", { onClose });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const firstSocket = getSocket();
    firstSocket.open();

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        hasConnected: true,
        phase: "connected",
      });
    });

    await transport.reconnect();

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(getWsConnectionStatus()).toMatchObject({
      closeCode: null,
      closeReason: null,
      phase: "connecting",
    });

    const secondSocket = getSocket();
    secondSocket.open();

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        phase: "connected",
      });
    });

    firstSocket.close(1006, "stale close");

    expect(onClose).not.toHaveBeenCalled();
    expect(getWsConnectionStatus()).toMatchObject({
      closeCode: null,
      closeReason: null,
      phase: "connected",
    });

    await transport.dispose();
  });

  it("ignores stale socket close events after the transport is disposed", async () => {
    const onClose = vi.fn();
    const transport = createTransport("ws://localhost:3020", { onClose });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const firstSocket = getSocket();
    firstSocket.open();

    await waitFor(() => {
      expect(getWsConnectionStatus()).toMatchObject({
        hasConnected: true,
        phase: "connected",
      });
    });

    await transport.reconnect();

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    const secondSocket = getSocket();
    secondSocket.open();
    await transport.dispose();

    onClose.mockClear();
    firstSocket.close(1006, "stale close after dispose");

    expect(onClose).not.toHaveBeenCalled();
  });

  it("marks unary requests as slow until the first server ack arrives", async () => {
    const slowAckThresholdMs = 25;
    setSlowRpcAckThresholdMsForTests(slowAckThresholdMs);
    const transport = createTransport("ws://localhost:3020");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();
    vi.useFakeTimers();
    const requestPromise = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({
        command: "commandPalette.toggle",
        key: "ctrl+k",
      }),
    );

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    await vi.advanceTimersByTimeAsync(slowAckThresholdMs);
    expect(getSlowRpcAckRequests()).toMatchObject([
      {
        requestId: requestMessage.id,
        tag: WS_METHODS.serverUpsertKeybinding,
      },
    ]);

    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: {
            keybindings: [],
            issues: [],
          },
        },
      }),
    );

    await expect(requestPromise).resolves.toEqual({
      keybindings: [],
      issues: [],
    });
    expect(getSlowRpcAckRequests()).toEqual([]);

    await transport.dispose();
  }, 5_000);

  it("clears slow unary request tracking when the transport reconnects", async () => {
    const slowAckThresholdMs = 25;
    setSlowRpcAckThresholdMsForTests(slowAckThresholdMs);
    const transport = createTransport("ws://localhost:3020");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const firstSocket = getSocket();
    firstSocket.open();
    vi.useFakeTimers();
    const requestPromise = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({
        command: "commandPalette.toggle",
        key: "ctrl+k",
      }),
    );

    await waitFor(() => {
      expect(firstSocket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(firstSocket.sent[0] ?? "{}") as { id: string };

    await vi.advanceTimersByTimeAsync(slowAckThresholdMs);
    expect(getSlowRpcAckRequests()).toMatchObject([
      {
        requestId: firstRequest.id,
        tag: WS_METHODS.serverUpsertKeybinding,
      },
    ]);

    void requestPromise.catch(() => undefined);

    vi.useRealTimers();
    await transport.reconnect();

    expect(getSlowRpcAckRequests()).toEqual([]);

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    const secondSocket = getSocket();
    secondSocket.open();

    await transport.dispose();
  }, 5_000);

  it("sends unary RPC requests and resolves successful exits", async () => {
    const transport = createTransport("ws://localhost:3020");

    const requestPromise = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({
        command: "commandPalette.toggle",
        key: "ctrl+k",
      }),
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as {
      _tag: string;
      id: string;
      payload: unknown;
      tag: string;
    };
    expect(requestMessage).toMatchObject({
      _tag: "Request",
      tag: WS_METHODS.serverUpsertKeybinding,
      payload: {
        command: "commandPalette.toggle",
        key: "ctrl+k",
      },
    });

    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: {
            keybindings: [],
            issues: [],
          },
        },
      }),
    );

    await expect(requestPromise).resolves.toEqual({
      keybindings: [],
      issues: [],
    });

    await transport.dispose();
  });

  it("delivers stream chunks to subscribers", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as { id: string; tag: string };
    expect(requestMessage.tag).toBe(WS_METHODS.subscribeServerLifecycle);

    const welcomeEvent = {
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: {
        environment: {
          environmentId: "environment-local",
          label: "Local environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        cwd: "/tmp/workspace",
        projectName: "workspace",
      },
    };

    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: requestMessage.id,
        values: [welcomeEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenCalledWith(welcomeEvent);
    });

    unsubscribe();
    await transport.dispose();
  });

  it("re-subscribes stream listeners after the stream exits", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();
    const onResubscribe = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
      { onResubscribe },
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: firstRequest.id,
        values: [
          {
            version: 1,
            sequence: 1,
            type: "welcome",
            payload: {
              environment: {
                environmentId: "environment-local",
                label: "Local environment",
                platform: { os: "darwin", arch: "arm64" },
                serverVersion: "0.0.0-test",
                capabilities: { repositoryIdentity: true },
              },
              cwd: "/tmp/one",
              projectName: "one",
            },
          },
        ],
      }),
    );
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: firstRequest.id,
        exit: {
          _tag: "Success",
          value: null,
        },
      }),
    );

    await waitFor(() => {
      const nextRequest = socket.sent
        .map((message) => JSON.parse(message) as { _tag?: string; id?: string })
        .find((message) => message._tag === "Request" && message.id !== firstRequest.id);
      expect(nextRequest).toBeDefined();
    });
    expect(onResubscribe).toHaveBeenCalledOnce();

    const secondRequest = socket.sent
      .map((message) => JSON.parse(message) as { _tag?: string; id?: string; tag?: string })
      .find(
        (message): message is { _tag: "Request"; id: string; tag: string } =>
          message._tag === "Request" && message.id !== firstRequest.id,
      );
    if (!secondRequest) {
      throw new Error("Expected a resubscribe request");
    }
    expect(secondRequest.tag).toBe(WS_METHODS.subscribeServerLifecycle);
    expect(secondRequest.id).not.toBe(firstRequest.id);

    const secondEvent = {
      version: 1,
      sequence: 2,
      type: "welcome",
      payload: {
        environment: {
          environmentId: "environment-local",
          label: "Local environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        cwd: "/tmp/two",
        projectName: "two",
      },
    };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: secondRequest.id,
        values: [secondEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(secondEvent);
    });

    unsubscribe();
    await transport.dispose();
  });

  it("re-subscribes live stream listeners after an explicit transport reconnect", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();
    const onResubscribe = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
      { onResubscribe },
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const firstSocket = getSocket();
    firstSocket.open();

    await waitFor(() => {
      expect(firstSocket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(firstSocket.sent[0] ?? "{}") as { id: string };
    const firstEvent = {
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: {
        environment: {
          environmentId: "environment-local",
          label: "Local environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        cwd: "/tmp/one",
        projectName: "one",
      },
    };

    firstSocket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: firstRequest.id,
        values: [firstEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(firstEvent);
    });

    await transport.reconnect();

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    const secondSocket = getSocket();
    expect(secondSocket).not.toBe(firstSocket);
    expect(firstSocket.readyState).toBe(MockWebSocket.CLOSED);

    secondSocket.open();

    await waitFor(() => {
      expect(secondSocket.sent).toHaveLength(1);
    });

    const secondRequest = JSON.parse(secondSocket.sent[0] ?? "{}") as {
      id: string;
      tag: string;
    };
    expect(secondRequest.tag).toBe(WS_METHODS.subscribeServerLifecycle);
    expect(secondRequest.id).not.toBe(firstRequest.id);
    expect(onResubscribe).toHaveBeenCalledOnce();

    const secondEvent = {
      version: 1,
      sequence: 2,
      type: "welcome",
      payload: {
        environment: {
          environmentId: "environment-local",
          label: "Local environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        cwd: "/tmp/two",
        projectName: "two",
      },
    };

    secondSocket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: secondRequest.id,
        values: [secondEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(secondEvent);
    });

    unsubscribe();
    await transport.dispose();
  });

  it("does not fire onResubscribe when the first stream attempt exits before any value", async () => {
    const transport = createTransport("ws://localhost:3020");
    const listener = vi.fn();
    const onResubscribe = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
      { onResubscribe },
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: firstRequest.id,
        exit: {
          _tag: "Success",
          value: null,
        },
      }),
    );

    await waitFor(() => {
      const nextRequest = socket.sent
        .map((message) => JSON.parse(message) as { _tag?: string; id?: string })
        .find((message) => message._tag === "Request" && message.id !== firstRequest.id);
      expect(nextRequest).toBeDefined();
    });
    expect(onResubscribe).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
    await transport.dispose();
  });

  it("does not retry stream subscriptions after application-level failures", async () => {
    const transport = createTransport("ws://localhost:3020");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let attempts = 0;

    const unsubscribe = transport.subscribe(
      () =>
        Stream.suspend(() => {
          attempts += 1;
          return Stream.fail(new Error("Git command failed in GitCore.statusDetails"));
        }),
      vi.fn(),
      { retryDelay: 10 },
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    getSocket().open();

    await waitFor(() => {
      expect(attempts).toBe(1);
    });
    await Promise.resolve();

    expect(attempts).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith("WebSocket RPC subscription failed", {
      error: "The WebSocket RPC subscription failed.",
      retrying: false,
    });
    expect(warnSpy).not.toHaveBeenCalledWith(
      "WebSocket RPC subscription disconnected",
      expect.anything(),
    );

    unsubscribe();
    await transport.dispose();
  });

  it("retries stream subscriptions after application-level failures when requested", async () => {
    const transport = createTransport("ws://localhost:3020");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let attempts = 0;

    const unsubscribe = transport.subscribe(
      () =>
        Stream.suspend(() => {
          attempts += 1;
          return Stream.fail(new Error("Server stream projection failed"));
        }),
      vi.fn(),
      { retryDelay: 0, retryNonTransportErrors: true },
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    getSocket().open();

    await waitFor(() => {
      expect(attempts).toBeGreaterThanOrEqual(2);
    });
    expect(warnSpy).toHaveBeenCalledWith("WebSocket RPC subscription failed", {
      error: "The WebSocket RPC subscription failed.",
      retrying: true,
    });

    unsubscribe();
    await transport.dispose();
  });

  it("keeps retrying stream subscriptions after transport failures", async () => {
    const transport = createTransport("ws://localhost:3020");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let attempts = 0;

    const unsubscribe = transport.subscribe(
      () =>
        Stream.suspend(() => {
          attempts += 1;
          return Stream.fail(new Error("SocketCloseError: WebSocket closed"));
        }),
      vi.fn(),
      { retryDelay: 0 },
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    getSocket().open();

    await waitFor(() => {
      expect(attempts).toBeGreaterThanOrEqual(2);
    });

    expect(warnSpy).toHaveBeenCalledWith("WebSocket RPC subscription disconnected", {
      error: "SocketCloseError: WebSocket closed",
    });

    unsubscribe();
    await transport.dispose();
  });

  it("logs a transport disconnect once even when multiple subscriptions fail together", async () => {
    const transport = createTransport("ws://localhost:3020");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const unsubscribeA = transport.subscribe(
      () => Stream.fail(new Error("SocketCloseError: 1006")),
      vi.fn(),
      { retryDelay: 10 },
    );
    const unsubscribeB = transport.subscribe(
      () => Stream.fail(new Error("SocketCloseError: 1006")),
      vi.fn(),
      { retryDelay: 10 },
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    getSocket().open();

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
    expect(warnSpy).toHaveBeenCalledWith("WebSocket RPC subscription disconnected", {
      error: "SocketCloseError: 1006",
    });

    unsubscribeA();
    unsubscribeB();
    await transport.dispose();
  });

  it("closes the client scope on the transport runtime before disposing the runtime", async () => {
    const callOrder: string[] = [];
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });

    const runtime = {
      runPromise: vi.fn(async () => {
        callOrder.push("close:start");
        await closePromise;
        callOrder.push("close:done");
        return undefined;
      }),
      dispose: vi.fn(async () => {
        callOrder.push("runtime:dispose");
      }),
    };
    const transport = {
      disposed: false,
      openListeners: new Set(),
      session: {
        clientScope: {} as never,
        runtime,
      },
      closeSession: (
        WsTransport.prototype as unknown as {
          closeSession: (session: {
            clientScope: unknown;
            runtime: { dispose: () => Promise<void>; runPromise: () => Promise<void> };
          }) => Promise<void>;
        }
      ).closeSession,
    } as unknown as WsTransport;

    void WsTransport.prototype.dispose.call(transport);

    expect(runtime.runPromise).toHaveBeenCalledTimes(1);
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect((transport as unknown as { disposed: boolean }).disposed).toBe(true);

    resolveClose();

    await waitFor(() => {
      expect(runtime.dispose).toHaveBeenCalledTimes(1);
    });

    expect(callOrder).toEqual(["close:start", "close:done", "runtime:dispose"]);
  });

  it("propagates OTLP trace ids for ws transport requests when client tracing is enabled", async () => {
    await __enableInMemoryClientTracingForTests();

    const transport = createTransport("ws://localhost:3020");
    const requestPromise = transport.request((client) => client[WS_METHODS.serverGetSettings]({}));

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as {
      id: string;
      spanId?: string;
      traceId?: string;
    };
    expect(requestMessage.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(requestMessage.spanId).toMatch(/^[0-9a-f]{16}$/);

    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: encodeServerSettings(DEFAULT_SERVER_SETTINGS),
        },
      }),
    );

    await expect(requestPromise).resolves.toEqual(DEFAULT_SERVER_SETTINGS);
    await transport.dispose();
  });
});
