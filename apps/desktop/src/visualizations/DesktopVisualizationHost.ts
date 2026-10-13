import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
  VISUALIZATION_HOST_MAX_VIEWERS,
  VISUALIZATION_HOST_MAX_INPUT_BYTES,
  VisualizationHostPrepareInput,
  VisualizationHostPreviewInput,
  VisualizationHostInspectInput,
  VisualizationHostRevokeInput,
  VisualizationHostDiscardInput,
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
  type VisualizationHostCapacity,
  type VisualizationHostYieldResult,
  type VisualizationHostLayout,
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
const decodeDiscard = Schema.decodeUnknownResult(VisualizationHostDiscardInput);
const blocked = (reason: VisualizationHostReason): VisualizationHostBlocked => ({
  status: "blocked",
  reason,
});
const owns = (left: VisualizationHostOwner, right: VisualizationHostOwner) =>
  left.environmentId === right.environmentId &&
  left.threadId === right.threadId &&
  left.operationId === right.operationId;
// Count the actual retained encoded envelope, including escaped source/base64
// and private replay strings. This is not native, decoded-image or GPU memory.
const inputBytes = (input: unknown) => Buffer.byteLength(JSON.stringify(input), "utf8");
const sourceCommitment = (document: VisualizationHostDocument) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        kind: document.kind,
        html: document.html,
        assets: document.assets,
        width: document.width,
        height: document.height,
      }),
    )
    .digest("hex");

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
  readonly expires: number | null;
  readonly expiresAtMs: number | null;
  readonly inputBytes: number;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
  readonly messages: string[];
  layout: VisualizationHostLayout | undefined;
  pendingLayout: VisualizationHostLayout | undefined;
  surface?: VisualizationSurface;
  state: "preparing" | "active" | "retiring" | "quarantined";
  suspended: boolean;
  readonly spentConsents: Set<string>;
  suspendedConsentId: string | undefined;
  suspensionTimer?: ReturnType<typeof setTimeout>;
  capturePending: boolean;
  transitioning: boolean;
  presentationHidden: boolean;
  presentationCommitted: boolean;
  readonly presentationDeadline: number | null;
  transitionTimer?: ReturnType<typeof setTimeout>;
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
interface Continuation {
  readonly window: Electron.BrowserWindow;
  readonly frameToken: string;
  readonly frameUrl: string;
  readonly owner: VisualizationHostOwner;
  readonly commitment: string;
  readonly expires: number;
  readonly expiresAtMs: null;
  readonly timer: ReturnType<typeof setTimeout>;
}
interface NativeJob {
  readonly record: Active;
  readonly run: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly done: Promise<void>;
  readonly complete: () => void;
}

/**
 * Electron main owns all execution leases. Backend authentication admits source;
 * a one-use backend ticket admits its exact viewer to one trusted native window.
 * Renderer counters, booleans, PIDs and JSON never prove retirement. The native
 * surface returns observed exit/destruction; uncertainty permanently quarantines
 * this app-session pool. Main timers are outside page JS, not main-stall or hard
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
  private readonly viewers = new Map<string, Active>();
  private previewActive: Active | undefined;
  private quarantined = false;
  private readonly continuations = new Map<string, Continuation>();
  private continuationReservations = 0;
  private readonly yielding = new Map<
    string,
    { owner: VisualizationHostOwner; revoked: boolean }
  >();
  private readonly trustedFocus = new WeakMap<Electron.BrowserWindow, string>();
  private readonly capacityOwners = new Map<
    Electron.BrowserWindow,
    {
      frameToken: string;
      frameUrl: string;
      observerId: string;
      observerSequence: number;
      cleanup: () => void;
    }
  >();
  private readonly capacityWatermarks = new WeakMap<
    Electron.BrowserWindow,
    {
      frameToken: string;
      frameUrl: string;
      observerId: string;
      sequence: number;
      observing: boolean;
    }
  >();
  private capacitySequence = 0;
  private nativeActive: NativeJob | undefined;
  private nativeRetirements = 0;
  private readonly nativeQueue: NativeJob[] = [];
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
      available: !unavailable && !this.quarantined,
      reason: unavailable ? "unavailable" : this.quarantined ? "quarantined" : "ready",
      poolVersion: 1,
      autoGenerated: true,
      generatedLifecycle: "visible",
      maxActive: VISUALIZATION_HOST_MAX_VIEWERS,
      maxMcpApps: 1,
      maxPreviews: 1,
      activeLeaseMs: VISUALIZATION_HOST_ACTIVE_MS,
    };
  }

  diagnostics(): VisualizationHostDiagnostics {
    const capability = this.capabilities();
    return {
      available: capability.available,
      status: capability.reason,
      activeCount: this.viewers.size + (this.previewActive ? 1 : 0),
      pendingViewerCount: this.prepared.size,
      pendingPreviewCount: this.queue.length,
      retainedInputBytes: this.retainedInputBytes(),
      retirementCount: this.retirementCount,
      lastRetirementReason: this.lastRetirementReason,
      native: this.previewActive?.surface?.diagnostics?.() ?? this.lastNative,
      viewerCount: this.viewers.size,
      previewCount: this.previewActive ? 1 : 0,
      nativeWorkCount: this.nativeQueue.length + (this.nativeActive ? 1 : 0),
      continuationCount: this.continuations.size,
    };
  }

  private records(): Active[] {
    return [...this.viewers.values(), ...(this.previewActive ? [this.previewActive] : [])];
  }
  private contains(record: Active): boolean {
    return record.window
      ? this.viewers.get(record.leaseId) === record
      : this.previewActive === record;
  }
  /** Generated viewers have no clock maximum. Every native operation still
   * receives its own finite budget; previews and Apps retain absolute expiry. */
  private expired(record: Active): boolean {
    const now = this.now();
    return (
      (record.expires !== null && record.expires <= now) ||
      (!record.presentationCommitted &&
        record.presentationDeadline !== null &&
        record.presentationDeadline <= now)
    );
  }
  private remaining(record: Active, budget: number): number {
    const deadline =
      record.expires ?? (!record.presentationCommitted ? record.presentationDeadline : null);
    return deadline === null ? budget : Math.max(0, Math.min(budget, deadline - this.now()));
  }
  private retainedInputBytes(): number {
    return (
      this.records().reduce((sum, value) => sum + value.inputBytes, 0) +
      [...this.prepared.values()].reduce((sum, value) => sum + value.inputBytes, 0) +
      this.queue.reduce((sum, value) => sum + value.inputBytes, 0)
    );
  }
  capacity(): VisualizationHostCapacity {
    const available = this.capabilities().available;
    return {
      poolVersion: 1,
      sequence: this.capacitySequence,
      available,
      viewerCount: this.viewers.size,
      freeViewers: available ? VISUALIZATION_HOST_MAX_VIEWERS - this.viewers.size : 0,
      preparedCount: this.prepared.size,
      freePreparations: available ? VISUALIZATION_HOST_MAX_VIEWERS - this.prepared.size : 0,
      mcpAppAvailable:
        available &&
        this.viewers.size < VISUALIZATION_HOST_MAX_VIEWERS &&
        ![...this.viewers.values()].some((record) => record.document.kind === "mcp-app"),
      previewBusy: !!this.previewActive,
    };
  }
  /** One bounded observation per actual native window/document, not renderer IDs. */
  observeCapacity(
    window: Electron.BrowserWindow,
    observing: boolean,
    observerId: string,
    sequence: number,
  ): boolean {
    const previous = this.capacityOwners.get(window);
    try {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return false;
      const frame = window.webContents.mainFrame;
      const watermark = this.capacityWatermarks.get(window);
      const sameFrame =
        watermark?.frameToken === frame.frameToken && watermark.frameUrl === frame.url;
      if (
        sameFrame &&
        (sequence < watermark.sequence ||
          (sequence === watermark.sequence &&
            (observerId !== watermark.observerId || (observing && !watermark.observing))))
      )
        return false;
      if (!observing) {
        if (!sameFrame || watermark.sequence !== sequence || watermark.observerId !== observerId)
          return false;
        watermark.observing = false;
        previous?.cleanup();
        return true;
      }
      if (
        previous?.frameToken === frame.frameToken &&
        previous.frameUrl === frame.url &&
        previous.observerId === observerId &&
        previous.observerSequence === sequence
      )
        return true;
      previous?.cleanup();
      if (this.capacityOwners.size >= 32) return false;
      const cleanup = () => {
        if (this.capacityOwners.get(window)?.cleanup !== cleanup) return;
        this.capacityOwners.delete(window);
        window.removeListener("closed", cleanup);
        window.webContents.removeListener("did-start-navigation", cleanup);
        window.webContents.removeListener("render-process-gone", cleanup);
      };
      this.capacityOwners.set(window, {
        frameToken: frame.frameToken,
        frameUrl: frame.url,
        observerId,
        observerSequence: sequence,
        cleanup,
      });
      this.capacityWatermarks.set(window, {
        frameToken: frame.frameToken,
        frameUrl: frame.url,
        observerId,
        sequence,
        observing: true,
      });
      window.once("closed", cleanup);
      window.webContents.on("did-start-navigation", cleanup);
      window.webContents.on("render-process-gone", cleanup);
      return true;
    } catch {
      return false;
    }
  }
  private changed(): void {
    this.capacitySequence += 1;
    const capacity = this.capacity();
    for (const [window, owner] of this.capacityOwners) {
      try {
        if (
          window.isDestroyed() ||
          window.webContents.isDestroyed() ||
          window.webContents.mainFrame.frameToken !== owner.frameToken ||
          window.webContents.mainFrame.url !== owner.frameUrl
        ) {
          owner.cleanup();
          continue;
        }
        window.webContents.send("desktop:visualization-capacity-changed", capacity);
      } catch {
        owner.cleanup();
      }
    }
  }
  private quarantine(): void {
    if (this.quarantined) return;
    this.quarantined = true;
    this.prepared.clear();
    for (const value of this.continuations.values()) clearTimeout(value.timer);
    this.continuations.clear();
    for (const job of this.queue.splice(0)) {
      clearTimeout(job.timer);
      job.resolve(blocked("retirement-uncertain"));
    }
    for (const job of this.nativeQueue.splice(0)) {
      job.reject(new Error("Visualization native work was refused."));
      job.complete();
    }
    this.changed();
  }
  /** A finite global queue serializes setup and raster work across all five surfaces. */
  private nativeWork<T>(record: Active, run: () => Promise<T>): Promise<T> {
    if (this.quarantined || this.closed || this.nativeQueue.length >= 5 || !this.contains(record))
      return Promise.reject(new Error("Visualization native work was refused."));
    return new Promise<T>((resolve, reject) => {
      let complete!: () => void;
      const done = new Promise<void>((resolveDone) => {
        complete = resolveDone;
      });
      this.nativeQueue.push({
        record,
        run,
        resolve: (value) => resolve(value as T),
        reject,
        done,
        complete,
      });
      this.drainNative();
    });
  }
  private drainNative(): void {
    if (this.nativeActive || this.nativeRetirements || this.closed || this.quarantined) return;
    const job = this.nativeQueue.shift();
    if (!job) return;
    if (
      !this.contains(job.record) ||
      !["preparing", "active"].includes(job.record.state) ||
      this.expired(job.record)
    ) {
      job.reject(new Error("Visualization native work was refused."));
      job.complete();
      this.drainNative();
      return;
    }
    this.nativeActive = job;
    void job
      .run()
      .then(job.resolve, () => job.reject(new Error("Visualization native work was refused.")))
      .finally(() => {
        if (this.nativeActive === job) this.nativeActive = undefined;
        job.complete();
        this.drainNative();
      });
  }

  private expirePrepared(): void {
    const now = this.now();
    let changed = false;
    for (const [ticket, value] of this.prepared)
      if (value.expires <= now) {
        this.prepared.delete(ticket);
        changed = true;
      }
    if (changed) this.changed();
    this.armPreparedExpiry();
  }
  private armPreparedExpiry(): void {
    if (this.preparedTimer) clearTimeout(this.preparedTimer);
    this.preparedTimer = undefined;
    if (!this.prepared.size || this.closed) return;
    const earliest = Math.min(...[...this.prepared.values()].map((value) => value.expires));
    this.preparedTimer = setTimeout(
      () => this.expirePrepared(),
      Math.max(0, earliest - this.now()),
    );
  }
  prepare(
    input: typeof VisualizationHostPrepareInput.Type,
  ): VisualizationHostPrepared | VisualizationHostBlocked {
    if (!this.capabilities().available) return blocked("unavailable");
    this.expirePrepared();
    // Preparation is inert and independently bounded. Duplicates never replace
    // immutable bytes, and saturation does not grant a competing native slot.
    const bytes = inputBytes(input);
    if (
      this.prepared.has(input.ticket) ||
      this.spentTickets.has(input.ticket) ||
      this.prepared.size >= VISUALIZATION_HOST_MAX_VIEWERS ||
      this.spentTickets.size >= 4096 ||
      this.retainedInputBytes() + bytes > VISUALIZATION_HOST_MAX_INPUT_BYTES
    )
      return blocked("busy");
    this.prepared.set(input.ticket, {
      ...input,
      inputBytes: bytes,
      expires: this.now() + VISUALIZATION_HOST_TICKET_MS,
    });
    this.changed();
    this.armPreparedExpiry();
    return {
      status: "ready",
      ticket: input.ticket,
      expiresAtMs: this.wallNow() + VISUALIZATION_HOST_TICKET_MS,
    };
  }
  discardPrepared(ticket: string): { discarded: boolean } {
    this.expirePrepared();
    const discarded = this.prepared.delete(ticket);
    if (discarded) {
      this.armPreparedExpiry();
      this.changed();
    }
    return { discarded };
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
    state: "active" | "retired" | "quarantined" | "message" | "wheel" | "layout",
    json?: string,
    reason?: VisualizationHostReason,
    wheel?: { deltaX: number; deltaY: number },
    layout?: VisualizationHostLayout,
  ): void {
    try {
      if (!record.window || record.window.isDestroyed() || record.window.webContents.isDestroyed())
        return;
      const frame = record.window.webContents.mainFrame;
      if (frame.frameToken !== record.frameToken || frame.url !== record.frameUrl) return;
      record.window.webContents.send(VISUALIZATION_EVENT_CHANNEL, {
        leaseId: record.leaseId,
        ...(record.ticket ? { openingTicket: record.ticket } : {}),
        state,
        ...(json !== undefined ? { json } : {}),
        ...(reason !== undefined ? { reason } : {}),
        ...(wheel ? { wheel } : {}),
        ...(layout ? { layout } : {}),
      });
    } catch {
      // A renderer disappearing between native checks and IPC delivery cannot
      // invalidate or reject the independently observed retirement result.
    }
  }
  private matches(record: Active, window: Electron.BrowserWindow, leaseId: string): boolean {
    try {
      return (
        this.contains(record) &&
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
    duration: number | null,
    presentation?: VisualizationHostPresentation,
    displayMode?: VisualizationHostDisplayMode,
    privatePreviewMessage?: (record: Active, json: string) => void,
    privateInputBytes?: number,
    clipBounds?: VisualizationHostBounds,
  ): Active {
    const leaseId = randomUUID();
    const admittedAt = this.now();
    const record: Active = {
      leaseId,
      ticket: prepared.ticket || null,
      owner: prepared.owner,
      document: prepared.document,
      window,
      frameToken: window?.webContents.mainFrame.frameToken ?? "",
      frameUrl: window?.webContents.mainFrame.url ?? "",
      expires: duration === null ? null : admittedAt + duration,
      expiresAtMs: duration === null ? null : this.wallNow() + duration,
      inputBytes: privateInputBytes ?? inputBytes(prepared),
      // A generated viewer still has the original absolute startup budget
      // through its first exact trusted presentation commit. This timer is
      // cleared once, never rearmed as a live document/session lifetime.
      timer: setTimeout(() => {
        void this.retireRecord(record, "timeout");
      }, duration ?? VISUALIZATION_HOST_PREVIEW_MS),
      messages: [],
      layout: undefined,
      pendingLayout: undefined,
      state: "preparing",
      suspended: false,
      spentConsents: new Set(),
      suspendedConsentId: undefined,
      capturePending: false,
      transitioning: false,
      presentationHidden: false,
      presentationCommitted: false,
      // The callback is cleanup, not admission authority: a delayed main timer
      // must not let a late first geometry commit clear an already-spent budget.
      presentationDeadline: duration === null ? admittedAt + VISUALIZATION_HOST_PREVIEW_MS : null,
    };
    // Membership is reserved synchronously before constructor/startup awaits.
    if (window) this.viewers.set(leaseId, record);
    else this.previewActive = record;
    this.changed();
    const create =
      this.options.createSurface ?? ((options) => new ElectronVisualizationSurface(options));
    try {
      record.surface = create({
        document: prepared.document,
        window,
        bounds,
        ...(clipBounds ? { clipBounds } : {}),
        preloadPath: this.options.preloadPath,
        ...(presentation ? { presentation } : {}),
        ...(displayMode ? { displayMode } : {}),
        ...(prepared.document.kind === "generated"
          ? {
              admitGeneratedSource: () =>
                this.contains(record) &&
                !this.quarantined &&
                record.state === "preparing" &&
                !this.expired(record) &&
                (!record.window || this.matches(record, record.window, record.leaseId)),
            }
          : {}),
        onRevoked: () => {
          void this.retireRecord(record, "owner-revoked");
        },
        onTrustedFocus: () => {
          if (
            record.window &&
            this.matches(record, record.window, record.leaseId) &&
            record.state === "active"
          )
            this.trustedFocus.set(record.window, record.leaseId);
        },
        onOwnerFocused: () => {
          if (record.window) this.trustedFocus.delete(record.window);
        },
        onFocusDenied: () => {
          if (!record.window || record.window.isDestroyed() || !record.window.isFocused()) return;
          const trusted = this.viewers.get(this.trustedFocus.get(record.window) ?? "");
          if (trusted && trusted !== record && this.focus(record.window, trusted.leaseId)) return;
          if (!record.window.webContents.isDestroyed()) record.window.webContents.focus();
        },
        onWheel: (wheel) => {
          if (
            record.document.kind === "generated" &&
            record.window &&
            this.contains(record) &&
            record.state === "active" &&
            !record.suspended &&
            !record.transitioning &&
            !record.presentationHidden &&
            !this.expired(record)
          )
            this.emit(record, "wheel", undefined, undefined, wheel);
        },
        onLayout: (layout) => {
          if (
            record.document.kind !== "generated" ||
            !record.window ||
            !this.matches(record, record.window, record.leaseId) ||
            !["preparing", "active"].includes(record.state) ||
            record.suspended ||
            record.transitioning ||
            record.presentationHidden ||
            this.expired(record) ||
            !Number.isSafeInteger(layout.height) ||
            layout.height < 80 ||
            layout.height > 2000 ||
            typeof layout.constrained !== "boolean" ||
            !Number.isSafeInteger(layout.sequence) ||
            layout.sequence <= (record.layout?.sequence ?? 0) ||
            layout.sequence > 100000
          )
            return;
          // Retain one source-free latest scalar through the exact open ACK;
          // no stream/history buffer or source-selected lease is introduced.
          record.layout = {
            height: layout.height,
            constrained: layout.constrained,
            sequence: layout.sequence,
          };
          if (record.state === "preparing") record.pendingLayout = record.layout;
          else {
            record.pendingLayout = undefined;
            this.emit(record, "layout", undefined, undefined, undefined, record.layout);
          }
        },
        onMessage: (json) => {
          if (
            record.document.kind !== "mcp-app" ||
            !isVisualizationMessage(json) ||
            !this.contains(record) ||
            record.suspended ||
            record.transitioning ||
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
    } catch {
      // An inconclusive native constructor is never proof that it created no
      // resources. Retain this exact occupied reservation and quarantine all
      // further admission, rather than adopting another map record as cleanup.
      record.state = "quarantined";
      this.quarantine();
    }
    return record;
  }

  private async start(record: Active): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = await Promise.race([
        this.nativeWork(record, async () => {
          if (!this.contains(record) || this.quarantined || record.state !== "preparing")
            return false;
          await record.surface!.initialize();
          if (
            !this.contains(record) ||
            this.quarantined ||
            record.state !== "preparing" ||
            this.expired(record)
          )
            return false;
          await record.surface!.installSource();
          return true;
        }),
        new Promise<false>((resolve) => {
          timer = setTimeout(
            () => resolve(false),
            this.remaining(record, VISUALIZATION_HOST_PREVIEW_MS),
          );
        }),
      ]);
      if (
        !completed ||
        !this.contains(record) ||
        this.quarantined ||
        record.state !== "preparing" ||
        this.expired(record) ||
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
      this.viewers.size >= VISUALIZATION_HOST_MAX_VIEWERS ||
      (value.document.kind === "mcp-app" &&
        [...this.viewers.values()].some((record) => record.document.kind === "mcp-app")) ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    )
      return refused("busy");
    let continuation: Continuation | undefined;
    if (input.continuation !== undefined) {
      continuation = this.continuations.get(input.continuation);
      if (
        !continuation ||
        value.document.kind !== "generated" ||
        continuation.window !== window ||
        continuation.expires <= this.now() ||
        continuation.frameToken !== window.webContents.mainFrame.frameToken ||
        continuation.frameUrl !== window.webContents.mainFrame.url ||
        !owns(continuation.owner, value.owner) ||
        continuation.commitment !== sourceCommitment(value.document)
      )
        return refused("owner-revoked");
      // Spend before native setup. Lost ACK, failure and modal changes cannot
      // replay this exact source/window/frame continuation after it is spent.
      this.continuations.delete(input.continuation);
      clearTimeout(continuation.timer);
    }
    const viewerDocument = { ...value.document, appearance: input.appearance };
    const bytes = inputBytes({
      ticket: value.ticket,
      owner: value.owner,
      document: viewerDocument,
    });
    if (this.retainedInputBytes() - value.inputBytes + bytes > VISUALIZATION_HOST_MAX_INPUT_BYTES)
      return refused("busy");
    this.prepared.delete(input.ticket); // A lost acknowledgement is not replay authority.
    this.armPreparedExpiry();
    this.spentTickets.add(input.ticket);
    let record: Active | undefined;
    try {
      record = this.createRecord(
        { ...value, document: viewerDocument },
        window,
        input.bounds,
        viewerDocument.kind === "generated" ? null : VISUALIZATION_HOST_ACTIVE_MS,
        input.presentation,
        input.displayMode,
        undefined,
        bytes,
        input.clipBounds,
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
        if (this.contains(admitted) && admitted.state === "active") {
          for (const json of admitted.messages.splice(0)) this.emit(admitted, "message", json);
          if (admitted.pendingLayout && !this.expired(admitted))
            this.emit(admitted, "layout", undefined, undefined, undefined, admitted.pendingLayout);
          admitted.pendingLayout = undefined;
        }
      }, 0);
      return this.state(record);
    } catch {
      if (record) {
        const retired = await this.retireRecord(record, "unavailable");
        return this.state(
          record,
          retired ? "blocked" : "quarantined",
          retired ? "unavailable" : "retirement-uncertain",
        );
      }
      return refused("unavailable");
    }
  }

  inspect(ticket: string, leaseId: string): VisualizationHostInspection | null {
    const record = this.viewers.get(leaseId);
    if (
      !record ||
      record.ticket !== ticket ||
      record.leaseId !== leaseId ||
      record.state !== "active" ||
      this.expired(record) ||
      !record.surface?.isCurrent()
    )
      return null;
    return {
      leaseId,
      documentGeneration: record.surface.generation,
      expiresAtMs: record.expiresAtMs,
      state:
        record.suspended || record.transitioning || record.presentationHidden
          ? "suspended"
          : "active",
    };
  }

  async update(
    window: Electron.BrowserWindow,
    input: VisualizationHostUpdateInput,
  ): Promise<VisualizationHostState> {
    const record = this.viewers.get(input.leaseId);
    if (!record || !this.matches(record, window, input.leaseId) || record.state !== "active")
      return {
        leaseId: input.leaseId,
        state: "blocked",
        expiresAtMs: this.wallNow(),
        reason: "owner-revoked",
      };
    if (this.expired(record)) {
      const retired = await this.retireRecord(record, "timeout");
      return this.state(record, retired ? "retired" : "quarantined");
    }
    let updated = false;
    let updateFailure: "owner-revoked" | "unavailable" = "owner-revoked";
    try {
      updated =
        input.visible &&
        (input.presentationHidden === true
          ? record.document.kind === "generated" &&
            !!record.surface?.hidePresentation?.(input.bounds, input.clipBounds)
          : !!record.surface?.update(
              input.bounds,
              input.appearance,
              input.presentation,
              input.displayMode,
              input.clipBounds,
              input.focus === true && input.displayMode === "fullscreen",
            ));
    } catch {
      updateFailure = "unavailable";
    }
    if (!updated) {
      const retired = await this.retireRecord(record, updateFailure);
      return this.state(record, retired ? "retired" : "quarantined");
    }
    if (this.expired(record)) {
      const retired = await this.retireRecord(record, "timeout");
      return this.state(record, retired ? "retired" : "quarantined");
    }
    record.presentationHidden =
      input.presentationHidden === true || record.surface?.isPresentationHidden?.() === true;
    if (!record.presentationCommitted) {
      record.presentationCommitted = true;
      if (record.expires === null && record.timer) clearTimeout(record.timer);
    }
    if (record.transitioning) {
      let resumed = false;
      try {
        resumed = record.surface!.suspend(false);
      } catch {
        /* Native uncertainty retires the exact owner. */
      }
      if (!resumed) {
        const retired = await this.retireRecord(record, "owner-revoked");
        return this.state(record, retired ? "retired" : "quarantined");
      }
      record.transitioning = false;
      if (record.transitionTimer) clearTimeout(record.transitionTimer);
    }
    return this.state(record);
  }

  /** A short same-document geometry transition hides old native pixels before
   * a host popup appears. It cannot be renewed or become a hidden live epoch. */
  beginTransition(window: Electron.BrowserWindow, leaseId: string): boolean {
    const record = this.viewers.get(leaseId);
    if (
      !record ||
      !this.matches(record, window, leaseId) ||
      record.state !== "active" ||
      record.transitioning ||
      record.suspended ||
      this.expired(record) ||
      !record.surface?.suspend(true)
    )
      return false;
    record.transitioning = true;
    record.transitionTimer = setTimeout(
      () => {
        void this.retireRecord(record, "timeout");
      },
      this.remaining(record, 5_000),
    );
    return true;
  }

  async retire(window: Electron.BrowserWindow, leaseId: string): Promise<VisualizationHostState> {
    const record = this.viewers.get(leaseId);
    if (!record || !this.matches(record, window, leaseId))
      return { leaseId, state: "blocked", expiresAtMs: this.wallNow(), reason: "owner-revoked" };
    return this.state(
      record,
      (await this.retireRecord(record, "owner-revoked")) ? "retired" : "quarantined",
    );
  }

  focus(window: Electron.BrowserWindow, leaseId: string): boolean {
    const record = this.viewers.get(leaseId);
    return (
      !!record &&
      this.matches(record, window, leaseId) &&
      record.state === "active" &&
      !record.suspended &&
      !record.transitioning &&
      !record.presentationHidden &&
      !this.expired(record) &&
      !!record.surface?.focus?.()
    );
  }

  private async retireRecord(record: Active, reason: VisualizationHostReason): Promise<boolean> {
    if (record.retirement) return record.retirement;
    if (record.state === "quarantined" && !record.surface) return false;
    const retirementDeadline = this.now() + 5_000;
    this.nativeRetirements += 1;
    record.state = "retiring";
    record.messages.length = 0;
    record.layout = undefined;
    record.pendingLayout = undefined;
    if (record.timer) clearTimeout(record.timer);
    if (record.suspensionTimer) clearTimeout(record.suspensionTimer);
    if (record.transitionTimer) clearTimeout(record.transitionTimer);
    for (let index = this.nativeQueue.length - 1; index >= 0; index -= 1) {
      if (this.nativeQueue[index]?.record === record) {
        const job = this.nativeQueue.splice(index, 1)[0]!;
        job.reject(new Error("Visualization native work was refused."));
        job.complete();
      }
    }
    record.retirement = (async () => {
      let retired = false;
      try {
        const peerWork = this.nativeActive?.record !== record ? this.nativeActive : undefined;
        if (peerWork) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const settled = await Promise.race([
            peerWork.done.then(() => true),
            new Promise<false>((resolve) => {
              timer = setTimeout(
                () => resolve(false),
                Math.max(0, retirementDeadline - this.now()),
              );
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer);
          });
          if (!settled) throw new Error("Visualization native retirement was refused.");
        }
        retired = record.surface
          ? await record.surface.retire(Math.max(0, retirementDeadline - this.now()))
          : true;
        // Native capture/setup may still own a raster or source continuation.
        // Exact renderer death alone cannot release global expensive-work
        // serialization while that trusted operation remains inconclusive.
        const work = this.nativeActive?.record === record ? this.nativeActive : undefined;
        if (retired && work) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          retired = await Promise.race([
            work.done.then(() => true),
            new Promise<false>((resolve) => {
              timer = setTimeout(
                () => resolve(false),
                Math.max(0, retirementDeadline - this.now()),
              );
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer);
          });
        }
      } catch {
        retired = false;
      } finally {
        this.nativeRetirements -= 1;
      }
      this.retirementCount += 1;
      this.lastRetirementReason = retired ? reason : "retirement-uncertain";
      this.lastNative = record.surface?.diagnostics?.() ?? null;
      if (!retired) {
        record.state = "quarantined";
        this.quarantine();
        this.emit(record, "quarantined", undefined, "retirement-uncertain");
      } else {
        if (record.window) {
          if (this.viewers.get(record.leaseId) === record) this.viewers.delete(record.leaseId);
        } else if (this.previewActive === record) this.previewActive = undefined;
        this.emit(record, "retired", undefined, reason);
        this.changed();
        this.drain();
      }
      this.drainNative();
      return retired;
    })();
    return record.retirement;
  }

  /** Expansion yields source bytes only after exact native retirement. The
   * bounded continuation retains a commitment/window/finite token deadline, never the HTML,
   * assets, mutable DOM state or renderer-created timeout. */
  async yield(
    window: Electron.BrowserWindow,
    leaseId: string,
  ): Promise<VisualizationHostYieldResult> {
    const record = this.viewers.get(leaseId);
    if (
      !record ||
      !this.matches(record, window, leaseId) ||
      record.state !== "active" ||
      record.document.kind !== "generated" ||
      this.expired(record) ||
      !record.surface?.isCurrent() ||
      this.continuations.size + this.continuationReservations >= VISUALIZATION_HOST_MAX_VIEWERS
    )
      return { leaseId, state: "blocked", expiresAtMs: this.wallNow(), reason: "owner-revoked" };
    this.continuationReservations += 1;
    const pending = { owner: record.owner, revoked: false };
    this.yielding.set(leaseId, pending);
    try {
      const commitment = sourceCommitment(record.document);
      const retired = await this.retireRecord(record, "owner-revoked");
      if (!retired) return this.state(record, "quarantined", "retirement-uncertain");
      if (
        this.closed ||
        pending.revoked ||
        this.quarantined ||
        this.expired(record) ||
        window.isDestroyed() ||
        window.webContents.isDestroyed() ||
        window.webContents.mainFrame.frameToken !== record.frameToken ||
        window.webContents.mainFrame.url !== record.frameUrl
      )
        return this.state(record, "retired", "expired");
      const token = randomBytes(32).toString("hex");
      // A continuation is finite one-use metadata, not the generated document's
      // visibility lifetime. No hidden source bytes or live DOM are retained.
      const expires = this.now() + VISUALIZATION_HOST_TICKET_MS;
      const timer = setTimeout(
        () => this.continuations.delete(token),
        VISUALIZATION_HOST_TICKET_MS,
      );
      this.continuations.set(token, {
        window,
        frameToken: record.frameToken,
        frameUrl: record.frameUrl,
        owner: record.owner,
        commitment,
        expires,
        expiresAtMs: null,
        timer,
      });
      return { ...this.state(record, "retired"), continuation: token };
    } finally {
      this.continuationReservations -= 1;
      this.yielding.delete(leaseId);
    }
  }

  async capture(
    window: Electron.BrowserWindow,
    leaseId: string,
  ): Promise<VisualizationHostCapture | null> {
    const record = this.viewers.get(leaseId);
    if (
      !record ||
      !this.matches(record, window, leaseId) ||
      record.state !== "active" ||
      record.suspended ||
      record.transitioning ||
      record.presentationHidden ||
      record.capturePending ||
      this.expired(record) ||
      !record.surface?.isCurrent()
    )
      return null;
    record.capturePending = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        this.nativeWork(record, () => record.surface!.capture()),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), this.remaining(record, 5_000));
        }),
      ]);
      if (!value) await this.retireRecord(record, "capture-failed");
      return value &&
        this.matches(record, window, leaseId) &&
        record.state === "active" &&
        !record.suspended &&
        !record.transitioning &&
        !record.presentationHidden &&
        !this.expired(record) &&
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
    const record = this.viewers.get(leaseId);
    return (
      !!record &&
      this.matches(record, window, leaseId) &&
      record.state === "active" &&
      !record.suspended &&
      !record.transitioning &&
      record.document.kind === "mcp-app" &&
      !this.expired(record) &&
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
    const record = this.viewers.get(leaseId);
    if (
      !record ||
      !this.matches(record, window, leaseId) ||
      record.state !== "active" ||
      record.document.kind !== "mcp-app" ||
      record.transitioning
    )
      return false;
    if (suspended) {
      if (
        record.suspended ||
        record.spentConsents.has(consentId) ||
        record.spentConsents.size >= 256 ||
        this.expired(record) ||
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
        this.expired(record) ||
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
    if (!this.capabilities().available) return Promise.resolve(blocked("unavailable"));
    const bytes = inputBytes({ owner, document, ...(previewReplay ? { previewReplay } : {}) });
    if (
      this.queue.length >= 2 ||
      this.retainedInputBytes() + bytes > VISUALIZATION_HOST_MAX_INPUT_BYTES
    )
      return Promise.resolve(blocked("busy"));
    return new Promise((resolve) => {
      const job: PreviewJob = {
        owner,
        document,
        ...(previewReplay ? { previewReplay } : {}),
        inputBytes: bytes,
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
    if (this.previewActive || this.closed || this.quarantined) return;
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
      if (!protocol || current.state !== "active" || this.previewActive !== current) return;
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
          if (!replayed || this.previewActive !== record || record.state !== "active")
            throw new Error("Visualization preview replay was unavailable.");
        }
        const capture = await Promise.race([
          this.nativeWork(record, () => record!.surface!.capture()),
          new Promise<null>((resolve) => {
            captureTimer = setTimeout(() => resolve(null), Math.max(0, job.deadline - this.now()));
          }),
        ]);
        if (
          capture &&
          this.previewActive === record &&
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
    if (record && !(await this.retireRecord(record, "owner-revoked")))
      result = blocked("retirement-uncertain");
    job.resolve(result);
    this.drain();
  }

  async revoke(owner: VisualizationHostOwner): Promise<void> {
    for (const pending of this.yielding.values())
      if (owns(pending.owner, owner)) pending.revoked = true;
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
    for (const [token, value] of this.continuations)
      if (owns(value.owner, owner)) {
        clearTimeout(value.timer);
        this.continuations.delete(token);
      }
    await Promise.all(
      this.records()
        .filter((record) => owns(record.owner, owner))
        .map((record) => this.retireRecord(record, "owner-revoked")),
    );
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
      } else if (envelope.method === "discardPrepared") {
        const value = decodeDiscard(envelope.payload);
        reply(
          Result.isFailure(value) ? blocked("invalid") : this.discardPrepared(value.success.ticket),
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
    for (const pending of this.yielding.values()) pending.revoked = true;
    if (this.preparedTimer) clearTimeout(this.preparedTimer);
    this.prepared.clear();
    for (const job of this.queue.splice(0)) {
      clearTimeout(job.timer);
      job.resolve(blocked("owner-revoked"));
    }
    for (const value of this.continuations.values()) clearTimeout(value.timer);
    this.continuations.clear();
    for (const value of this.capacityOwners.values()) value.cleanup();
    await Promise.all(this.records().map((record) => this.retireRecord(record, "owner-revoked")));
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    // Keep the closed generation's private marker. unlink-after-lstat is not an
    // atomic identity-bound delete and must not erase another owner's replacement.
    // The next admitted primary app atomically publishes its fresh generation.
  }
}
