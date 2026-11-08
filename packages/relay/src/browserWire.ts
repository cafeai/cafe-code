import type { Lifetime } from "./lifetime.ts";
import { PacketConnection, type RelayResources, type WireDriver } from "./wire.ts";
import { requireRelay } from "./errors.ts";

/**
 * Browser WebSocket exposes bufferedAmount rather than send completion. Retain
 * every charge until an observation of zero, or exact native close. This bounds
 * Cafe-owned queues; it cannot pre-limit the browser's inbound allocation.
 */
export function connectBrowser(url: string, resources: RelayResources): PacketConnection {
  const owner = resources.owners.reserve();
  requireRelay(owner, "BUSY");
  let socket: WebSocket;
  try {
    socket = new WebSocket(url, "cafe-relay.v1");
  } catch (error) {
    owner();
    throw error;
  }
  socket.binaryType = "arraybuffer";
  let lifetime: Lifetime;
  const writes = new Set<(success: boolean) => void>();
  let pollScheduled = false;
  const poll = () => {
    pollScheduled = false;
    if (!lifetime.active) return;
    if (socket.bufferedAmount === 0) {
      for (const done of writes) done(true);
      writes.clear();
    }
    if (writes.size && !pollScheduled) {
      pollScheduled = true;
      lifetime.later(10, poll);
    }
  };
  const driver: WireDriver = {
    install(callbacks, owner) {
      lifetime = owner;
      socket.addEventListener("error", callbacks.error);
      socket.addEventListener("open", callbacks.open, { once: true });
      socket.addEventListener(
        "close",
        () => {
          lifetime.retire();
          writes.clear();
          callbacks.close();
        },
        { once: true },
      );
      socket.addEventListener("message", (event) => {
        if (!(event.data instanceof ArrayBuffer)) {
          callbacks.error();
          return;
        }
        callbacks.message(new Uint8Array(event.data));
      });
    },
    send(bytes, done) {
      writes.add(done);
      // A private immutable copy prevents mutation while the browser queues IO.
      socket.send(bytes.slice());
      if (!pollScheduled) {
        pollScheduled = true;
        lifetime.later(10, poll);
      }
    },
    terminate: () => socket.close(1000),
  };
  return new PacketConnection(driver, resources, owner);
}
