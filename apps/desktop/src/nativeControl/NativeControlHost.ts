import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  NATIVE_CONTROL_HOST_FILE,
  NATIVE_CONTROL_PATH,
  NATIVE_CONTROL_DEFAULT_TOOLS,
  NATIVE_CONTROL_VERSION,
  nativeControlError,
  nativeControlValidationError,
  type ComputerInputPolicy,
  nativeControlTokenDigest,
  validateNativeToolCall,
  compactNativeToolResult,
  NATIVE_CONTROL_INSTRUCTIONS,
  type NativeToolResult,
  type NativeControlHostConnection,
} from "@cafecode/shared/nativeControl";
import type {
  NativeControlChatState,
  NativeControlState,
  NativeControlActivity,
  ThreadId,
} from "@cafecode/contracts";
import { decodeNativeActivity, type NativeActivityEvent } from "./NativeActivityChannel.ts";
import { NativeDaemon, verifyNativeRuntime, type NativeDaemonConnection } from "./NativeDaemon.ts";
import { NativeComputerSession } from "./NativeComputerSession.ts";

export interface NativeController {
  start: () => Promise<void>;
  stop: (options?: { readonly force?: boolean }) => Promise<void>;
  session: (label: string) => Promise<NativeDaemonConnection>;
  health: () => Promise<NativeToolResult>;
  windowInfo?: (pid: number, windowId: number) => Promise<Record<string, unknown>>;
}
export interface NativeControlVisibility {
  update: (activity: NativeControlActivity) => Promise<void>;
  close: () => Promise<void>;
  windowIds?: () => readonly number[];
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
  computer?: NativeComputerSession | undefined;
  inFlight?: Promise<NativeToolResult> | undefined;
  cancelOperation?: ((detail?: string) => void) | undefined;
  releasing?: Promise<void> | undefined;
}

export const NATIVE_CONTROL_OPERATION_TIMEOUT_MS = 15_000;

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
    operationTimeoutMs?: number;
    inputPolicy?: ComputerInputPolicy;
    visibility?: NativeControlVisibility;
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
  private controllerEpoch = 0;
  private halted: Promise<void> | undefined;
  private interruptedOperationCount = 0;
  private timedOutOperationCount = 0;
  private lastOperationDurationMs = 0;
  private inputPolicy: ComputerInputPolicy;
  private activityValue: NativeControlActivity = {
    version: 1,
    generation: this.generation,
    sequence: 0,
    episode: null,
    threadId: null,
    provider: null,
    providerInstanceId: null,
    phase: "inactive",
    target: null,
    inputPolicy: "foreground-allowed",
    inputRoute: "unknown",
    usingSystemPointer: false,
    lastCaptureAt: null,
  };
  private readonly activityListeners = new Set<(activity: NativeControlActivity) => void>();
  private nativePhase: "controlling" | "reading-controls" = "reading-controls";
  private geometryRevision = 0;

  constructor(options: {
    stateDirectory: string;
    runtimeRoot: string;
    hostBundleId: string;
    controller?: NativeController;
    platform?: NodeJS.Platform;
    operationTimeoutMs?: number;
    inputPolicy?: ComputerInputPolicy;
    visibility?: NativeControlVisibility;
  }) {
    if (
      (options.platform ?? process.platform) === "darwin" &&
      !options.controller &&
      !options.visibility
    )
      throw new Error("Native control requires visible activity surfaces.");
    this.options = options;
    this.inputPolicy = options.inputPolicy ?? "foreground-allowed";
    this.controller =
      options.controller ??
      new NativeDaemon(options.runtimeRoot, options.hostBundleId, (event) =>
        this.receiveNativeActivity(event),
      );
  }

  activity(): NativeControlActivity {
    return this.activityValue;
  }
  subscribeActivity(listener: (activity: NativeControlActivity) => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }
  async setInputPolicy(policy: ComputerInputPolicy): Promise<void> {
    // A trusted user restriction cancels outstanding input before taking effect.
    this.inputPolicy = policy;
    if (this.owner?.inFlight) await this.release(this.owner, false);
    await this.publishActivity({ inputPolicy: policy });
  }
  async stopActivity(episode: string): Promise<void> {
    const owner = this.owner;
    if (!owner || this.activityValue.episode !== episode) return;
    if (owner.provider !== "human") this.enabledThreads.delete(owner.threadId);
    this.policyRevision++;
    await this.release(owner, false);
  }
  async refreshActivityTarget(episode: string): Promise<void> {
    const t = this.activityValue.target;
    if (
      !this.owner ||
      episode !== this.activityValue.episode ||
      !t?.pid ||
      !t.windowId ||
      !this.controller.windowInfo
    )
      return;
    const revision = ++this.geometryRevision;
    const value = await this.controller.windowInfo(t.pid, t.windowId);
    if (
      revision !== this.geometryRevision ||
      this.activityValue.target !== t ||
      episode !== this.activityValue.episode ||
      this.activityValue.phase === "stopping"
    )
      return;
    if (value.closed === true) {
      await this.publishActivity({ target: { ...t, visible: false } });
      return;
    }
    const target = decodeNativeActivity({
      kind: "reading-controls",
      target: { ...value, scope: t.scope },
    }).target;
    if (this.activityValue.target?.windowId !== t.windowId) return;
    if (JSON.stringify(target) !== JSON.stringify(this.activityValue.target))
      await this.publishActivity({ target });
  }
  private async publishActivity(update: Partial<NativeControlActivity>): Promise<void> {
    const next = { ...this.activityValue, ...update, sequence: this.activityValue.sequence + 1 };
    this.activityValue = next;
    await this.options.visibility?.update(next);
    if (this.activityValue.sequence === next.sequence)
      for (const listener of this.activityListeners) listener(next);
  }
  private async retireActivity(session?: Session): Promise<void> {
    if (session && this.owner && this.owner !== session) return;
    if (session && this.activityValue.threadId !== session.threadId) return;
    await this.publishActivity({
      episode: null,
      threadId: null,
      provider: null,
      providerInstanceId: null,
      phase: "inactive",
      target: null,
      inputRoute: "unknown",
      usingSystemPointer: false,
      lastCaptureAt: null,
    });
  }
  private async receiveNativeActivity(event: NativeActivityEvent): Promise<readonly number[]> {
    const owner = this.owner;
    const epoch = this.controllerEpoch;
    if (
      !owner?.inFlight ||
      !this.enabled ||
      !owner.turnActive ||
      owner.revoked ||
      this.activityValue.phase === "stopping"
    )
      throw new Error("Activity authority revoked");
    await this.publishActivity({
      target: event.target,
      phase:
        event.kind === "captured"
          ? this.nativePhase
          : event.kind === "using-pointer"
            ? "controlling"
            : event.kind,
      ...(event.kind === "using-pointer"
        ? { inputRoute: "hid" as const, usingSystemPointer: true }
        : {}),
      ...(event.kind === "captured" ? { lastCaptureAt: Date.now() } : {}),
    });
    if (
      epoch !== this.controllerEpoch ||
      this.owner !== owner ||
      !owner.turnActive ||
      !this.enabled ||
      (owner.provider !== "human" && !this.enabledThreads.has(owner.threadId))
    )
      throw new Error("Activity authority revoked");
    return this.options.visibility?.windowIds?.() ?? [];
  }
  private async beforeNativeCall(
    session: Session,
    name: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    const read =
      name.startsWith("get_") ||
      name.startsWith("list_") ||
      name === "clipboard_read" ||
      name === "verify_state";
    this.nativePhase = read ? "reading-controls" : "controlling";
    const context = session.computer?.activityTarget;
    const pid = Number(args.pid ?? context?.pid);
    const wid = Number(args.window_id ?? context?.window_id);
    let target = this.activityValue.target;
    if (Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(wid) && wid > 0) {
      if (this.controller.windowInfo && (target?.pid !== pid || target.windowId !== wid)) {
        const value = await this.controller.windowInfo(pid, wid);
        if (value.closed === true) throw new Error("Target closed before dispatch");
        target = decodeNativeActivity({ kind: "reading-controls", target: value }).target;
      } else if (target?.pid !== pid || target.windowId !== wid)
        target = { scope: "window", pid, windowId: wid, app: `App ${pid}`, title: `Window ${wid}` };
    } else if (args.scope === "desktop" || name === "get_desktop_state")
      target = { scope: "display", app: "Main display", title: "Whole main display" };
    else if (args.tab_id)
      target = { scope: "browser", app: "Connected browser", title: "Selected tab" };
    const route: NativeControlActivity["inputRoute"] = read
      ? this.activityValue.inputRoute
      : name.startsWith("browser_")
        ? "browser"
        : name === "scroll"
          ? "pid"
          : args.element_token || name === "set_value" || name === "invoke_menu"
            ? "accessibility"
            : args.delivery_mode === "foreground" || args.scope === "desktop"
              ? "hid"
              : "pid";
    const pointer =
      route === "hid" &&
      ["click", "right_click", "double_click", "drag", "move_cursor"].includes(name);
    await this.publishActivity({
      phase:
        name === "get_browser_state" && args.include_screenshot === true
          ? "capturing"
          : this.nativePhase,
      target,
      inputRoute: route,
      usingSystemPointer: pointer,
    });
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
      diagnostics: {
        operationTimeoutMs: this.operationTimeoutMs,
        activeOperationCount: this.owner?.inFlight ? 1 : 0,
        interruptedOperationCount: this.interruptedOperationCount,
        timedOutOperationCount: this.timedOutOperationCount,
        lastOperationDurationMs: this.lastOperationDurationMs,
      },
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
          await this.halted;
          if (this.closed || !this.desiredEnabled) return;
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
      // Revoke admission before cleanup. Input already delivered is never
      // replayed; an in-flight native action requires retiring its helper.
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
      if (this.owner === session)
        void this.publishActivity({ phase: "stopping", usingSystemPointer: false }).catch(
          () => undefined,
        );
      if (session.inFlight) {
        this.interruptedOperationCount = Math.min(
          Number.MAX_SAFE_INTEGER,
          this.interruptedOperationCount + 1,
        );
        await this.haltController(
          "Desktop control stopped during a native action. Enable it again when ready; interrupted input was not replayed.",
        );
      }
      const connection = session.connection;
      if (connection) {
        try {
          if (this.enabled) {
            const ended = await connection.request({ method: "trusted_session_end" });
            if (ended.closed !== true) throw new Error("Native cleanup is still pending.");
          }
        } catch {
          await this.haltController(
            "Native cleanup could not be acknowledged. The controller was stopped; no input was replayed.",
          );
        } finally {
          connection.close();
          session.connection = undefined;
        }
      }
      session.computer?.clear();
      session.computer = undefined;
      if (this.owner === session) this.owner = undefined;
      await this.retireActivity(session);
    };
    const releasing = cleanup();
    session.releasing = releasing;
    try {
      await releasing;
    } finally {
      if (session.releasing === releasing) session.releasing = undefined;
    }
  }

  private get operationTimeoutMs(): number {
    return Math.min(
      NATIVE_CONTROL_OPERATION_TIMEOUT_MS,
      Math.max(1, this.options.operationTimeoutMs ?? NATIVE_CONTROL_OPERATION_TIMEOUT_MS),
    );
  }

  private haltController(detail: string): Promise<void> {
    this.enabled = false;
    this.desiredEnabled = false;
    this.phase = "error";
    this.detail = detail;
    if (this.halted) return this.halted;
    void this.publishActivity({ phase: "stopping", usingSystemPointer: false }).catch(
      () => undefined,
    );
    this.controllerEpoch++;
    const sessions = new Set(this.sessions.values());
    if (this.owner) sessions.add(this.owner);
    for (const session of sessions) session.turnActive = false;
    const halted = this.controller.stop({ force: true }).then(async () => {
      // Owned-child exit acknowledges termination of physical input. Discard
      // the retired generation before permitting explicit re-enable; every
      // failure path, including a disconnected caller, needs this cleanup.
      for (const session of sessions) {
        session.connection?.close();
        session.connection = undefined;
        session.computer?.clear();
        session.computer = undefined;
        session.cancelOperation?.(detail);
      }
      this.owner = undefined;
      await this.retireActivity();
    });
    this.halted = halted;
    void halted
      .finally(() => {
        if (this.halted === halted) this.halted = undefined;
      })
      .catch(() => undefined);
    return halted;
  }

  private call(session: Session, name: string, input: unknown): Promise<NativeToolResult> {
    let args: Record<string, unknown>;
    try {
      args = validateNativeToolCall(name, input);
    } catch (error) {
      return Promise.resolve(nativeControlValidationError(error));
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
      // The provider still owns an active turn. Only its lifecycle signal can
      // end that authority; releasing the desktop ends this native episode.
      return this.release(session, false).then(() => ({
        content: [{ type: "text", text: "Desktop control released." }],
      }));
    if (name === "health") return this.diagnostics();
    this.owner = session;
    const epoch = this.controllerEpoch;
    const startedAt = Date.now();
    const interrupted = Promise.withResolvers<NativeToolResult>();
    session.cancelOperation = (detail = "Desktop action interrupted. No input was replayed.") =>
      interrupted.resolve(nativeControlError(detail));
    const operation = async (): Promise<NativeToolResult> => {
      try {
        if (
          !this.enabled ||
          epoch !== this.controllerEpoch ||
          !session.turnActive ||
          session.revoked
        )
          return nativeControlError("Desktop access was revoked before the action started.");
        // A short readable label identifies the provider and this specific
        // binding on Cua's native cursor. The SDK injects it into native calls;
        // no model-supplied label can substitute another session's identity.
        if (!this.activityValue.episode)
          await this.publishActivity({
            episode: randomUUID(),
            threadId: session.threadId as ThreadId,
            provider: session.provider,
            providerInstanceId: session.providerInstanceId,
            phase: "idle",
            target: { scope: "selection", app: "Selecting target", title: "Computer use" },
            inputPolicy: this.inputPolicy,
            lastCaptureAt: null,
          });
        if (
          epoch !== this.controllerEpoch ||
          !this.enabled ||
          !session.turnActive ||
          session.revoked
        )
          return nativeControlError("Desktop access revoked during indicator initialization.");
        await this.publishActivity({
          inputPolicy:
            args.input_policy === "background-only" ? "background-only" : this.inputPolicy,
        });
        const connection =
          session.connection ??
          (await this.controller.session(
            // Cua tombstones ended public labels within a daemon generation.
            // A new control episode must never revive the previous lifecycle.
            `${session.provider === "claudeAgent" ? "Claude" : session.provider === "codex" ? "Codex" : "Cafe"} · ${session.id.slice(0, 8)} · ${randomUUID()}`,
          ));
        if (
          !this.enabled ||
          epoch !== this.controllerEpoch ||
          !session.turnActive ||
          session.revoked ||
          (session.provider !== "human" && !this.enabledThreads.has(session.threadId))
        ) {
          connection.close();
          return nativeControlError("Desktop access was revoked before the action started.");
        }
        session.connection = connection;
        session.computer ??= new NativeComputerSession(
          async (nativeName, nativeArgs) => {
            // Composite navigation and automatic fallback retain the same owner
            // and must observe disable/end-turn between native subcalls.
            if (
              !this.enabled ||
              epoch !== this.controllerEpoch ||
              this.phase !== "ready" ||
              !session.active ||
              !session.turnActive ||
              session.revoked ||
              session.expires < Date.now() ||
              this.owner !== session ||
              session.connection !== connection ||
              (session.provider !== "human" && !this.enabledThreads.has(session.threadId))
            )
              return nativeControlError("Desktop access was revoked before the action started.");
            await this.beforeNativeCall(session, nativeName, nativeArgs);
            if (
              epoch !== this.controllerEpoch ||
              !this.enabled ||
              !session.turnActive ||
              session.revoked ||
              this.owner !== session ||
              session.connection !== connection ||
              (session.provider !== "human" && !this.enabledThreads.has(session.threadId))
            )
              return nativeControlError("Desktop access was revoked before dispatch.");
            const response = (await connection.request({
              method: "trusted_session_call",
              name: nativeName,
              args: nativeArgs,
            })) as unknown as NativeToolResult;
            const path = response.structuredContent?.path;
            const actualRoute: NativeControlActivity["inputRoute"] =
              path === "ax" || path === "ax_fg"
                ? "accessibility"
                : path === "cgevent_pid" || path === "key_events"
                  ? "pid"
                  : path === "hid" ||
                      path === "cgevent_hid" ||
                      path === "cgevent_fg" ||
                      path === "key_events_fg"
                    ? "hid"
                    : path === "cgevent"
                      ? nativeArgs.delivery_mode === "foreground"
                        ? "hid"
                        : "pid"
                      : "unknown";
            if (
              actualRoute !== "unknown" &&
              epoch === this.controllerEpoch &&
              this.enabled &&
              this.owner === session &&
              session.turnActive &&
              !session.revoked &&
              this.activityValue.phase !== "stopping"
            )
              await this.publishActivity({ inputRoute: actualRoute });
            return response;
          },
          { inputPolicy: () => this.inputPolicy },
        );
        const result = await session.computer.call(name, args);
        return compactNativeToolResult(result);
      } catch {
        if (epoch !== this.controllerEpoch || !session.turnActive || session.revoked)
          return nativeControlError("Desktop action interrupted. No input was replayed.");
        const detail =
          "The native action's completion is uncertain. The controller was stopped; inspect the desktop before retrying.";
        await this.haltController(detail);
        return nativeControlError(detail);
      }
    };
    const timer = setTimeout(() => {
      if (epoch !== this.controllerEpoch) {
        session.cancelOperation?.();
        return;
      }
      this.timedOutOperationCount = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.timedOutOperationCount + 1,
      );
      void this.haltController(
        "Desktop action exceeded its time limit. The controller was stopped; inspect the desktop before retrying.",
      ).catch(() =>
        interrupted.resolve(nativeControlError("Native controller cleanup remains incomplete.")),
      );
    }, this.operationTimeoutMs);
    // Register ownership before executing native code, including callbacks
    // from an already acquired connection that can synchronously revoke it.
    const result = Promise.race([Promise.resolve().then(operation), interrupted.promise]);
    session.inFlight = result;
    return result.finally(async () => {
      clearTimeout(timer);
      session.inFlight = undefined;
      session.cancelOperation = undefined;
      this.lastOperationDurationMs = Math.max(0, Date.now() - startedAt);
      if (
        epoch === this.controllerEpoch &&
        this.owner === session &&
        this.activityValue.phase !== "stopping"
      ) {
        try {
          await this.publishActivity({
            phase: "idle",
            usingSystemPointer: false,
            inputPolicy: this.inputPolicy,
          });
        } catch {
          await this.haltController("Computer-use visibility failed. The controller was stopped.");
        }
      }
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
        else if (message.method === "tools/list") result = { tools: NATIVE_CONTROL_DEFAULT_TOOLS };
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
              void this.haltController(this.detail).catch(() => undefined);
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
    await this.options.visibility?.close();
    this.sessions.clear();
    this.enabledThreads.clear();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    const path = join(this.options.stateDirectory, NATIVE_CONTROL_HOST_FILE);
    const current = await fs.readFile(path, "utf8").catch(() => undefined);
    if (current && JSON.parse(current).generation === this.generation) await fs.unlink(path);
  }
}
