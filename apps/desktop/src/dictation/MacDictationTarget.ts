// Native helper protocol owns exact stdio handles, one-shot dispatch and child retirement.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn, type ChildProcess } from "node:child_process";
// Native filesystem boundary: preserve descriptor, no-follow and bigint identity operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { lstatSync } from "node:fs";
// Native path boundary: preserve host drive, namespace and separator semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { isAbsolute } from "node:path";

/**
 * A deliberately small desktop-main-only client for the bundled macOS AX
 * helper. The helper owns the remote AXUIElement references; its random token
 * remains here and must never be sent to a renderer or persisted. The UI only
 * receives a sanitized success/failure and retains its draft on any failure.
 *
 * The macOS build must compile `apps/desktop/native/mac-dictation-target.swift`
 * to an executable and place it at a trusted, fixed path (an extraResource in
 * packaged builds). Native fields use a verified Accessibility write. The
 * user-approved web-editor path owns a bounded temporary clipboard snapshot
 * and one guarded paste inside that helper; this client exposes neither a
 * clipboard reader nor a general keyboard API. Never use a shell, osascript,
 * or a user-configured executable for this privileged boundary.
 */

export type MacDictationTargetFailureReason =
  | "accessibility_permission_required"
  | "clipboard_unavailable"
  | "helper_unavailable"
  | "helper_protocol_error"
  | "invalid_text"
  | "insertion_uncertain"
  | "target_changed"
  | "target_unavailable"
  | "target_unsupported";

export type MacDictationInsertionMethod = "accessibility" | "paste";

export type MacDictationTargetResult =
  | { readonly ok: true; readonly insertionMethod?: MacDictationInsertionMethod }
  | {
      readonly ok: false;
      readonly reason: MacDictationTargetFailureReason;
      readonly uncertain: boolean;
    };

export interface MacDictationTargetClient {
  /** Capture the current frontmost app/window/editable field before the HUD is shown. */
  capture(): Promise<MacDictationTargetResult>;
  /** One shot. Never retry, even if the helper times out after dispatch. */
  insert(text: string): Promise<MacDictationTargetResult>;
  /** Forget the captured field on Cancel, Copy, or Save. */
  discard(): Promise<void>;
  /** Stop the private helper and invalidate queued operations. */
  dispose(): void;
}

type Command = "capture" | "insert" | "discard";
type NativeFailureCode =
  | "accessibility_permission_required"
  | "clipboard_unavailable"
  | "insertion_uncertain"
  | "invalid_request"
  | "invalid_token"
  | "target_changed"
  | "target_unavailable"
  | "target_unsupported";

type HelperResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly token?: string;
      readonly insertionMethod?: MacDictationInsertionMethod;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly code: NativeFailureCode;
      readonly uncertain: boolean;
    };

type Pending = {
  readonly id: number;
  readonly resolve: (response: HelperResponse | null) => void;
  readonly timeout: NodeJS.Timeout;
};

const maximumResponseBytes = 4096;
const maximumInsertionUTF8Bytes = 256 * 1024;
const maximumRequestBytes = 512 * 1024;
const tokenPattern = /^[a-f0-9]{64}$/u;
const nativeFailureCodes = new Set<NativeFailureCode>([
  "accessibility_permission_required",
  "clipboard_unavailable",
  "insertion_uncertain",
  "invalid_request",
  "invalid_token",
  "target_changed",
  "target_unavailable",
  "target_unsupported",
]);

type SpawnChild = (executablePath: string) => ChildProcess;

export interface MacDictationTargetClientOptions {
  /** A Cafe-packaged executable path, selected by trusted desktop-main code. */
  readonly executablePath: string;
  /** Narrow test seam; production always uses a direct, shell-free child. */
  readonly spawnChild?: SpawnChild;
  readonly requestTimeoutMs?: number;
}

function failed(
  reason: MacDictationTargetFailureReason,
  uncertain = false,
): MacDictationTargetResult {
  return { ok: false, reason, uncertain };
}

function decodeResponse(value: unknown, expectedId: number): HelperResponse | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.id !== expectedId || typeof record.ok !== "boolean") {
    return null;
  }
  if (record.ok) {
    if (
      record.insertionMethod !== undefined &&
      record.insertionMethod !== "accessibility" &&
      record.insertionMethod !== "paste"
    ) {
      return null;
    }
    const method = record.insertionMethod;
    const insertionMethod: { readonly insertionMethod?: MacDictationInsertionMethod } =
      method === undefined ? {} : { insertionMethod: method };
    if (typeof record.token === "undefined")
      return { id: expectedId, ok: true, ...insertionMethod };
    return typeof record.token === "string" && tokenPattern.test(record.token)
      ? { id: expectedId, ok: true, token: record.token, ...insertionMethod }
      : null;
  }
  if (
    typeof record.code !== "string" ||
    !nativeFailureCodes.has(record.code as NativeFailureCode) ||
    typeof record.uncertain !== "boolean"
  ) {
    return null;
  }
  return {
    id: expectedId,
    ok: false,
    code: record.code as NativeFailureCode,
    uncertain: record.uncertain,
  };
}

function mapNativeFailure(
  response: Extract<HelperResponse, { ok: false }>,
): MacDictationTargetResult {
  const reason =
    response.code === "invalid_request" || response.code === "invalid_token"
      ? "helper_protocol_error"
      : response.code;
  return failed(reason, response.uncertain);
}

function defaultSpawnChild(executablePath: string): ChildProcess {
  // Deliberately pass an empty environment and no arguments. The draft is sent
  // only over the private stdin pipe and stderr is never inherited or logged.
  return spawn(executablePath, [], {
    cwd: "/",
    env: {},
    shell: false,
    stdio: ["pipe", "pipe", "ignore"],
  });
}

class MacDictationTargetClientImpl implements MacDictationTargetClient {
  private readonly executablePath: string;
  private readonly spawnChild: SpawnChild;
  private readonly requestTimeoutMs: number;
  private child: ChildProcess | null = null;
  private pending: Pending | null = null;
  private output = Buffer.alloc(0);
  private token: string | null = null;
  private nextRequestId = 1;
  private revision = 0;
  private disposed = false;
  private serial: Promise<void> = Promise.resolve();
  private transportFailureReason: "helper_unavailable" | "helper_protocol_error" =
    "helper_unavailable";

  constructor(options: MacDictationTargetClientOptions) {
    this.executablePath = options.executablePath;
    this.spawnChild = options.spawnChild ?? defaultSpawnChild;
    this.requestTimeoutMs = Math.max(100, Math.min(options.requestTimeoutMs ?? 6000, 30000));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private stopChild(
    reason: "helper_unavailable" | "helper_protocol_error" = "helper_unavailable",
  ): void {
    this.transportFailureReason = reason;
    const child = this.child;
    this.child = null;
    this.token = null;
    this.output = Buffer.alloc(0);
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timeout);
      pending.resolve(null);
    }
    if (child) {
      child.stdout?.removeAllListeners("data");
      child.stdin?.destroy();
      try {
        child.kill("SIGKILL");
      } catch {
        // A child that already exited is still fully invalidated above.
      }
    }
  }

  private startChild(): boolean {
    if (this.child) return true;
    if (this.disposed || !isAbsolute(this.executablePath)) return false;
    try {
      // A symlinked helper can redirect a high-trust AX request outside Cafe's
      // bundle. Only a real executable regular file is eligible for spawning.
      const metadata = lstatSync(this.executablePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) === 0) {
        return false;
      }
      const child = this.spawnChild(this.executablePath);
      if (!child.stdin || !child.stdout) {
        child.kill("SIGKILL");
        return false;
      }
      this.child = child;
      this.output = Buffer.alloc(0);
      child.stdout.on("data", (data: Buffer) => this.handleOutput(child, data));
      child.stdout.on("error", () => {
        if (this.child === child) this.stopChild();
      });
      child.stdin.on("error", () => {
        if (this.child === child) this.stopChild();
      });
      child.on("error", () => {
        if (this.child === child) this.stopChild();
      });
      child.on("exit", () => {
        if (this.child === child) this.stopChild();
      });
      return true;
    } catch {
      // Never expose a filesystem path or raw native spawn error to the UI.
      return false;
    }
  }

  private handleOutput(child: ChildProcess, chunk: Buffer): void {
    if (this.child !== child) return;
    if (chunk.byteLength > maximumResponseBytes - this.output.byteLength) {
      this.stopChild("helper_protocol_error");
      return;
    }
    this.output = Buffer.concat([this.output, chunk]);
    const newline = this.output.indexOf(0x0a);
    if (newline < 0) return;
    const line = this.output.subarray(0, newline);
    // Exactly one response is allowed for each request. Extra bytes could be
    // a desynchronization or a compromised helper; fail closed.
    if (this.output.byteLength !== newline + 1 || !this.pending) {
      this.stopChild("helper_protocol_error");
      return;
    }
    this.output = Buffer.alloc(0);
    let decoded: unknown;
    try {
      decoded = JSON.parse(line.toString("utf8"));
    } catch {
      this.stopChild("helper_protocol_error");
      return;
    }
    const response = decodeResponse(decoded, this.pending.id);
    if (!response) {
      this.stopChild("helper_protocol_error");
      return;
    }
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timeout);
    pending.resolve(response);
  }

  private async request(
    command: Command,
    extra: Record<string, string> = {},
  ): Promise<HelperResponse | null> {
    this.transportFailureReason = "helper_unavailable";
    if (!this.startChild() || !this.child?.stdin || this.pending) return null;
    const id = this.nextRequestId++;
    const line = JSON.stringify({ id, command, ...extra }) + "\n";
    if (Buffer.byteLength(line, "utf8") > maximumRequestBytes) return null;
    const child = this.child;
    return new Promise<HelperResponse | null>((resolve) => {
      // Native lifecycle timer: retain callback ownership, cancellation and ref/unref semantics.
      // @effect-diagnostics-next-line globalTimers:off
      const timeout = setTimeout(() => {
        // Timeout after dispatch is ambiguous for insertion. Terminating the
        // helper is essential: it must not later write to a different app.
        if (this.child === child) this.stopChild();
      }, this.requestTimeoutMs);
      this.pending = { id, resolve, timeout };
      try {
        child.stdin!.write(line, "utf8", (error) => {
          if (error && this.child === child && this.pending?.id === id) {
            this.stopChild();
          }
        });
      } catch {
        if (this.child === child) this.stopChild();
      }
    });
  }

  capture(): Promise<MacDictationTargetResult> {
    const revision = ++this.revision;
    this.token = null;
    return this.enqueue(async () => {
      if (this.disposed || revision !== this.revision) return failed("target_unavailable");
      const response = await this.request("capture");
      if (this.disposed || revision !== this.revision) return failed("target_unavailable");
      if (!response) return failed(this.transportFailureReason);
      if (!response.ok) return mapNativeFailure(response);
      if (!response.token || !response.insertionMethod) {
        this.stopChild();
        return failed("helper_protocol_error");
      }
      this.token = response.token;
      // Only this finite method reaches the UI. The capture token and native
      // target identities stay private; the renderer cannot choose or override
      // the method when it later submits its one insertion request.
      return { ok: true, insertionMethod: response.insertionMethod };
    });
  }

  insert(text: string): Promise<MacDictationTargetResult> {
    if (
      typeof text !== "string" ||
      text.length === 0 ||
      text.includes("\0") ||
      Buffer.byteLength(text, "utf8") > maximumInsertionUTF8Bytes ||
      Buffer.byteLength(
        JSON.stringify({ id: this.nextRequestId, command: "insert", token: "a".repeat(64), text }),
        "utf8",
      ) +
        1 >
        maximumRequestBytes
    ) {
      return Promise.resolve(failed("invalid_text"));
    }
    const revision = this.revision;
    return this.enqueue(async () => {
      if (this.disposed || revision !== this.revision || !this.token) {
        return failed("target_unavailable");
      }
      const token = this.token;
      this.token = null;
      const response = await this.request("insert", { token, text });
      if (!response) {
        // The command may have reached the helper before a timeout, crash, or
        // pipe failure. This is deliberately not eligible for automatic retry.
        return failed("insertion_uncertain", true);
      }
      if (!response.ok) return mapNativeFailure(response);
      if (response.token !== undefined || response.insertionMethod !== undefined) {
        this.stopChild();
        return failed("helper_protocol_error", true);
      }
      return { ok: true };
    });
  }

  discard(): Promise<void> {
    ++this.revision;
    this.token = null;
    return this.enqueue(async () => {
      if (this.disposed || !this.child) return;
      const response = await this.request("discard");
      if (!response || !response.ok) this.stopChild();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.revision;
    this.stopChild();
  }
}

export function createMacDictationTargetClient(
  options: MacDictationTargetClientOptions,
): MacDictationTargetClient {
  return new MacDictationTargetClientImpl(options);
}
