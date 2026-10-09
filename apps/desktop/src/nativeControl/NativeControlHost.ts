import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  NATIVE_CONTROL_HOST_FILE,
  NATIVE_CONTROL_PATH,
  NATIVE_CONTROL_TOOLS,
  NATIVE_CONTROL_VERSION,
  nativeControlError,
  nativeControlTokenDigest,
  validateNativeToolCall,
  compactNativeToolResult,
  NATIVE_CONTROL_INSTRUCTIONS,
  type NativeToolResult,
  type NativeControlHostConnection,
} from "@cafecode/shared/nativeControl";
import type { NativeControlChatState, NativeControlState, ThreadId } from "@cafecode/contracts";
import { NativeDaemon, verifyNativeRuntime, type NativeDaemonConnection } from "./NativeDaemon.ts";
import { executeNativeControlTool } from "./NativeControlActions.ts";

export interface NativeController {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  session: (label: string) => Promise<NativeDaemonConnection>;
  health: () => Promise<NativeToolResult>;
}
interface Session {
  readonly previousGeneration: string | undefined;
  readonly id: string;
  readonly threadId: string;
  readonly providerInstanceId: string;
  readonly provider: "codex" | "claudeAgent" | "human";
  readonly expires: number;
  active: boolean;
  turnActive: boolean;
  revoked: boolean;
  connection?: NativeDaemonConnection | undefined;
  inFlight?: Promise<NativeToolResult> | undefined;
  releasing?: Promise<void> | undefined;
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.from(value as Uint8Array);
    size += chunk.length;
    if (size > 256 * 1024) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid control request.");
  return value as Record<string, unknown>;
}

/** Electron alone owns the native child and enable state. Provider capabilities
 * authorize a turn, never controller configuration or a model-picked chat ID. */
export class NativeControlHost {
  private readonly options: {
    stateDirectory: string;
    runtimeRoot: string;
    hostBundleId: string;
    controller?: NativeController;
    platform?: NodeJS.Platform;
  };
  private readonly generation = randomUUID();
  private readonly token = randomBytes(32).toString("hex");
  private readonly sessions = new Map<string, Session>();
  private readonly threadGenerations = new Map<string, string>();
  // User choices belong to the trusted local renderer, never the provider's
  // capability transport. Keep them across provider replacement in this app
  // session. Absence means off: a provider binding, draft promotion or newly
  // opened chat can never grant desktop access without the user's gesture.
  private readonly enabledThreads = new Set<string>();
  private policyRevision = 0;
  private readonly controller: NativeController;
  private readonly server = createServer((request, response) => {
    void this.handle(request, response);
  });
  private owner: Session | undefined;
  private enabled = false;
  private desiredEnabled = false;
  private phase: NativeControlState["phase"] = "off";
  private transition: Promise<void> | undefined;
  private url = "";
  private detail = "Enable local desktop control to connect Codex and Claude.";
  private closed = false;

  constructor(options: {
    stateDirectory: string;
    runtimeRoot: string;
    hostBundleId: string;
    controller?: NativeController;
    platform?: NodeJS.Platform;
  }) {
    this.options = options;
    this.controller =
      options.controller ?? new NativeDaemon(options.runtimeRoot, options.hostBundleId);
  }

  async listen(publish = true): Promise<NativeControlHostConnection> {
    if ((this.options.platform ?? process.platform) !== "darwin")
      throw new Error("Native desktop control is unavailable on this platform.");
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Native control listener is unavailable.");
    this.url = `http://127.0.0.1:${address.port}/native-control`;
    const connection = { generation: this.generation, url: this.url, token: this.token };
    const temporary = join(this.options.stateDirectory, `.native-control-${this.generation}.json`);
    let createdTemporary = false;
    try {
      if (publish) {
        await fs.mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 });
        const root = await fs.lstat(this.options.stateDirectory);
        if (
          !root.isDirectory() ||
          root.isSymbolicLink() ||
          (process.platform !== "win32" &&
            (root.uid !== process.getuid!() || (root.mode & 0o022) !== 0))
        )
          throw new Error("Cafe's desktop state directory is unavailable.");
        // Cafe's existing shared state directory is normally 0755. It need
        // not hide filenames; only its owner may publish the private 0600
        // capability below. Do not chmod the user's existing data directory.
        const path = join(this.options.stateDirectory, NATIVE_CONTROL_HOST_FILE);
        const existing = await fs.lstat(path).catch(() => undefined);
        if (
          existing &&
          (!existing.isFile() ||
            existing.isSymbolicLink() ||
            (process.platform !== "win32" &&
              (existing.uid !== process.getuid!() || (existing.mode & 0o077) !== 0)))
        )
          throw new Error("Private desktop connection publication is unsafe.");
        await fs.writeFile(temporary, `${JSON.stringify(connection)}\n`, {
          flag: "wx",
          mode: 0o600,
        });
        createdTemporary = true;
        await fs.rename(temporary, path);
      }
    } catch {
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
      if (createdTemporary) await fs.unlink(temporary).catch(() => undefined);
      throw new Error("Private native control publication failed.");
    }
    return connection;
  }

  async state(): Promise<NativeControlState> {
    const runtimeAvailable =
      (this.options.platform ?? process.platform) === "darwin" &&
      (this.options.controller !== undefined ||
        (await verifyNativeRuntime(this.options.runtimeRoot).then(
          () => true,
          () => false,
        )));
    return {
      platform: this.options.platform ?? process.platform,
      enabled: this.enabled,
      phase: this.phase,
      driverVersion: NATIVE_CONTROL_VERSION,
      runtimeAvailable,
      detail: this.detail,
    };
  }

  async setEnabled(enabled: boolean): Promise<NativeControlState> {
    if (this.closed) throw new Error("Desktop control host is closed.");
    if ((this.options.platform ?? process.platform) !== "darwin") return this.state();
    this.desiredEnabled = enabled;
    this.policyRevision++;
    if (!enabled) {
      this.enabled = false;
      for (const session of this.sessions.values()) session.turnActive = false;
    }
    const change = async () => {
      if (this.closed || this.desiredEnabled !== enabled) return;
      if (enabled && this.enabled) return;
      if (enabled) {
        this.phase = "starting";
        try {
          await this.controller.start();
          if (this.closed || !this.desiredEnabled) {
            await this.controller.stop();
            this.enabled = false;
            this.phase = "off";
            return;
          }
          this.enabled = true;
          this.phase = "ready";
          this.detail =
            "Local control is ready. Start a new Codex or Claude session, or normally stop/resume an existing one, to attach desktop tools.";
        } catch {
          this.enabled = false;
          this.phase = "error";
          this.detail =
            "Could not start the reviewed Cua runtime. Prepare it, then check native permissions and try again.";
        }
      } else {
        this.phase = "stopping";
        for (const session of this.sessions.values()) session.turnActive = false;
        try {
          if (this.owner) await this.release(this.owner);
          await this.controller.stop();
          this.phase = "off";
          this.detail = "Local desktop control is off.";
        } catch {
          this.phase = "error";
          this.detail =
            "Native controller cleanup remains incomplete. Restart Cafe before using desktop control.";
        }
      }
    };
    const transition = (this.transition ?? Promise.resolve()).then(change, change);
    this.transition = transition;
    try {
      await transition;
    } finally {
      if (this.transition === transition) this.transition = undefined;
    }
    return this.state();
  }

  async chatState(threadId: ThreadId): Promise<NativeControlChatState> {
    if (!threadId || threadId.length > 256) throw new Error("Invalid local chat identity.");
    const control = await this.state();
    // Runtime verification can yield while a second window changes policy.
    // Snapshot all admission state together afterward, and give the renderer
    // a revision so an older IPC/query acknowledgement cannot undo a new one.
    return {
      threadId,
      enabled: this.enabledThreads.has(threadId),
      revision: this.policyRevision,
      control: { ...control, enabled: this.enabled, phase: this.phase, detail: this.detail },
    };
  }

  async setChatEnabled(threadId: ThreadId, enabled: boolean): Promise<NativeControlChatState> {
    if (this.closed) throw new Error("Desktop control host is closed.");
    if (!threadId || threadId.length > 256) throw new Error("Invalid local chat identity.");
    if ((this.options.platform ?? process.platform) !== "darwin") return this.chatState(threadId);
    this.policyRevision++;
    if (enabled) {
      if (!this.enabledThreads.has(threadId) && this.enabledThreads.size >= 4096)
        throw new Error("Too many local computer-use choices. Restart Cafe before changing more.");
      this.enabledThreads.add(threadId);
    } else {
      // Revoke admission before any asynchronous cleanup. An in-flight action
      // may already have executed; wait for it, never cancel/replay its input.
      // Preserve the real provider turn's activity so re-enabling can work in
      // that same turn, while an independent end-turn still wins immediately.
      this.enabledThreads.delete(threadId);
      await Promise.all(
        [...this.sessions.values()]
          .filter((session) => session.threadId === threadId)
          .map((session) => this.release(session, false)),
      );
    }
    return this.chatState(threadId);
  }

  async diagnostics(): Promise<NativeToolResult> {
    if (!this.enabled)
      return nativeControlError(
        "Desktop control is off. Enable it in Settings → MCP → Local desktop control.",
      );
    try {
      return await this.controller.health();
    } catch {
      return nativeControlError(
        "Native permissions or controller health are unavailable. Refresh or disable/re-enable control.",
      );
    }
  }

  async preview(): Promise<NativeToolResult> {
    if (this.owner)
      return nativeControlError(
        "A conversation owns desktop control. Finish its turn before taking a test screenshot.",
      );
    const session: Session = {
      previousGeneration: undefined,
      id: randomUUID(),
      threadId: "human-preview",
      providerInstanceId: "human",
      provider: "human",
      expires: Date.now() + 30_000,
      active: true,
      turnActive: true,
      revoked: false,
    };
    try {
      return await this.call(session, "get_desktop_state", { max_image_dimension: 1280 });
    } finally {
      await this.release(session);
    }
  }

  private async release(session: Session, endTurn = true): Promise<void> {
    if (endTurn) session.turnActive = false;
    if (session.releasing) return session.releasing;
    const cleanup = async () => {
      await session.inFlight?.catch(() => undefined);
      const connection = session.connection;
      if (connection) {
        try {
          const ended = await connection.request({ method: "trusted_session_end" });
          if (ended.closed !== true) throw new Error("Native cleanup is still pending.");
        } catch {
          this.enabled = false;
          this.phase = "error";
          this.detail =
            "Native cleanup could not be acknowledged. The controller was stopped; no input was replayed.";
          await this.controller.stop();
        } finally {
          connection.close();
          session.connection = undefined;
        }
      }
      if (this.owner === session) this.owner = undefined;
    };
    const releasing = cleanup();
    session.releasing = releasing;
    try {
      await releasing;
    } finally {
      if (session.releasing === releasing) session.releasing = undefined;
    }
  }

  private call(session: Session, name: string, input: unknown): Promise<NativeToolResult> {
    let args: Record<string, unknown>;
    try {
      args = validateNativeToolCall(name, input);
    } catch {
      return Promise.resolve(nativeControlError("Unsupported desktop tool or reserved arguments."));
    }
    if (!this.enabled || this.phase !== "ready")
      return Promise.resolve(
        nativeControlError("Desktop control is off or unavailable. Enable it in Settings → MCP."),
      );
    if (!session.active || !session.turnActive || session.revoked || session.expires < Date.now())
      return Promise.resolve(
        nativeControlError(
          "This desktop tool is outside an active Cafe turn. Resume the conversation to reconnect.",
        ),
      );
    if (session.provider !== "human" && !this.enabledThreads.has(session.threadId))
      return Promise.resolve(
        nativeControlError("Computer use is off for this chat. Enable it in the composer."),
      );
    if (session.releasing || session.inFlight || (this.owner && this.owner !== session))
      return Promise.resolve(
        nativeControlError(
          "Desktop control is busy in another action or conversation. Wait for it to finish.",
        ),
      );
    if (name === "release_control")
      return this.release(session).then(() => ({
        content: [{ type: "text", text: "Desktop control released." }],
      }));
    if (name === "health") return this.diagnostics();
    this.owner = session;
    const operation = async (): Promise<NativeToolResult> => {
      try {
        // A short readable label identifies the provider and this specific
        // binding on Cua's native cursor. The SDK injects it into native calls;
        // no model-supplied label can substitute another session's identity.
        session.connection ??= await this.controller.session(
          `${session.provider === "claudeAgent" ? "Claude" : session.provider === "codex" ? "Codex" : "Cafe"} · ${session.id.slice(0, 8)}`,
        );
        if (
          !this.enabled ||
          !session.turnActive ||
          session.revoked ||
          (session.provider !== "human" && !this.enabledThreads.has(session.threadId))
        )
          return nativeControlError("Desktop access was revoked before the action started.");
        const connection = session.connection;
        const result = await executeNativeControlTool(
          name,
          args,
          async (nativeName, nativeArgs) => {
            // Composite navigation and automatic fallback retain the same owner
            // and must observe disable/end-turn between native subcalls.
            if (
              !this.enabled ||
              !session.turnActive ||
              session.revoked ||
              session.connection !== connection ||
              (session.provider !== "human" && !this.enabledThreads.has(session.threadId))
            )
              return nativeControlError("Desktop access was revoked before the action started.");
            return (await connection.request({
              method: "trusted_session_call",
              name: nativeName,
              args: nativeArgs,
            })) as unknown as NativeToolResult;
          },
        );
        return compactNativeToolResult(result);
      } catch {
        this.enabled = false;
        this.phase = "error";
        this.detail =
          "The native action's completion is uncertain. The controller was stopped; inspect the desktop before retrying.";
        await this.controller.stop();
        session.connection?.close();
        session.connection = undefined;
        return nativeControlError(this.detail);
      }
    };
    const result = operation();
    session.inFlight = result;
    return result.finally(() => {
      session.inFlight = undefined;
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, value?: unknown) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(value === undefined ? "" : JSON.stringify(value));
    };
    const raw = request.headers.authorization?.replace(/^Bearer /u, "") ?? "";
    const master =
      /^[a-f0-9]{64}$/u.test(raw) && timingSafeEqual(Buffer.from(raw), Buffer.from(this.token));
    try {
      if (
        this.closed ||
        request.method !== "POST" ||
        request.socket.remoteAddress !== "127.0.0.1"
      ) {
        send(403);
        return;
      }
      if (request.url === NATIVE_CONTROL_PATH) {
        const session = this.sessions.get(nativeControlTokenDigest(raw));
        if (!session || session.revoked || session.expires < Date.now()) {
          send(403);
          return;
        }
        const message = await requestBody(request);
        if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
          send(400);
          return;
        }
        if (message.id === undefined) {
          send(202);
          return;
        }
        let result: unknown;
        if (message.method === "initialize")
          result = {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "Cafe local desktop control", version: NATIVE_CONTROL_VERSION },
            instructions: NATIVE_CONTROL_INSTRUCTIONS,
          };
        else if (message.method === "ping") result = {};
        else if (message.method === "tools/list") result = { tools: NATIVE_CONTROL_TOOLS };
        else if (message.method === "tools/call") {
          const params = message.params as Record<string, unknown> | undefined;
          if (typeof params?.name !== "string") {
            send(400);
            return;
          }
          response.once("close", () => {
            if (!response.writableEnded && session.inFlight) {
              session.turnActive = false;
              this.enabled = false;
              this.phase = "error";
              this.detail =
                "Desktop input lost its response. The controller was stopped; inspect the desktop before retrying.";
              void this.controller.stop().catch(() => undefined);
            }
          });
          result = await this.call(session, params.name, params.arguments ?? {});
        } else {
          send(200, {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Unsupported desktop method." },
          });
          return;
        }
        send(200, { jsonrpc: "2.0", id: message.id, result });
        return;
      }
      if (!master || !request.url?.startsWith("/native-control/")) {
        send(403);
        return;
      }
      const body = await requestBody(request);
      if (request.url === "/native-control/bind") {
        if (
          (body.provider !== "codex" && body.provider !== "claudeAgent") ||
          typeof body.threadId !== "string" ||
          typeof body.providerInstanceId !== "string" ||
          body.threadId.length > 256 ||
          body.providerInstanceId.length > 256 ||
          this.sessions.size >= 1024
        ) {
          send(400);
          return;
        }
        const token = randomBytes(32).toString("hex");
        this.sessions.set(nativeControlTokenDigest(token), {
          previousGeneration: this.threadGenerations.get(body.threadId),
          id: randomUUID(),
          threadId: body.threadId,
          providerInstanceId: body.providerInstanceId,
          provider: body.provider,
          expires: Date.now() + 24 * 3600_000,
          active: false,
          turnActive: false,
          revoked: false,
        });
        send(200, {
          token,
          url: `${this.url.slice(0, -"/native-control".length)}${NATIVE_CONTROL_PATH}`,
        });
        return;
      }
      if (typeof body.token !== "string") {
        send(400);
        return;
      }
      const key = nativeControlTokenDigest(body.token);
      const session = this.sessions.get(key);
      if (!session || session.revoked || session.expires < Date.now()) {
        send(403);
        return;
      }
      switch (request.url) {
        case "/native-control/activate":
          if (session.active) break;
          if (this.threadGenerations.get(session.threadId) !== session.previousGeneration) {
            session.revoked = true;
            send(403);
            return;
          }
          this.threadGenerations.set(session.threadId, session.id);
          for (const previous of this.sessions.values())
            if (previous !== session && previous.threadId === session.threadId) {
              previous.revoked = true;
              await this.release(previous);
            }
          if (session.revoked || this.threadGenerations.get(session.threadId) !== session.id) {
            send(403);
            return;
          }
          session.active = true;
          break;
        case "/native-control/begin-turn":
          await session.releasing;
          session.turnActive = session.active;
          break;
        case "/native-control/end-turn":
          await this.release(session);
          break;
        case "/native-control/dispose":
          session.revoked = true;
          await this.release(session);
          this.sessions.delete(key);
          break;
        default:
          send(404);
          return;
      }
      send(200, {});
    } catch {
      if (!response.headersSent) send(503, { error: "Local desktop control is unavailable." });
      else response.end();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.enabled = false;
    this.desiredEnabled = false;
    for (const session of this.sessions.values()) {
      session.revoked = true;
      session.turnActive = false;
    }
    if (this.transition) await this.transition;
    if (this.owner) await this.release(this.owner);
    await this.controller.stop();
    this.sessions.clear();
    this.enabledThreads.clear();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    const path = join(this.options.stateDirectory, NATIVE_CONTROL_HOST_FILE);
    const current = await fs.readFile(path, "utf8").catch(() => undefined);
    if (current && JSON.parse(current).generation === this.generation) await fs.unlink(path);
  }
}
