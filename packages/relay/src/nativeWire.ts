// @effect-diagnostics nodeBuiltinImport:off
// Native WebSocket adapter: callbacks/close and TLS are owned here. No provider,
// credential store, global HTTP hook or application process lifecycle is used.
import { Buffer } from "node:buffer";
import WebSocket from "ws";
import { PacketConnection, type RelayResources, type WireDriver } from "./wire.ts";
import { RELAY_LIMITS } from "./limits.ts";
import { requireRelay } from "./errors.ts";
import { monotonicMillis } from "./lifetime.ts";
import { randomOpaque, utf8 } from "./bytes.ts";
import type { LookupFunction } from "node:net";

export function nativeDriver(socket: WebSocket): WireDriver {
  // Keep this handler for the native object's complete lifetime, including
  // queued errors after termination. The forwarding owner is installed below.
  let fail = () => {};
  socket.on("error", () => fail());
  return {
    install(callbacks, lifetime) {
      fail = callbacks.error;
      let lastPong = monotonicMillis(),
        pending: string | undefined;
      socket.on("pong", (bytes) => {
        if (lifetime.active && pending && bytes.equals(Buffer.from(utf8.encode(pending)))) {
          lastPong = monotonicMillis();
          pending = undefined;
        }
      });
      const heartbeat = () => {
        if (!lifetime.active) return;
        if (monotonicMillis() - lastPong >= RELAY_LIMITS.pongMs) {
          callbacks.error();
          return;
        }
        if (!pending) {
          pending = randomOpaque(16);
          try {
            socket.ping(utf8.encode(pending));
          } catch {
            callbacks.error();
            return;
          }
        }
        lifetime.later(RELAY_LIMITS.pingMs, heartbeat);
      };
      const opened = () => {
        if (!lifetime.active) return;
        lastPong = monotonicMillis();
        lifetime.later(RELAY_LIMITS.pingMs, heartbeat);
        callbacks.open();
      };
      socket.on("close", callbacks.close);
      socket.on("message", (data, binary) => {
        if (!binary || Array.isArray(data)) {
          callbacks.error();
          return;
        }
        const bytes = Buffer.isBuffer(data) ? data : new Uint8Array(data);
        callbacks.message(bytes);
      });
      if (socket.readyState === WebSocket.OPEN) opened();
      else if (socket.readyState === WebSocket.CLOSED) callbacks.close();
      else socket.once("open", opened);
    },
    send: (bytes, flushed) =>
      socket.send(bytes, { binary: true, compress: false }, (error) => flushed(!error)),
    terminate: () => socket.terminate(),
  };
}

export function connectNative(
  url: string,
  resources: RelayResources,
  options: {
    readonly servername?: string;
    readonly ca?: string;
    readonly lookup?: LookupFunction;
  } = {},
): PacketConnection {
  const owner = resources.owners.reserve();
  requireRelay(owner, "BUSY");
  try {
    const socket = new WebSocket(url, "cafe-relay.v1", {
      perMessageDeflate: false,
      maxPayload: RELAY_LIMITS.outerBytes,
      handshakeTimeout: RELAY_LIMITS.handshakeMs,
      followRedirects: false,
      ...options,
    });
    return new PacketConnection(nativeDriver(socket), resources, owner);
  } catch (error) {
    owner();
    throw error;
  }
}
