import { createServer, type Server } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import type { NativeControlActivity } from "@cafecode/contracts";

export type NativeActivityEvent = {
  kind: "reading-controls" | "capturing" | "captured" | "using-pointer";
  target: NonNullable<NativeControlActivity["target"]>;
};

export function decodeNativeActivity(value: unknown): NativeActivityEvent {
  if (!value || typeof value !== "object") throw new Error("Invalid activity");
  const event = value as Record<string, unknown>;
  if (!["reading-controls", "capturing", "captured", "using-pointer"].includes(String(event.kind)))
    throw new Error("Invalid activity kind");
  const t = event.target as Record<string, unknown> | undefined;
  if (
    !t ||
    !["window", "display", "browser"].includes(String(t.scope)) ||
    typeof t.app !== "string" ||
    typeof t.title !== "string"
  )
    throw new Error("Invalid activity target");
  const b = t.bounds as Record<string, unknown> | undefined;
  if (
    !b ||
    ![b.x, b.y, b.width, b.height].every(
      (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 100_000,
    ) ||
    Number(b.width) <= 0 ||
    Number(b.height) <= 0
  )
    throw new Error("Invalid activity bounds");
  if (
    (t.scope === "window" || t.scope === "browser") &&
    (!Number.isSafeInteger(t.pid) ||
      Number(t.pid) <= 0 ||
      !Number.isSafeInteger(t.windowId) ||
      Number(t.windowId) <= 0)
  )
    throw new Error("Invalid window identity");
  // Only bounded display metadata survives this decoder. No arbitrary result,
  // input, clipboard, capture bytes, token or model-written status is retained.
  return {
    kind: event.kind as NativeActivityEvent["kind"],
    target: {
      scope: t.scope as "window" | "display" | "browser",
      app: t.app.slice(0, 160),
      title: t.title.slice(0, 160),
      ...(t.scope !== "display" ? { pid: Number(t.pid), windowId: Number(t.windowId) } : {}),
      visible: t.visible === true,
      ...(["visible", "occluded", "off-screen"].includes(String(t.visibilityReason))
        ? { visibilityReason: t.visibilityReason as "visible" | "occluded" | "off-screen" }
        : {}),
      bounds: { x: Number(b.x), y: Number(b.y), width: Number(b.width), height: Number(b.height) },
    },
  };
}

/** Private reverse channel: native capture waits for Electron's visible status
 * ACK. It carries metadata only and lives beside the exact owned helper socket. */
export class NativeActivityChannel {
  readonly token = randomBytes(32).toString("hex");
  private readonly server: Server;
  private readonly sockets = new Set<import("node:net").Socket>();
  readonly path: string;
  constructor(
    path: string,
    receive: (event: NativeActivityEvent) => Promise<readonly number[] | void>,
  ) {
    this.path = path;
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      socket.setTimeout(2500, () => socket.destroy());
      let bytes = Buffer.alloc(0);
      let processing = false;
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        if (processing) {
          socket.destroy();
          return;
        }
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > 4096) {
          socket.destroy();
          return;
        }
        const newline = bytes.indexOf(10);
        if (newline < 0) return;
        processing = true;
        void (async () => {
          try {
            if (newline !== bytes.length - 1) throw new Error("Unexpected trailing data");
            const value = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
            if (
              typeof value.token !== "string" ||
              !/^[a-f0-9]{64}$/u.test(value.token) ||
              !timingSafeEqual(Buffer.from(value.token), Buffer.from(this.token))
            )
              throw new Error("Unauthorized activity");
            const ids = (await receive(decodeNativeActivity(value))) ?? [];
            if (
              ids.length > 8 ||
              !ids.every((id) => Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff)
            )
              throw new Error("Invalid indicator identity");
            if (!socket.destroyed)
              socket.end(JSON.stringify({ ok: true, exclude_windows: ids }) + "\n");
          } catch {
            socket.end("refused\n");
          }
        })();
      });
    });
    this.server.maxConnections = 8;
  }
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      this.server.once("error", failed);
      this.server.listen(this.path, () => {
        this.server.off("error", failed);
        resolve();
      });
    });
    try {
      await fs.chmod(this.path, 0o600);
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
