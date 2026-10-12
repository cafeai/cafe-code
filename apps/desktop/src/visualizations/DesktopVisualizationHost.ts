import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type * as Electron from "electron";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { McpAppPreviewReplay } from "@cafecode/contracts/mcpApps";
import { McpAppPreviewProtocol } from "@cafecode/shared/mcpAppProtocol";

import {
  VISUALIZATION_HOST_ACTIVE_MS,
  VISUALIZATION_HOST_FILE,
  VISUALIZATION_HOST_MAX_BODY_BYTES,
  VISUALIZATION_HOST_PATH,
  VISUALIZATION_HOST_PREVIEW_MS,
  VISUALIZATION_HOST_SUSPEND_MS,
  VISUALIZATION_HOST_TICKET_MS,
  VisualizationHostPrepareInput,
  VisualizationHostPreviewInput,
  VisualizationHostInspectInput,
  VisualizationHostRevokeInput,
  type VisualizationHostBlocked,
  type VisualizationHostBounds,
  type VisualizationHostCapabilities,
  type VisualizationHostCapture,
  type VisualizationHostConnection,
  type VisualizationHostDocument,
  type VisualizationHostInspection,
  type VisualizationHostOpenInput,
  type VisualizationHostOwner,
  type VisualizationHostPrepared,
  type VisualizationHostPreview,
  type VisualizationHostReason,
  type VisualizationHostState,
  type VisualizationHostUpdateInput,
  type VisualizationHostPresentation,
  type VisualizationHostDisplayMode,
} from "@cafecode/contracts/visualizationHost";
import {
  ElectronVisualizationSurface,
  type VisualizationSurface,
  type VisualizationSurfaceOptions,
} from "./ElectronVisualizationSurface.ts";
import {
  VISUALIZATION_EVENT_CHANNEL,
  hasBoundedVisualizationJson,
  isVisualizationMessage,
} from "./visualizationHostPolicy.ts";
import type {
  VisualizationHostDiagnostics,
  VisualizationSurfaceDiagnostics,
} from "./visualizationDiagnostics.ts";

const decodePrepare = Schema.decodeUnknownResult(VisualizationHostPrepareInput);
const decodePreview = Schema.decodeUnknownResult(VisualizationHostPreviewInput);
const decodeInspect = Schema.decodeUnknownResult(VisualizationHostInspectInput);
const decodeRevoke = Schema.decodeUnknownResult(VisualizationHostRevokeInput);
const blocked = (reason: VisualizationHostReason): VisualizationHostBlocked => ({
  status: "blocked",
  reason,
});
const owns = (left: VisualizationHostOwner, right: VisualizationHostOwner) =>
  left.environmentId === right.environmentId &&
  left.threadId === right.threadId &&
  left.operationId === right.operationId;
const documentBytes = (document: VisualizationHostDocument) =>
  Buffer.byteLength(document.html, "utf8") +
  document.assets.reduce((total, asset) => total + Math.floor(asset.base64.length / 4) * 3, 0);

interface Prepared {
  readonly ticket: string;
  readonly owner: VisualizationHostOwner;
  readonly document: VisualizationHostDocument;
  readonly expires: number;
  readonly inputBytes: number;
}
interface Active {
  readonly leaseId: string;
  readonly ticket: string | null;
  readonly owner: VisualizationHostOwner;
  readonly document: VisualizationHostDocument;
  readonly window: Electron.BrowserWindow | null;
  readonly frameToken: string;
  readonly frameUrl: string;
  readonly expires: number;
  readonly expiresAtMs: number;
  readonly inputBytes: number;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly messages: string[];
  surface?: VisualizationSurface;
  state: "preparing" | "active" | "retiring" | "quarantined";
  suspended: boolean;
  readonly spentConsents: Set<string>;
  suspendedConsentId: string | undefined;
  suspensionTimer?: ReturnType<typeof setTimeout>;
  capturePending: boolean;
  retirement?: Promise<boolean>;
}
interface PreviewJob {
  readonly owner: VisualizationHostOwner;
  readonly document: VisualizationHostDocument;
  readonly previewReplay?: McpAppPreviewReplay;
  readonly deadline: number;
  readonly inputBytes: number;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (value: VisualizationHostPreview | VisualizationHostBlocked) => void;
}

/**
 * Electron main owns all execution leases. Backend authentication admits source;
 * a one-use backend ticket admits its exact viewer to one trusted native window.
 * Renderer counters, booleans, PIDs and JSON never prove retirement. The native
 * surface returns observed exit/destruction; uncertainty permanently quarantines
 * this app-session lane. Main timers are outside page JS, not main-stall or hard
 * system-memory protection. No provider, OS helper or browser is installed here.
 */
export class DesktopVisualizationHost {
  private readonly generation = randomUUID();
  private readonly token = randomBytes(32).toString("hex");
  private readonly prepared = new Map<string, Prepared>();
  private readonly spentTickets = new Set<string>();
  private preparedTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly queue: PreviewJob[] = [];
  private readonly server = createServer((request, response) => {
    void this.handle(request, response);
  });
  private active: Active | undefined;
  private closed = false;
  private listening = false;
  private inFlight = 0;
  private url = "";
  private retirementCount = 0;
  private lastRetirementReason: VisualizationHostDiagnostics["lastRetirementReason"] = "none";
  private lastNative: VisualizationSurfaceDiagnostics | null = null;
  private readonly options: {
    readonly stateDirectory: string;
    readonly preloadPath: string;
    readonly createSurface?: (options: VisualizationSurfaceOptions) => VisualizationSurface;
    readonly now?: () => number;
    readonly wallNow?: () => number;
  };

  constructor(options: DesktopVisualizationHost["options"]) {
    this.options = options;
    this.server.maxConnections = 4;
    this.server.headersTimeout = 5_000;
    this.server.requestTimeout = 25_000;
    this.server.keepAliveTimeout = 1_000;
    this.server.maxRequestsPerSocket = 16;
  }
  private now(): number {
    return this.options.now?.() ?? performance.now();
  }
  private wallNow(): number {
    return this.options.wallNow?.() ?? Date.now();
  }

  /** Called only after Cafe's existing primary single-instance admission. */
  async listen(publish = true): Promise<VisualizationHostConnection> {
    if (this.closed || this.listening) throw new Error("Visualization host is unavailable.");
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Visualization host is unavailable.");
    this.url = `http://127.0.0.1:${address.port}${VISUALIZATION_HOST_PATH}`;
    const connection: VisualizationHostConnection = {
      version: 1,
      generation: this.generation,
      url: this.url,
      token: this.token,
    };
    try {
      if (publish) {
        const root = await fs.lstat(this.options.stateDirectory);
        if (
          !root.isDirectory() ||
          root.isSymbolicLink() ||
          (process.platform !== "win32" &&
            (root.uid !== process.getuid!() || (root.mode & 0o022) !== 0))
        )
          throw new Error("Private host publication was refused.");
        const destination = join(this.options.stateDirectory, VISUALIZATION_HOST_FILE);
        const previous = await fs.lstat(destination).catch(() => undefined);
        if (
          previous &&
          (!previous.isFile() ||
            previous.isSymbolicLink() ||
            (process.platform !== "win32" &&
              (previous.uid !== process.getuid!() || (previous.mode & 0o077) !== 0)))
        )
          throw new Error("Private host publication was refused.");
        const temporary = join(
          this.options.stateDirectory,
          `.visualization-host-${this.generation}.json`,
        );
        const handle = await fs.open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(connection)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporary, destination);
      }
      this.listening = true;
      return connection;
    } catch {
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
      throw new Error("Visualization host publication was refused.");
    }
  }

  capabilities(): VisualizationHostCapabilities {
    const unavailable = this.closed || !this.listening;
    return {
      available: !unavailable && this.active?.state !== "quarantined",
      reason: unavailable
        ? "unavailable"
        : this.active?.state === "quarantined"
          ? "quarantined"
          : "ready",
      maxActive: 1,
      activeLeaseMs: VISUALIZATION_HOST_ACTIVE_MS,
    };
  }

  diagnostics(): VisualizationHostDiagnostics {
    const capability = this.capabilities();
    return {
      available: capability.available,
      status: capability.reason,
      activeCount: this.active ? 1 : 0,
      pendingViewerCount: this.prepared.size,
      pendingPreviewCount: this.queue.length,
      retainedInputBytes:
        (this.active?.inputBytes ?? 0) +
        [...this.prepared.values()].reduce((sum, value) => sum + value.inputBytes, 0) +
        this.queue.reduce((sum, value) => sum + value.inputBytes, 0),
      retirementCount: this.retirementCount,
      lastRetirementReason: this.lastRetirementReason,
      native: this.active?.surface?.diagnostics?.() ?? this.lastNative,
    };
  }

  private expirePrepared(): void {
    const now = this.now();
    for (const [ticket, value] of this.prepared)
      if (value.expires <= now) this.prepared.delete(ticket);
  }
  prepare(
    input: typeof VisualizationHostPrepareInput.Type,
  ): VisualizationHostPrepared | VisualizationHostBlocked {
    if (!this.capabilities().available) return blocked("unavailable");
    this.expirePrepared();
    // One private pending viewer is enough for this one-active-view lane. Refuse
    // duplicate tickets/content rather than silently replacing immutable bytes.
    if (
      this.prepared.has(input.ticket) ||
      this.spentTickets.has(input.ticket) ||
      this.prepared.size >= 1 ||
      this.spentTickets.size >= 4096
    )
      return blocked("busy");
    this.prepared.set(input.ticket, {
      ...input,
      inputBytes: documentBytes(input.document),
      expires: this.now() + VISUALIZATION_HOST_TICKET_MS,
    });
    if (this.preparedTimer) clearTimeout(this.preparedTimer);
    this.preparedTimer = setTimeout(() => this.expirePrepared(), VISUALIZATION_HOST_TICKET_MS);
    return {
      status: "ready",
      ticket: input.ticket,
      expiresAtMs: this.wallNow() + VISUALIZATION_HOST_TICKET_MS,
    };
  }

  private state(
    record: Active,
    state: VisualizationHostState["state"] = "active",
    reason?: VisualizationHostReason,
  ): VisualizationHostState {
    return {
      leaseId: record.leaseId,
      state,
      expiresAtMs: record.expiresAtMs,
      ...(reason ? { reason } : {}),
    };
  }
  private emit(
    record: Active,
    state: "active" | "retired" | "quarantined" | "message",
    json?: string,
    reason?: VisualizationHostReason,
  ): void {
    try {
      if (!record.window || record.window.isDestroyed() || record.window.webContents.isDestroyed())
        return;
      const frame = record.window.webContents.mainFrame;
      if (frame.frameToken !== record.frameToken || frame.url !== record.frameUrl) return;
      record.window.webContents.send(VISUALIZATION_EVENT_CHANNEL, {
        leaseId: record.leaseId,
        state,
        ...(json !== undefined ? { json } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
    } catch {
      // A renderer disappearing between native checks and IPC delivery cannot
      // invalidate or reject the independently observed retirement result.
    }
  }
  private matches(record: Active, window: Electron.BrowserWindow, leaseId: string): boolean {
    try {
      return (
        this.active === record &&
        record.leaseId === leaseId &&
        record.window === window &&
        !window.isDestroyed() &&
        !window.webContents.isDestroyed() &&
        window.webContents.mainFrame.frameToken === record.frameToken &&
        window.webContents.mainFrame.url === record.frameUrl
      );
    } catch {
      return false;
    }
  }

  private createRecord(
    prepared: Omit<Prepared, "expires" | "inputBytes">,
    window: Electron.BrowserWindow | null,
    bounds: VisualizationHostBounds,
    duration: number,
    presentation?: VisualizationHostPresentation,
    displayMode?: VisualizationHostDisplayMode,
    privatePreviewMessage?: (record: Active, json: string) => void,
    privateInputBytes?: number,
  ): Active {
    const leaseId = randomUUID();
    const record: Active = {
      leaseId,
      ticket: prepared.ticket || null,
      owner: prepared.owner,
      document: prepared.document,
      window,
      frameToken: window?.webContents.mainFrame.frameToken ?? "",
      frameUrl: window?.webContents.mainFrame.url ?? "",
      expires: this.now() + duration,
      expiresAtMs: this.wallNow() + duration,
      inputBytes: privateInputBytes ?? documentBytes(prepared.document),
      timer: setTimeout(() => {
        void this.retireRecord(record, "timeout");
      }, duration),
      messages: [],
      state: "preparing",
      suspended: false,
      spentConsents: new Set(),
      suspendedConsentId: undefined,
      capturePending: false,
    };
    this.active = record;
    const create =
      this.options.createSurface ?? ((options) => new ElectronVisualizationSurface(options));
    record.surface = create({
      document: prepared.document,
      window,
      bounds,
      preloadPath: this.options.preloadPath,
      ...(presentation ? { presentation } : {}),
      ...(displayMode ? { displayMode } : {}),
      onRevoked: () => {
        void this.retireRecord(record, "owner-revoked");
      },
      onMessage: (json) => {
        if (
          record.document.kind !== "mcp-app" ||
          !isVisualizationMessage(json) ||
          this.active !== record ||
          record.suspended ||
          record.state === "retiring" ||
          record.state === "quarantined"
        )
          return;
        if (record.state === "preparing") {
          if (record.messages.length < 8) record.messages.push(json);
          else void this.retireRecord(record, "resource-denied");
        } else if (privatePreviewMessage) privatePreviewMessage(record, json);
        else this.emit(record, "message", json);
      },
    });
    return record;
  }

  private async start(record: Active): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = await Promise.race([
        (async () => {
          await record.surface!.initialize();
          await record.surface!.installSource();
          return true;
        })(),
        new Promise<false>((resolve) => {
          timer = setTimeout(
            () => resolve(false),
            Math.max(0, Math.min(VISUALIZATION_HOST_PREVIEW_MS, record.expires - this.now())),
          );
        }),
      ]);
      if (
        !completed ||
        this.active !== record ||
        record.state !== "preparing" ||
        !record.surface?.isCurrent()
      )
        return false;
      record.state = "active";
      return true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async open(
    window: Electron.BrowserWindow,
    input: VisualizationHostOpenInput,
  ): Promise<VisualizationHostState> {
    this.expirePrepared();
    const value = this.prepared.get(input.ticket);
    const refused = (reason: VisualizationHostReason): VisualizationHostState => ({
      leaseId: randomUUID(),
      state: "blocked",
      expiresAtMs: this.wallNow(),
      reason,
    });
    if (!this.capabilities().available) return refused("unavailable");
    if (!value) return refused("expired");
    if (
      this.active ||
      this.queue.length > 0 ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    )
      return refused("busy");
    this.prepared.delete(input.ticket); // A lost acknowledgement is not replay authority.
    this.spentTickets.add(input.ticket);
    let record: Active | undefined;
    try {
      record = this.createRecord(
        { ...value, document: { ...value.document, appearance: input.appearance } },
        window,
        input.bounds,
        VISUALIZATION_HOST_ACTIVE_MS,
        input.presentation,
        input.displayMode,
      );
      if (!(await this.start(record))) {
        const retired = await this.retireRecord(record, "timeout");
        return this.state(
          record,
          retired ? "blocked" : "quarantined",
          retired ? "timeout" : "retirement-uncertain",
        );
      }
      this.emit(record, "active");
      const admitted = record;
      setTimeout(() => {
        if (this.active === admitted && admitted.state === "active") {
          for (const json of admitted.messages.splice(0)) this.emit(admitted, "message", json);
        }
      }, 0);
      return this.state(record);
    } catch {
      const current = record ?? this.active;
      if (current) {
        const retired = await this.retireRecord(current, "unavailable");
        return this.state(
          current,
          retired ? "blocked" : "quarantined",
          retired ? "unavailable" : "retirement-uncertain",
        );
      }
      return refused("unavailable");
    }
  }

  inspect(ticket: string, leaseId: string): VisualizationHostInspection | null {
    const record = this.active;
    if (
      !record ||
      record.ticket !== ticket ||
      record.leaseId !== leaseId ||
      record.state !== "active" ||
      record.expires <= this.now() ||
      !record.surface?.isCurrent()
    )
      return null;
    return {
      leaseId,
      documentGeneration: record.surface.generation,
      expiresAtMs: record.expiresAtMs,
      state: record.suspended ? "suspended" : "active",
    };
  }

  async update(
    window: Electron.BrowserWindow,
    input: VisualizationHostUpdateInput,
  ): Promise<VisualizationHostState> {
    const record = this.active;
    if (!record || !this.matches(record, window, input.leaseId) || record.state !== "active")
      return {
        leaseId: input.leaseId,
        state: "blocked",
        expiresAtMs: this.wallNow(),
        reason: "owner-revoked",
      };
    if (
      !input.visible ||
      !record.surface?.update(input.bounds, input.appearance, input.presentation, input.displayMode)
    ) {
      const retired = await this.retireRecord(record, "owner-revoked");
      return this.state(record, retired ? "retired" : "quarantined");
    }
    return this.state(record);
  }

  async retire(window: Electron.BrowserWindow, leaseId: string): Promise<VisualizationHostState> {
    const record = this.active;
    if (!record || !this.matches(record, window, leaseId))
      return { leaseId, state: "blocked", expiresAtMs: this.wallNow(), reason: "owner-revoked" };
    return this.state(
      record,
      (await this.retireRecord(record, "owner-revoked")) ? "retired" : "quarantined",
    );
  }

  private async retireRecord(record: Active, reason: VisualizationHostReason): Promise<boolean> {
    if (record.retirement) return record.retirement;
    record.state = "retiring";
    record.messages.length = 0;
    clearTimeout(record.timer);
    if (record.suspensionTimer) clearTimeout(record.suspensionTimer);
    record.retirement = (async () => {
      let retired = false;
      try {
        retired = record.surface ? await record.surface.retire() : true;
      } catch {
        retired = false;
      }
      this.retirementCount += 1;
      this.lastRetirementReason = retired ? reason : "retirement-uncertain";
      this.lastNative = record.surface?.diagnostics?.() ?? null;
      if (!retired) {
        record.state = "quarantined";
        this.emit(record, "quarantined", undefined, "retirement-uncertain");
      } else {
        if (this.active === record) this.active = undefined;
        this.emit(record, "retired", undefined, reason);
        this.drain();
      }
      return retired;
    })();
    return record.retirement;
  }

  async capture(
    window: Electron.BrowserWindow,
    leaseId: string,
  ): Promise<VisualizationHostCapture | null> {
    const record = this.active;
    if (
      !record ||
      !this.matches(record, window, leaseId) ||
      record.state !== "active" ||
      record.suspended ||
      record.capturePending ||
      !record.surface?.isCurrent()
    )
      return null;
    record.capturePending = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        record.surface.capture(),
        new Promise<null>((resolve) => {
          timer = setTimeout(
            () => resolve(null),
            Math.min(5_000, Math.max(0, record.expires - this.now())),
          );
        }),
      ]);
      if (!value) await this.retireRecord(record, "capture-failed");
      return value &&
        this.matches(record, window, leaseId) &&
        record.state === "active" &&
        !record.suspended &&
        record.surface.isCurrent()
        ? value
        : null;
    } catch {
      await this.retireRecord(record, "capture-failed");
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      record.capturePending = false;
    }
  }

  send(window: Electron.BrowserWindow, leaseId: string, json: string): boolean {
    const record = this.active;
    return (
      !!record &&
      this.matches(record, window, leaseId) &&
      record.state === "active" &&
      !record.suspended &&
      record.document.kind === "mcp-app" &&
      record.expires > this.now() &&
      isVisualizationMessage(json) &&
      !!record.surface?.send(json)
    );
  }

  suspend(
    window: Electron.BrowserWindow,
    leaseId: string,
    suspended: boolean,
    consentId: string,
  ): boolean {
    const record = this.active;
    if (
      !record ||
      !this.matches(record, window, leaseId) ||
      record.state !== "active" ||
      record.document.kind !== "mcp-app"
    )
      return false;
    if (suspended) {
      if (
        record.suspended ||
        record.spentConsents.has(consentId) ||
        record.spentConsents.size >= 256 ||
        record.expires <= this.now() ||
        !record.surface?.isCurrent() ||
        !record.surface.suspend(true)
      )
        return false;
      record.spentConsents.add(consentId);
      record.suspendedConsentId = consentId;
      record.suspended = true;
      record.suspensionTimer = setTimeout(() => {
        void this.retireRecord(record, "timeout");
      }, VISUALIZATION_HOST_SUSPEND_MS);
    } else {
      if (
        !record.suspended ||
        record.suspendedConsentId !== consentId ||
        record.expires <= this.now() ||
        !record.surface?.isCurrent() ||
        !record.surface.suspend(false)
      )
        return false;
      record.suspended = false;
      record.suspendedConsentId = undefined;
      if (record.suspensionTimer) clearTimeout(record.suspensionTimer);
    }
    return true;
  }

  preview(
    owner: VisualizationHostOwner,
    document: VisualizationHostDocument,
    previewReplay?: McpAppPreviewReplay,
  ): Promise<VisualizationHostPreview | VisualizationHostBlocked> {
    if ((document.kind === "mcp-app") !== (previewReplay !== undefined))
      return Promise.resolve(blocked("invalid"));
    if (!this.capabilities().available || this.active?.state === "quarantined")
      return Promise.resolve(blocked("unavailable"));
    if (this.active?.window || this.queue.length >= 2) return Promise.resolve(blocked("busy"));
    return new Promise((resolve) => {
      const job: PreviewJob = {
        owner,
        document,
        ...(previewReplay ? { previewReplay } : {}),
        inputBytes:
          documentBytes(document) +
          (previewReplay
            ? Buffer.byteLength(previewReplay.originalInputJson, "utf8") +
              Buffer.byteLength(previewReplay.originalResultJson, "utf8")
            : 0),
        deadline: this.now() + VISUALIZATION_HOST_PREVIEW_MS,
        resolve,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(job);
          if (index >= 0) {
            this.queue.splice(index, 1);
            resolve(blocked("timeout"));
          }
        }, VISUALIZATION_HOST_PREVIEW_MS),
      };
      this.queue.push(job);
      this.drain();
    });
  }
  private drain(): void {
    if (this.active || this.closed) return;
    const job = this.queue.shift();
    if (!job) return;
    clearTimeout(job.timer);
    if (job.deadline <= this.now()) {
      job.resolve(blocked("timeout"));
      this.drain();
      return;
    }
    void this.runPreview(job);
  }
  private async runPreview(job: PreviewJob): Promise<void> {
    let record: Active | undefined;
    let captureTimer: ReturnType<typeof setTimeout> | undefined;
    let result: VisualizationHostPreview | VisualizationHostBlocked = blocked("capture-failed");
    const protocol = job.previewReplay ? new McpAppPreviewProtocol(job.previewReplay) : undefined;
    let replayResolve: ((value: boolean) => void) | undefined;
    const replayReady = new Promise<boolean>((resolve) => {
      replayResolve = resolve;
    });
    const relayPreview = (current: Active, json: string): void => {
      if (!protocol || current.state !== "active" || this.active !== current) return;
      for (const message of protocol.receive(json)) {
        if (!current.surface?.send(message)) {
          replayResolve?.(false);
          void this.retireRecord(current, "resource-denied");
          return;
        }
      }
      if (protocol.initialized) replayResolve?.(true);
    };
    try {
      record = this.createRecord(
        { ticket: "", owner: job.owner, document: job.document },
        null,
        { x: 0, y: 0, width: job.document.width, height: job.document.height },
        job.deadline - this.now(),
        undefined,
        undefined,
        protocol ? relayPreview : undefined,
        job.inputBytes,
      );
      if (!(await this.start(record))) result = blocked("timeout");
      else {
        // No UI window or action broker participates in poster preparation.
        // Buffered SDK initialization is answered privately; only initialized
        // input/result replay may precede a bounded real native capture.
        if (protocol) {
          for (const message of record.messages.splice(0)) relayPreview(record, message);
          const replayed = await Promise.race([
            replayReady,
            new Promise<false>((resolve) => {
              captureTimer = setTimeout(
                () => resolve(false),
                Math.max(0, job.deadline - this.now()),
              );
            }),
          ]);
          if (captureTimer) clearTimeout(captureTimer);
          if (!replayed || this.active !== record || record.state !== "active")
            throw new Error("Visualization preview replay was unavailable.");
        }
        const capture = await Promise.race([
          record.surface!.capture(),
          new Promise<null>((resolve) => {
            captureTimer = setTimeout(() => resolve(null), Math.max(0, job.deadline - this.now()));
          }),
        ]);
        if (
          capture &&
          this.active === record &&
          record.state === "active" &&
          record.surface!.isCurrent()
        )
          result = {
            status: "ready",
            png: Buffer.from(capture.png).toString("base64"),
            width: capture.width,
            height: capture.height,
            diagnostics: [],
          };
        else result = blocked("timeout");
      }
    } catch {
      result = blocked("unavailable");
    } finally {
      if (captureTimer) clearTimeout(captureTimer);
      protocol?.close();
    }
    const current = record ?? this.active;
    if (current && !(await this.retireRecord(current, "owner-revoked")))
      result = blocked("retirement-uncertain");
    job.resolve(result);
    this.drain();
  }

  async revoke(owner: VisualizationHostOwner): Promise<void> {
    for (const [ticket, value] of this.prepared)
      if (owns(value.owner, owner)) this.prepared.delete(ticket);
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const job = this.queue[index]!;
      if (owns(job.owner, owner)) {
        this.queue.splice(index, 1);
        clearTimeout(job.timer);
        job.resolve(blocked("owner-revoked"));
      }
    }
    if (this.active && owns(this.active.owner, owner))
      await this.retireRecord(this.active, "owner-revoked");
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (value: unknown, status = 200) => {
      if (!response.destroyed) {
        response.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(JSON.stringify(value));
      }
    };
    const auth = request.headers.authorization;
    const expected = `Bearer ${this.token}`;
    if (
      this.closed ||
      request.method !== "POST" ||
      request.url !== VISUALIZATION_HOST_PATH ||
      request.headers.origin !== undefined ||
      !auth ||
      auth.length !== expected.length ||
      Buffer.byteLength(auth) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(auth), Buffer.from(expected)) ||
      this.inFlight >= 3
    ) {
      reply(blocked("invalid"), 403);
      request.resume();
      return;
    }
    this.inFlight += 1;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        if (size > VISUALIZATION_HOST_MAX_BODY_BYTES || chunks.length >= 2048) {
          reply(blocked("invalid"), 413);
          request.destroy();
          return;
        }
        chunks.push(bytes);
      }
      const raw = Buffer.concat(chunks, size).toString("utf8");
      if (!hasBoundedVisualizationJson(raw, VISUALIZATION_HOST_MAX_BODY_BYTES)) {
        reply(blocked("invalid"), 400);
        return;
      }
      const decoded: unknown = JSON.parse(raw);
      if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
        reply(blocked("invalid"), 400);
        return;
      }
      const envelope = decoded as { generation?: unknown; method?: unknown; payload?: unknown };
      if (Object.keys(decoded).length !== 3 || envelope.generation !== this.generation) {
        reply(blocked("invalid"), 403);
        return;
      }
      if (envelope.method === "prepareViewer") {
        const value = decodePrepare(envelope.payload);
        reply(Result.isFailure(value) ? blocked("invalid") : this.prepare(value.success));
      } else if (envelope.method === "preview") {
        const value = decodePreview(envelope.payload);
        reply(
          Result.isFailure(value)
            ? blocked("invalid")
            : await this.preview(
                value.success.owner,
                value.success.document,
                value.success.previewReplay,
              ),
        );
      } else if (envelope.method === "inspectViewer") {
        const value = decodeInspect(envelope.payload);
        reply(
          Result.isFailure(value)
            ? null
            : this.inspect(value.success.ticket, value.success.leaseId),
        );
      } else if (envelope.method === "revoke") {
        const value = decodeRevoke(envelope.payload);
        if (Result.isSuccess(value)) await this.revoke(value.success.owner);
        reply(Result.isFailure(value) ? blocked("invalid") : { status: "revoked" });
      } else reply(blocked("invalid"), 400);
    } catch {
      reply(blocked("invalid"), 400);
    } finally {
      this.inFlight -= 1;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.preparedTimer) clearTimeout(this.preparedTimer);
    this.prepared.clear();
    for (const job of this.queue.splice(0)) {
      clearTimeout(job.timer);
      job.resolve(blocked("owner-revoked"));
    }
    if (this.active) await this.retireRecord(this.active, "owner-revoked");
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    // Keep the closed generation's private marker. unlink-after-lstat is not an
    // atomic identity-bound delete and must not erase another owner's replacement.
    // The next admitted primary app atomically publishes its fresh generation.
  }
}
