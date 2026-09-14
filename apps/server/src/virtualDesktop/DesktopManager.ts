import { DesktopAuthority, type DesktopBinding as Binding } from "./authority.ts";
import { DesktopResolution, DEFAULT_DESKTOP_RESOLUTION } from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import {
  desktopRuntimeDirectory,
  desktopInstanceDirectory,
  isDesktopInstanceDirectory,
} from "@cafecode/shared/desktopRuntime";
// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DesktopViewerAppearance,
  ThreadId,
  VirtualDesktopRequest,
  VirtualDesktopSnapshot,
  VirtualDesktopState,
  VirtualDesktopPrerequisites,
  DesktopToolUsage,
} from "@cafecode/contracts";
import { readMcpFile, writeMcpFile } from "../mcp/privateFiles.ts";
import { listDesktopApps, terminalCommand } from "./desktopEntries.ts";
import {
  desktopError,
  executable,
  nativeHelperPath,
  nativeRequest,
  processIdentity,
  swayRequest,
} from "./nativeClient.ts";
import type { DesktopDefinition, DesktopStore } from "./store.ts";
import type { DesktopSessionBinding } from "./sessionBroker.ts";
import type { DesktopObservationStore } from "./observationStore.ts";
import {
  buildSwayCommand,
  decodeSwayQuery,
  resolveSwayCommand,
  swayQueryTypes,
} from "./swayTools.ts";
import { boundedSwayResult, describeSwayTree, swaySubtree } from "./swayState.ts";
import { checkDesktopPrerequisites } from "./prerequisites.ts";
import { DesktopInteraction, compactWindows } from "./interaction.ts";
import { desktopToolResult } from "./toolResult.ts";
import { launchOutcome } from "./launchOutcome.ts";

export interface DesktopPolicy {
  readonly desktopDefaultResolution?: DesktopResolution;
  readonly virtualDesktopsEnabled: boolean;
  readonly desktopControlMcpEnabled: boolean;
  readonly desktopObservationRetention: number;
}
interface Runtime {
  definition: DesktopDefinition;
  snapshot: { -readonly [K in keyof VirtualDesktopSnapshot]: VirtualDesktopSnapshot[K] };
  checked: number;
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const unavailable = () =>
  desktopError(
    "unavailable",
    "Virtual desktops require a local Linux runtime with Sway, Xwayland, D-Bus, and the Cafe desktop helper.",
  );
const decodeResolution = Schema.decodeUnknownOption(DesktopResolution);
function resolution(value: unknown): DesktopResolution {
  const decoded = decodeResolution(value);
  if (decoded._tag === "None")
    throw desktopError(
      "invalid_request",
      "Choose whole-number desktop dimensions from 320 to 2048 pixels.",
    );
  return decoded.value;
}

/** One instance belongs to the provider runtime, never to a renderer or RPC.
 * Durable definitions identify workers by boot + kernel process start time;
 * reconnecting does not launch duplicate compositors or trust recycled PIDs. */
export class DesktopManager {
  private readonly desktops = new Map<string, Runtime>();
  private readonly authority = new DesktopAuthority();
  private readonly bindings = this.authority.bindings;
  private readonly active = this.authority.active;
  private readonly interactions = new WeakMap<Binding, DesktopInteraction>();
  private readonly interacting = new WeakSet<Binding>();
  private initialized: Promise<void> | undefined;
  private mutation: Promise<unknown> = Promise.resolve();
  private ready = false;
  private prerequisites: VirtualDesktopPrerequisites | undefined;
  private reason: string | null = null;
  private boot = "";
  private root = "";
  private closed = false;
  private accessEpoch = 0;
  private previewReads = 0;
  private helper: string;
  private readonly bridgePath: string;
  private readonly supported: boolean;

  private readonly options: {
    store: DesktopStore;
    observations: Pick<DesktopObservationStore, "save" | "setRetention">;
    stateDir: string;
    mcpPort: number;
    policy: DesktopPolicy;
    supported?: boolean;
    helper?: string;
  };
  constructor(options: DesktopManager["options"]) {
    this.options = options;
    this.helper = options.helper ?? nativeHelperPath();
    this.supported = (options.supported ?? true) && process.platform === "linux";
    this.bridgePath = fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "../../dist/desktop-mcp-bridge.mjs"
          : "./desktop-mcp-bridge.mjs",
        import.meta.url,
      ),
    );
  }
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(f);
    this.mutation = result.catch(() => undefined);
    return result;
  }
  private initialize() {
    return (this.initialized ??= (async () => {
      if (!this.supported) {
        this.reason = "Virtual desktops are available on Linux with the local provider runtime.";
        return;
      }
      this.boot = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      // Short private socket paths also work when Cafe's data directory is long.
      const parent = `/run/user/${process.getuid?.()}`;
      const info = await fs.lstat(parent);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077
      )
        throw unavailable();
      this.root = desktopRuntimeDirectory(this.options.stateDir, process.getuid!());
      await fs.mkdir(this.root, { mode: 0o700 });
    })()
      .catch(async (error: unknown) => {
        // An existing private runtime directory is the normal adoption path.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          this.root = "";
          this.reason =
            "A private Linux user runtime directory is required. Start Cafe from your logged-in desktop session.";
        }
      })
      .then(async () => {
        if (!this.supported) return;
        if (!this.root) {
          await this.check();
          return;
        }
        const info = await fs.lstat(this.root);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          info.uid !== process.getuid?.() ||
          info.mode & 0o077
        )
          throw unavailable();
        // Copy the native executable out of transient AppImage mounts. Its
        // content-addressed private path stays usable across renderer restarts.
        try {
          const bytes = await fs.readFile(this.helper);
          const copied = path.join(
            this.root,
            "cafe-desktop-native." + createHash("sha256").update(bytes).digest("hex").slice(0, 16),
          );
          try {
            await fs.writeFile(copied, bytes, { flag: "wx", mode: 0o700 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const handle = await fs.open(copied, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try {
              const info = await handle.stat();
              if (
                !info.isFile() ||
                info.uid !== process.getuid?.() ||
                info.mode & 0o077 ||
                info.nlink !== 1 ||
                !bytes.equals(await handle.readFile())
              )
                throw unavailable();
            } finally {
              await handle.close();
            }
          }
          this.helper = copied;
        } catch {
          /* readiness reports a missing helper; no worker is spawned */
        }
        for (const definition of await this.options.store.list()) {
          const runtime: Runtime = {
            definition,
            checked: 0,
            snapshot: {
              id: definition.id,
              name: definition.name,
              state: definition.state,
              reason: null,
              humanControl: false,
              viewerOpen: false,
              renderer: "gles2",
              transfer: "shared-memory",
              controllingThreadId: null,
            },
          };
          this.desktops.set(definition.id, runtime);
          const privateDirectory =
            this.ownsDirectory(definition) &&
            (await fs.lstat(definition.directory).then(
              (info) =>
                info.isDirectory() &&
                !info.isSymbolicLink() &&
                info.uid === process.getuid!() &&
                (info.mode & 0o077) === 0,
              () => false,
            ));
          if (
            definition.boot_id !== this.boot ||
            !definition.pid ||
            (await processIdentity(definition.pid)) !== definition.process_start
          ) {
            await this.forgetExited(runtime);
          } else if (!privateDirectory) {
            // Missing transport files are not evidence of process exit. Retain
            // the exact process identity so End desktop can still retry cleanup.
            runtime.snapshot.state = "failed";
            runtime.snapshot.reason =
              "Desktop ownership could not be verified. End this desktop to clean up its session.";
          } else {
            // A backend crash can leave a durable starting/terminating marker.
            // Ask the authenticated live worker before deciding its new state.
            runtime.snapshot.state = "reconnecting";
          }
        }
        await this.check();
        await this.refresh();
        await this.pushPolicy();
      }));
  }
  private async check() {
    this.prerequisites = await checkDesktopPrerequisites(this.helper);
    this.ready =
      Boolean(this.root) &&
      Object.values(this.prerequisites).every((status) => status === "installed");
    // Installing packages cannot repair an unsafe/missing user runtime directory.
    // Preserve that actionable session error even when all components are present.
    if (this.root)
      this.reason = this.ready
        ? null
        : "Desktop setup needs attention. Review the required components in Settings → Desktop control.";
  }
  private bootstrap(r: Runtime) {
    return path.join(r.definition.directory, "bootstrap.json");
  }
  private ownsDirectory(definition: DesktopDefinition) {
    return isDesktopInstanceDirectory(
      definition.directory,
      this.options.stateDir,
      process.getuid!(),
      definition.incarnation,
    );
  }
  private async request(r: Runtime, body: unknown, signal?: AbortSignal) {
    const result = await nativeRequest(this.helper, this.bootstrap(r), body, signal);
    if (typeof result.error === "string")
      throw desktopError(
        result.error === "human_control_active" || result.error === "desktop_busy"
          ? "busy"
          : "operation_failed",
        result.error === "human_control_active"
          ? "The human has control. Use take_control explicitly to reclaim this desktop, then observe before acting."
          : result.error === "observation_required"
            ? "Control or screenshot geometry changed. Observe the desktop again before acting."
            : "The desktop could not complete this operation. Observe its state before repeating it.",
      );
    return result;
  }
  private async refresh() {
    const candidates = [...this.desktops.values()].filter(
      (r) =>
        !["starting", "terminating"].includes(r.snapshot.state) && Date.now() - r.checked > 2000,
    );
    // Small fixed batches avoid a burst of encoder children on reconnect.
    for (let i = 0; i < candidates.length; i += 4)
      await Promise.all(
        candidates.slice(i, i + 4).map(async (r) => {
          r.checked = Date.now();
          if (r.definition.pid === null) {
            await this.forgetExited(r);
            return;
          }
          try {
            const result = await this.request(r, { method: "status" });
            const previous = this.active.get(r.definition.id);
            if (previous && !previous.active) await this.end(previous);
            Object.assign(r.snapshot, {
              state: "ready",
              reason: null,
              humanControl: result.humanControl === true,
              viewerOpen: result.viewerOpen === true,
              renderer: result.renderer === "pixman" ? "pixman" : "gles2",
              transfer: result.transfer === "dma-buf" ? "dma-buf" : "shared-memory",
            });
            this.applyDisplay(r, result);
          } catch {
            const same =
              r.definition.pid &&
              (await processIdentity(r.definition.pid)) === r.definition.process_start;
            r.snapshot.state = same ? "reconnecting" : "failed";
            r.snapshot.reason = same
              ? "The desktop worker is reconnecting."
              : "The desktop worker exited. Create a new desktop to continue.";
            if (!same) {
              await this.forgetExited(r);
            }
          }
        }),
      );
  }
  async state(threadId?: ThreadId): Promise<VirtualDesktopState> {
    await this.initialize();
    // Refresh can now retire exited sessions. Serialize it with creation/end so
    // a delayed status read cannot resurrect an entry deleted by another request.
    return this.serial(() => this.readState(threadId));
  }
  private async readState(threadId?: ThreadId): Promise<VirtualDesktopState> {
    await this.refresh();
    const selectedDesktopId = threadId ? await this.options.store.selected(threadId) : null;
    const binding = threadId
      ? [...this.active.values()].find((b) => b.threadId === threadId)
      : undefined;
    return {
      supported: this.supported,
      enabled: this.options.policy.virtualDesktopsEnabled,
      controlEnabled: this.options.policy.desktopControlMcpEnabled,
      available: this.ready,
      defaultResolution: this.options.policy.desktopDefaultResolution ?? DEFAULT_DESKTOP_RESOLUTION,
      ...(this.prerequisites ? { prerequisites: this.prerequisites } : {}),
      reason: this.reason,
      desktops: [...this.desktops.values()].map((r) => {
        const owner = this.active.get(r.definition.id);
        return {
          ...r.snapshot,
          reason:
            owner && !owner.active
              ? "Desktop input cleanup is pending. Retry the next turn shortly."
              : r.snapshot.reason,
          controllingThreadId: owner?.threadId ?? null,
        };
      }),
      selectedDesktopId,
      activeDesktopId: binding?.desktopId ?? null,
      selectionPending: Boolean(binding && binding.desktopId !== selectedDesktopId),
    };
  }
  async manage(input: VirtualDesktopRequest): Promise<VirtualDesktopState> {
    await this.initialize();
    if (input.operation === "status") return this.state(input.threadId);
    return this.serial(async () => {
      if (!this.supported) throw unavailable();
      if (input.operation === "recheck") await this.check();
      else if (input.operation === "create") {
        if (!this.options.policy.virtualDesktopsEnabled)
          throw desktopError("feature_disabled", "Enable Virtual desktops in Settings first.");
        if (!this.ready) throw unavailable();
        const r = await this.create(
          input.name,
          resolution(
            input.resolution ??
              this.options.policy.desktopDefaultResolution ??
              DEFAULT_DESKTOP_RESOLUTION,
          ),
        );
        if (input.threadId) await this.options.store.attach(input.threadId, r.definition.id);
      } else if (input.operation === "attach") {
        if (!input.threadId || input.id === undefined)
          throw desktopError("invalid_request", "Choose a conversation and desktop.");
        if (input.id !== null) {
          const r = this.require(input.id);
          if (!this.options.policy.virtualDesktopsEnabled || r.snapshot.state !== "ready")
            throw desktopError("unavailable", "This desktop is not ready.");
          // The picker is a snapshot, not a reservation. Reject a stale
          // selection without changing it or revoking the current turn.
          this.authority.requireAvailable(input.threadId, input.id);
        }
        await this.options.store.attach(input.threadId, input.id);
      } else {
        // End is safe to repeat after a lost reply or concurrent exit cleanup.
        if (
          ["end", "terminate", "delete"].includes(input.operation) &&
          input.id &&
          !this.desktops.has(input.id)
        )
          return this.readState(input.threadId);
        const r = this.require(input.id);
        if (input.operation === "rename") {
          if (!input.name?.trim()) throw desktopError("invalid_request", "Enter a desktop name.");
          r.definition = { ...r.definition, name: input.name.trim() };
          r.snapshot.name = r.definition.name;
          await this.options.store.put(r.definition);
        } else if (input.operation === "end" || input.operation === "terminate")
          await this.terminate(r);
        else if (input.operation === "delete") await this.deleteStopped(r);
        else if (input.operation === "set-display") {
          if (!this.options.policy.virtualDesktopsEnabled || r.snapshot.state !== "ready")
            throw unavailable();
          if (!r.snapshot.canResize)
            throw desktopError(
              "unavailable",
              "End this desktop and create a new one to enable display changes.",
            );
          const requested = resolution(input.resolution);
          for (const b of this.bindings.values())
            if (b.desktopId === r.definition.id) b.observedEpoch = undefined;
          const result = await this.request(r, { method: "configure-display", ...requested });
          this.applyDisplay(r, result);
        }
      }
      return this.readState(input.threadId);
    });
  }
  private require(id: string | null | undefined) {
    const r = id ? this.desktops.get(id) : undefined;
    if (!r) throw desktopError("not_found", "This virtual desktop no longer exists.");
    return r;
  }
  private async create(name: string | undefined, display: DesktopResolution) {
    if (this.desktops.size >= 64)
      throw desktopError("busy", "Finish pending desktop cleanup before creating another desktop.");
    if (
      [...this.desktops.values()].filter(
        (r) => r.definition.pid !== null || !["stopped", "failed"].includes(r.snapshot.state),
      ).length >= 8
    )
      throw desktopError("busy", "End a desktop before creating another (maximum eight running).");
    const id = randomUUID(),
      incarnation = randomUUID(),
      directory = desktopInstanceDirectory(this.options.stateDir, process.getuid!(), incarnation);
    await fs.mkdir(directory, { mode: 0o700 });
    const r: Runtime = {
      definition: {
        id,
        name: name?.trim() || `Desktop ${this.desktops.size + 1}`,
        incarnation,
        directory,
        boot_id: this.boot,
        pid: null,
        process_start: null,
        state: "starting",
        created_at: Date.now(),
      },
      checked: 0,
      snapshot: {
        id,
        name: name?.trim() || `Desktop ${this.desktops.size + 1}`,
        state: "starting",
        resolution: display,
        canResize: true,
        reason: null,
        humanControl: false,
        viewerOpen: false,
        renderer: "gles2",
        transfer: "shared-memory",
        controllingThreadId: null,
      },
    };
    this.desktops.set(id, r);
    const devices = (await fs.readdir("/dev/dri").catch(() => []))
      .filter((v) => /^renderD\d+$/.test(v))
      .toSorted();
    try {
      await this.options.store.put(r.definition);
      for (const renderer of ["gles2", "pixman"] as const) {
        const bootstrap = {
          width: display.width,
          height: display.height,
          directory,
          socket: path.join(directory, "worker.sock"),
          helper: this.helper,
          sway: await executable("sway"),
          renderer,
          renderDevice: devices[0] ? `/dev/dri/${devices[0]}` : "",
          token: randomBytes(32).toString("hex"),
          viewerToken: randomBytes(32).toString("hex"),
        };
        await writeMcpFile(
          this.bootstrap(r),
          JSON.stringify(bootstrap),
          await readMcpFile(this.bootstrap(r), { private: true }),
        );
        const child = spawn(this.helper, ["worker", this.bootstrap(r)], {
          detached: true,
          stdio: "ignore",
          shell: false,
        });
        child.on("error", () => undefined);
        child.unref();
        r.definition = {
          ...r.definition,
          pid: child.pid ?? null,
          process_start: child.pid ? await processIdentity(child.pid) : null,
        };
        await this.options.store.put(r.definition);
        let success = false;
        for (let i = 0; i < 100; i++) {
          await sleep(200);
          if (
            child.exitCode !== null ||
            !r.definition.pid ||
            (await processIdentity(r.definition.pid)) !== r.definition.process_start
          )
            break;
          if (
            !(await fs.access(path.join(directory, "worker.sock")).then(
              () => true,
              () => false,
            ))
          )
            continue;
          try {
            const frame = await this.request(r, { method: "observe" });
            if (frame.width !== display.width || frame.height !== display.height)
              throw unavailable();
            this.applyDisplay(r, frame);
            success = true;
            break;
          } catch {
            break;
          }
        }
        if (success) {
          r.snapshot = { ...r.snapshot, state: "ready", renderer };
          r.definition = { ...r.definition, state: "ready" };
          await this.options.store.put(r.definition);
          await this.request(r, {
            method: "policy",
            viewerEnabled: this.options.policy.virtualDesktopsEnabled,
            controlEnabled:
              this.options.policy.virtualDesktopsEnabled &&
              this.options.policy.desktopControlMcpEnabled,
          });
          return r;
        }
        // Retrying a renderer is permitted only after this exact owned worker
        // exits and its subreaper finishes closing the failed session's apps.
        await this.stopOwned(r);
        // All files belong to this failed attempt, including exclusive-create
        // D-Bus service definitions/readiness and compositor socket lockfiles.
        // Only recreate the private directory after verified worker exit; a
        // filename allowlist inevitably leaves state that poisons pixman retry.
        await fs.rm(directory, { recursive: true, force: true });
        await fs.mkdir(directory, { mode: 0o700 });
      }
      throw unavailable();
    } catch (error) {
      // Failed creation has the same ownership/cleanup requirements as End.
      // In particular, a stuck child must remain a retryable failed entry.
      await this.terminate(r);
      throw error;
    }
  }
  private async stopOwned(r: Runtime) {
    if (
      !r.definition.pid ||
      r.definition.boot_id !== this.boot ||
      (await processIdentity(r.definition.pid)) !== r.definition.process_start
    )
      return;
    try {
      await this.request(r, { method: "terminate" });
    } catch {
      process.kill(r.definition.pid, "SIGTERM");
    }
    for (let i = 0; i < 50; i++) {
      if ((await processIdentity(r.definition.pid)) !== r.definition.process_start) return;
      await sleep(100);
    }
    // Killing a stuck subreaper would orphan its descendants. Keep the failure
    // visible and leave explicit process-reaper recovery to the desktop owner.
    throw desktopError(
      "operation_failed",
      "The desktop is still shutting down. Try End desktop again shortly.",
    );
  }
  private async terminate(r: Runtime) {
    await this.revokeDesktop(r.definition.id);
    r.snapshot.state = "terminating";
    try {
      await this.stopOwned(r);
    } catch (error) {
      // Keep an owned but stuck worker visible and retryable. Do not strand
      // the UI in a disabled "terminating" row or kill its subreaper early.
      r.snapshot.state = "failed";
      r.snapshot.reason = "Shutdown is still pending. Retry End desktop shortly.";
      r.definition = { ...r.definition, state: "failed" };
      await this.options.store.put(r.definition);
      throw error;
    }
    await this.forgetExited(r);
    if (this.desktops.has(r.definition.id))
      throw desktopError(
        "operation_failed",
        "Desktop cleanup is pending. Retry End desktop shortly.",
      );
  }
  private async forgetExited(r: Runtime) {
    // Only callers with verified exit/previous-boot evidence may cross this
    // boundary. Persist that proof before deleting private runtime files, then
    // atomically remove the definition and chat selections. Failed cleanup
    // stays retryable; saved observations and real app data are never touched.
    r.definition = { ...r.definition, state: "stopped", pid: null, process_start: null };
    r.snapshot = { ...r.snapshot, state: "stopped", viewerOpen: false, humanControl: false };
    try {
      await this.revokeDesktop(r.definition.id);
      await this.options.store.put(r.definition);
      await this.deleteStopped(r);
    } catch {
      r.snapshot.state = "failed";
      r.snapshot.reason = "Desktop cleanup is pending. Retry End desktop shortly.";
    }
  }
  private async deleteStopped(r: Runtime) {
    if (
      r.snapshot.state !== "stopped" ||
      r.definition.pid !== null ||
      r.definition.process_start !== null
    )
      throw desktopError("busy", "End this desktop before removing it.");
    await this.revokeDesktop(r.definition.id);
    // Remove only this incarnation's private files, after its durable exit
    // proof. A failed removal leaves the definition available for retry.
    if (this.ownsDirectory(r.definition))
      await fs.rm(r.definition.directory, { recursive: true, force: true });
    if (!(await this.options.store.deleteStopped(r.definition.id)))
      throw desktopError("busy", "Desktop cleanup is still pending. Retry End desktop.");
    this.desktops.delete(r.definition.id);
  }
  private applyDisplay(r: Runtime, value: Record<string, unknown>) {
    const decoded = decodeResolution(value);
    if (decoded._tag === "Some") r.snapshot.resolution = decoded.value;
    r.snapshot.canResize = value.displayConfiguration === true;
  }
  /** Owner-only card captures are transient, never observations in a conversation.
   * Bound encoder concurrency and recheck policy/incarnation after capture so a
   * disable or termination during the read cannot publish a stale private frame. */
  async preview(id: string, signal?: AbortSignal) {
    await this.initialize();
    if (this.closed || !this.options.policy.virtualDesktopsEnabled)
      throw desktopError("feature_disabled", "Desktop previews are disabled.");
    const r = this.require(id);
    if (r.snapshot.state !== "ready") throw desktopError("unavailable", "Desktop is not ready.");
    if (this.previewReads >= 2) throw desktopError("busy", "Desktop previews are busy.");
    const epoch = this.accessEpoch;
    const incarnation = r.definition.incarnation;
    this.previewReads++;
    try {
      const result = await this.request(r, { method: "observe", preview: true }, signal);
      if (
        this.closed ||
        epoch !== this.accessEpoch ||
        !this.options.policy.virtualDesktopsEnabled ||
        this.desktops.get(id) !== r ||
        r.definition.incarnation !== incarnation ||
        r.snapshot.state !== "ready"
      )
        throw desktopError("unavailable", "Desktop preview is no longer available.");
      return { image: result.image };
    } finally {
      this.previewReads--;
    }
  }
  async connect(
    id: string,
    hostEnvironment: Readonly<Record<string, string>>,
    appearance?: DesktopViewerAppearance,
  ) {
    await this.initialize();
    return this.serial(async () => {
      if (!this.options.policy.virtualDesktopsEnabled)
        throw desktopError("feature_disabled", "Virtual desktops are disabled.");
      const r = this.require(id);
      if (r.snapshot.state !== "ready")
        throw desktopError("unavailable", "This desktop is not ready.");
      const state = await this.request(r, { method: "show" });
      if (state.viewerOpen) return;
      const bootstrap = record(
        JSON.parse((await readMcpFile(this.bootstrap(r), { private: true })) ?? "null"),
      );
      const file = path.join(r.definition.directory, "viewer.json");
      await writeMcpFile(
        file,
        JSON.stringify({
          socket: bootstrap.socket,
          token: bootstrap.viewerToken,
          name: r.definition.name,
          appearance: appearance ?? { dark: true, scale: 1 },
        }),
        await readMcpFile(file, { private: true }),
      );
      const environment = { ...process.env };
      for (const name of [
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
        "XAUTHORITY",
        "DBUS_SESSION_BUS_ADDRESS",
      ]) {
        delete environment[name];
        if (hostEnvironment[name]) environment[name] = hostEnvironment[name];
      }
      const child = spawn(this.helper, ["viewer", file], {
        detached: true,
        stdio: "ignore",
        shell: false,
        env: environment,
      });
      child.on("error", () => undefined);
      child.unref();
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        const status = await this.request(r, { method: "status" });
        if (status.viewerOpen) {
          r.snapshot.viewerOpen = true;
          return;
        }
        if (child.exitCode !== null) break;
      }
      throw desktopError("operation_failed", "The desktop viewer could not open on this display.");
    });
  }
  async setPolicy(policy: DesktopPolicy) {
    if (
      policy.virtualDesktopsEnabled !== this.options.policy.virtualDesktopsEnabled ||
      policy.desktopControlMcpEnabled !== this.options.policy.desktopControlMcpEnabled
    )
      this.accessEpoch++;
    this.options.policy = policy;
    // Screenshot cleanup is auxiliary. A storage failure must never prevent
    // access revocation or viewer/input policy from reaching the native worker;
    // the observation writer's maintenance sweep retries retired intents.
    await this.options.observations
      .setRetention(policy.desktopObservationRetention)
      .catch(() => undefined);
    if (!this.initialized) return;
    await this.initialize();
    if (!policy.virtualDesktopsEnabled || !policy.desktopControlMcpEnabled)
      for (const b of this.bindings.values()) await this.revoke(b);
    await this.pushPolicy();
  }
  private async pushPolicy() {
    await Promise.all(
      [...this.desktops.values()]
        .filter((r) => r.snapshot.state === "ready")
        .map((r) =>
          this.request(r, {
            method: "policy",
            viewerEnabled: this.options.policy.virtualDesktopsEnabled,
            controlEnabled:
              this.options.policy.virtualDesktopsEnabled &&
              this.options.policy.desktopControlMcpEnabled,
          }).catch(() => undefined),
        ),
    );
  }
  async inherit(source: ThreadId, target: ThreadId) {
    await this.options.store.attach(target, await this.options.store.selected(source));
  }
  async detach(threadId: ThreadId) {
    await this.options.store.attach(threadId, null);
  }
  disabledBinding() {
    return { bridgePath: this.bridgePath, connectionPath: null };
  }
  async signature(threadId: ThreadId) {
    if (
      !this.supported ||
      !this.options.policy.virtualDesktopsEnabled ||
      !this.options.policy.desktopControlMcpEnabled
    )
      return "disabled";
    await this.initialize();
    const id = await this.options.store.selected(threadId);
    const r = id ? this.desktops.get(id) : undefined;
    return this.options.policy.virtualDesktopsEnabled &&
      this.options.policy.desktopControlMcpEnabled &&
      r?.snapshot.state === "ready"
      ? `${id}:${r.definition.incarnation}:${this.accessEpoch}`
      : "disabled";
  }
  async bind(threadId: ThreadId): Promise<DesktopSessionBinding> {
    const signature = await this.signature(threadId);
    // A disabled definition is still a complete valid transport, so inherited
    // configuration cannot accidentally enable an unattached conversation.
    if (signature === "disabled")
      return {
        signature,
        connectionPath: null,
        bridgePath: this.bridgePath,
        startTurn: async () => {},
        endTurn: async () => {},
        dispose: async () => {},
      };
    const id = await this.options.store.selected(threadId);
    const r = this.require(id);
    for (const existing of this.bindings.values())
      if (existing.threadId === threadId) await this.revoke(existing);
    const token = randomBytes(32).toString("hex"),
      key = digest(token);
    const connectionPath = path.join(r.definition.directory, `session-${randomUUID()}.json`);
    const bridgePath = path.join(r.definition.directory, "desktop-mcp-bridge.mjs");
    const bridge = await fs.readFile(this.bridgePath, "utf8");
    await writeMcpFile(bridgePath, bridge, await readMcpFile(bridgePath, { private: true }));
    const binding: Binding = {
      threadId,
      desktopId: r.definition.id,
      incarnation: r.definition.incarnation,
      active: false,
      revoked: false,
      controllers: new Set(),
      connectionPath,
    };
    await writeMcpFile(
      connectionPath,
      JSON.stringify({
        audience: "cafe-desktop",
        url: `http://127.0.0.1:${this.options.mcpPort}/mcp/desktop`,
        token,
      }),
      undefined,
    );
    this.bindings.set(key, binding);
    return {
      signature,
      connectionPath,
      bridgePath,
      startTurn: () => this.start(binding),
      endTurn: () => this.end(binding),
      dispose: async () => {
        await this.revoke(binding);
        this.bindings.delete(key);
      },
    };
  }
  private async start(b: Binding) {
    const previous = this.active.get(b.desktopId);
    if (previous && !previous.active) await this.end(previous);
    this.authority.start(b);
  }
  private async end(b: Binding) {
    const r = this.desktops.get(b.desktopId);
    await this.authority
      .end(b, async () => {
        // A verified dead worker cannot deliver a late cancel. A reconnecting
        // worker still can, so it must acknowledge cleanup just like a ready one.
        if (r && r.definition.pid !== null) {
          const result = await this.request(r, { method: "cancel" });
          if (result.ok !== true)
            throw desktopError("operation_failed", "Desktop input cleanup was not acknowledged.");
        }
      })
      .catch(() => {
        // Keep provider completion/revocation progressing, while authority keeps
        // its inactive reservation. No new turn can act until cleanup succeeds.
        if (r) r.snapshot.reason = "Desktop input cleanup is pending. Retry the next turn shortly.";
      });
  }
  private async revoke(b: Binding) {
    b.revoked = true;
    await this.end(b);
    await fs.rm(b.connectionPath, { force: true });
  }
  private async revokeDesktop(id: string) {
    const bindings = new Set([...this.bindings.values()].filter((b) => b.desktopId === id));
    const owner = this.active.get(id);
    // A disposed session may still reserve input while its cancellation is
    // uncertain. Keep that reservation discoverable for verified-exit cleanup.
    if (owner) bindings.add(owner);
    for (const b of bindings) await this.revoke(b);
  }
  authorize(token: string) {
    return this.authority.authorize(
      token,
      !this.closed &&
        this.options.policy.virtualDesktopsEnabled &&
        this.options.policy.desktopControlMcpEnabled,
    );
  }
  async tool(
    token: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const started = Date.now();
    const b = this.authorize(token);
    const r = this.require(b.desktopId);
    r.snapshot.toolUsage ??= {
      calls: 0,
      actions: 0,
      captures: 0,
      screenshots: 0,
      screenshotPixels: 0,
      unchangedCaptures: 0,
      failures: 0,
      durationMs: 0,
      replyTextChars: 0,
    };
    const count = (name: keyof DesktopToolUsage, amount = 1) => {
      r.snapshot.toolUsage = {
        ...r.snapshot.toolUsage!,
        [name]: Math.min(Number.MAX_SAFE_INTEGER, (r.snapshot.toolUsage?.[name] ?? 0) + amount),
      };
    };
    count("calls");
    try {
      const result = await this.runTool(token, name, args, signal, count);
      const output = desktopToolResult(result);
      count("replyTextChars", output.text?.length ?? 0);
      if (output.isError) count("failures");
      return result;
    } catch (error) {
      count("failures");
      throw error;
    } finally {
      count("durationMs", Math.max(0, Date.now() - started));
    }
  }
  private async runTool(
    token: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    count: (name: keyof DesktopToolUsage, amount?: number) => void,
  ): Promise<unknown> {
    const b = this.authorize(token);
    this.authority.requireTurn(b);
    const r = this.require(b.desktopId);
    if (r.snapshot.state !== "ready" || r.definition.incarnation !== b.incarnation)
      throw desktopError("unavailable", "This desktop incarnation is unavailable.");
    if (b.controllers.size >= 4)
      throw desktopError("busy", "Too many desktop requests are in flight.");
    // A sequence, observation, or window mutation owns this lane until its
    // reply settles. Reject competing calls instead of queuing stale input.
    // Human takeover and root-turn cancellation bypass this model-only lane.
    const stateful = !["list_apps", "windows", "workspaces", "sway_query", "get_display"].includes(
      name,
    );
    if (stateful && this.interacting.has(b))
      throw desktopError(
        "busy",
        "Another desktop operation is in progress. Wait for its result before continuing.",
      );
    if (stateful) this.interacting.add(b);
    const controller = new AbortController();
    b.controllers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const check = (signal: AbortSignal) => {
      this.authority.requireTurn(b);
      if (
        signal.aborted ||
        !this.options.policy.desktopControlMcpEnabled ||
        !this.options.policy.virtualDesktopsEnabled ||
        r.snapshot.state !== "ready" ||
        r.definition.incarnation !== b.incarnation
      )
        throw desktopError("unavailable", "Desktop access changed or the operation was cancelled.");
    };
    let interaction = this.interactions.get(b);
    if (!interaction) {
      interaction = new DesktopInteraction({
        request: (body, signal) => {
          check(signal);
          return this.request(r, body, signal);
        },
        tree: (signal) => {
          check(signal);
          return this.tree(r, signal);
        },
        publish: async (frame) => {
          this.applyDisplay(r, {
            ...frame,
            width: frame.desktopWidth ?? frame.width,
            height: frame.desktopHeight ?? frame.height,
          });
          return this.options.observations.save(b.threadId, frame);
        },
        check,
        observed: (epoch) => {
          b.observedEpoch = epoch;
        },
        epoch: () => b.observedEpoch,
        count,
      });
      this.interactions.set(b, interaction);
    }
    try {
      check(controller.signal);
      if (name === "take_control") {
        // Reclaiming is explicit, scoped to this active root-turn capability.
        // Invalidate the last observation before dispatch, including uncertain
        // outcomes; a later mutation must use a fresh worker ownership epoch.
        b.observedEpoch = undefined;
        interaction.invalidate();
        const result = await this.request(r, { method: "take-control" }, controller.signal);
        r.snapshot.humanControl = result.humanControl === true;
        return { humanControl: result.humanControl, observeBeforeActing: true };
      }
      if (name === "observe") {
        return await interaction.observe(args, controller.signal);
      }
      if (name === "list_apps") {
        if (args.query !== undefined && (typeof args.query !== "string" || args.query.length > 160))
          throw desktopError(
            "invalid_request",
            "Use an application search query up to 160 characters.",
          );
        const query = String(args.query ?? "").toLowerCase();
        return (await listDesktopApps())
          .filter(({ id, name }) => `${id} ${name}`.toLowerCase().includes(query))
          .map(({ id, name }) => ({ id, name }));
      }
      if (name === "get_display") {
        const result = await this.request(r, { method: "status" }, controller.signal);
        this.applyDisplay(r, result);
        return {
          width: result.width,
          height: result.height,
          canResize: result.displayConfiguration === true,
        };
      }
      if (name === "set_display") {
        if (!r.snapshot.canResize)
          throw desktopError("unavailable", "Create a new desktop to enable display changes.");
        const requested = resolution(args);
        if (b.observedEpoch === undefined)
          throw desktopError(
            "operation_failed",
            "Observe this desktop before changing its display.",
          );
        const epoch = b.observedEpoch;
        b.observedEpoch = undefined;
        interaction.invalidate();
        const result = await this.request(
          r,
          { method: "set-display", ...requested, controlEpoch: epoch },
          controller.signal,
        );
        this.applyDisplay(r, result);
        return { width: result.width, height: result.height, observeBeforeActing: true };
      }
      if (name === "windows") {
        const state = await this.tree(r, controller.signal);
        return boundedSwayResult(args.detail === true ? state : compactWindows(state));
      }
      if (name === "workspaces")
        return boundedSwayResult(await this.query(r, 1, controller.signal));
      if (name === "sway_query") {
        const query = decodeSwayQuery(args);
        const state = await this.query(r, swayQueryTypes[query.query], controller.signal);
        return boundedSwayResult(
          query.containerId === undefined ? state : swaySubtree(state, query.containerId),
        );
      }
      const command = buildSwayCommand(name, args);
      if (command) {
        let syntax = command.command;
        if (b.observedEpoch === undefined)
          throw desktopError(
            "operation_failed",
            "Observe this desktop before changing windows or workspaces.",
          );
        if (command.windowIds.length || command.containerIds.length) {
          const state = await this.tree(r, controller.signal);
          if (
            command.windowIds.some((id) => !state.windows.some((window) => window.id === id)) ||
            command.containerIds.some(
              (id) =>
                !state.containers.some(
                  (container) =>
                    container.id === id &&
                    ["con", "floating_con", "workspace"].includes(container.type),
                ),
            )
          )
            throw desktopError(
              "not_found",
              "The target no longer exists or is outside the bounded window list. Inspect the desktop again.",
            );
          syntax = resolveSwayCommand(command, state);
        }
        // Mutations must go through the worker, which checks human takeover and
        // the observed epoch immediately before IPC dispatch. Reading a Sway
        // socket in this process must never become an input-policy bypass.
        const result = await this.request(
          r,
          {
            method: "sway_command",
            command: syntax,
            controlEpoch: b.observedEpoch,
            ...(command.restoreTarget === undefined
              ? {}
              : { restoreWindowId: command.restoreTarget }),
          },
          controller.signal,
        );
        return name !== "sway_command" && result.success === true && result.truncated !== true
          ? { ok: true }
          : result;
      }
      if (name === "launch") {
        if (b.observedEpoch === undefined)
          throw desktopError(
            "operation_failed",
            "Observe this desktop before launching an application.",
          );
        const { windows } = await this.tree(r, controller.signal);
        let command: string, argv: readonly string[];
        let terminal = args.terminal === true;
        if (typeof args.appId === "string") {
          const app = (await listDesktopApps()).find((v) => v.id === args.appId);
          if (!app) throw desktopError("not_found", "The application is not installed.");
          command = app.command;
          argv = app.args;
          terminal = app.terminal;
          if (app.terminal) ({ command, args: argv } = await terminalCommand(command, argv));
        } else {
          command = String(args.command ?? "");
          argv = Array.isArray(args.args) ? (args.args as string[]) : [];
          if (!command) throw desktopError("invalid_request", "Choose an appId or command.");
          if (args.terminal) ({ command, args: argv } = await terminalCommand(command, argv));
        }
        const resolved = await executable(command);
        if (!resolved)
          throw desktopError("unavailable", "The application command could not be found.");
        const launched = await this.request(
          r,
          { method: "launch", command: resolved, args: argv, controlEpoch: b.observedEpoch },
          controller.signal,
        );
        for (let i = 0; i < 15 && !controller.signal.aborted; i++) {
          await sleep(200);
          const { windows: next } = await this.tree(r, controller.signal);
          const created = next.filter((v) => !windows.some((old) => old.id === v.id));
          if (created.length)
            return launchOutcome(
              {},
              terminal,
              compactWindows({ windows: created, containers: [], truncated: false }).windows,
            );
        }
        check(controller.signal);
        // Old adopted workers have no launchId; never fabricate an exit or
        // probe an arbitrary PID. A missing/lost launch ACK is never replayed.
        const process =
          typeof launched.launchId === "number"
            ? await this.request(
                r,
                { method: "launch_status", launchId: launched.launchId },
                controller.signal,
              )
            : {};
        return launchOutcome(process, terminal, []);
      }
      if (name === "act") {
        if (b.observedEpoch === undefined)
          throw desktopError("operation_failed", "Observe this desktop before acting.");
        return await interaction.act(args, controller.signal);
      }
      throw desktopError("invalid_request", "Unknown desktop tool.");
    } finally {
      if (stateful) this.interacting.delete(b);
      b.controllers.delete(controller);
      signal?.removeEventListener("abort", abort);
    }
  }
  private async query(r: Runtime, type: number, signal?: AbortSignal) {
    const environment = record(
      JSON.parse(
        (await readMcpFile(path.join(r.definition.directory, "environment.json"), {
          private: true,
        })) ?? "null",
      ),
    );
    if (
      typeof environment.SWAYSOCK !== "string" ||
      path.dirname(environment.SWAYSOCK) !== r.definition.directory ||
      !/^sway-ipc\.\d+\.\d+\.sock$/.test(path.basename(environment.SWAYSOCK))
    )
      throw unavailable();
    const info = await fs.lstat(environment.SWAYSOCK);
    if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid!())
      throw unavailable();
    return swayRequest(environment.SWAYSOCK, type, "", signal);
  }
  private async tree(r: Runtime, signal?: AbortSignal) {
    return describeSwayTree(await this.query(r, 4, signal));
  }
  async terminateAll() {
    if (!this.initialized) await this.initialize();
    await this.serial(async () => {
      await Promise.all([...this.desktops.values()].map((r) => this.terminate(r)));
    });
  }
  async close() {
    this.closed = true;
    for (const b of this.bindings.values()) await this.revoke(b);
    this.bindings.clear();
  }
}
