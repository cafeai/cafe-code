// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import * as path from "node:path";

import { WINDOWS_PROCESS_OWNERSHIP_SCRIPT } from "./windowsProcessOwnershipScript.ts";

export interface WindowsProcessIdentity {
  readonly pid: number;
  /** Exact unsigned FILETIME, never a rounded JavaScript number or wall clock. */
  readonly creationTime100ns: string;
}

export const WINDOWS_OWNERSHIP_REASONS = [
  "unsupported-platform",
  "invalid-request",
  "invalid-response",
  "helper-unavailable",
  "helper-exited",
  "helper-timeout",
  "helper-exit-unconfirmed",
  "session-closed",
  "access-denied",
  "native-failure",
  "termination-denied",
  "termination-unconfirmed",
  "unsafe-path",
  "unsafe-directory-open",
  "unsafe-directory-metadata",
  "unsafe-directory-reparse",
  "lock-busy",
  "record-unreadable",
  "record-invalid",
  "ownership-changed",
  "credential-unavailable",
  "mutation-unconfirmed",
] as const;
export type WindowsOwnershipReason = (typeof WINDOWS_OWNERSHIP_REASONS)[number];

/** Contains only an allowlisted outcome, never native exceptions/private data. */
export class WindowsOwnershipError extends Error {
  readonly reason: WindowsOwnershipReason;

  constructor(reason: WindowsOwnershipReason) {
    super(`Windows runtime ownership could not be verified (${reason}).`);
    this.name = "WindowsOwnershipError";
    this.reason = reason;
  }
}

export type WindowsProcessCapture =
  | { readonly status: "present"; readonly identity: WindowsProcessIdentity }
  | { readonly status: "exited" | "unknown"; readonly reason?: WindowsOwnershipReason };
export type WindowsProcessObservation = {
  readonly status: "same-process" | "different-process" | "exited" | "unknown";
  readonly reason?: WindowsOwnershipReason;
};
export type WindowsProcessTermination = {
  readonly status: "different-process" | "exited" | "unknown";
  readonly reason?: WindowsOwnershipReason;
};

export interface WindowsOwnershipSnapshot {
  readonly markerJson: string | null;
  readonly revision: string | null;
  readonly credentialBase64?: string;
}

export interface WindowsOwnershipSession {
  read(): Promise<WindowsOwnershipSnapshot>;
  publish(input: {
    readonly expectedRevision: string | null;
    readonly markerJson: string;
    readonly credentialBase64?: string;
  }): Promise<string>;
  retire(expectedRevision: string): Promise<void>;
  capture(pid: number): Promise<WindowsProcessCapture>;
  observe(identity: WindowsProcessIdentity): Promise<WindowsProcessObservation>;
  terminate(identity: WindowsProcessIdentity): Promise<WindowsProcessTermination>;
  close(): Promise<void>;
}

export const WINDOWS_OWNERSHIP_LIMITS = {
  operationTimeoutMs: 15_000,
  sessionTimeoutMs: 120_000,
  helperExitTimeoutMs: 3_000,
  responseBytes: 8_192,
  requestBytes: 16_384,
  markerBytes: 4_096,
  credentialBytes: 1_024,
} as const;

export interface WindowsOwnershipDependencies {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  /** Injected unit-test transport; production always launches one direct child. */
  readonly spawn?: (
    executable: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  readonly operationTimeoutMs?: number;
  readonly sessionTimeoutMs?: number;
  readonly helperExitTimeoutMs?: number;
  /** Fixed startup phases only; never raw helper output or caller data. */
  readonly onStartupPhase?: (phase: "bootstrap" | "source" | "ready") => void;
}

type JsonObject = Record<string, unknown>;
const reasons = new Set<string>(WINDOWS_OWNERSHIP_REASONS);
const revisionPattern = /^[0-9a-f]{64}$/;
const generationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WindowsOwnershipError("invalid-response");
  }
  return value as JsonObject;
}

export function isWindowsProcessIdentity(value: unknown): value is WindowsProcessIdentity {
  if (value === null || typeof value !== "object") return false;
  const identity = value as Partial<WindowsProcessIdentity>;
  return (
    typeof identity.pid === "number" &&
    Number.isSafeInteger(identity.pid) &&
    identity.pid > 0 &&
    identity.pid <= 0xffff_ffff &&
    typeof identity.creationTime100ns === "string" &&
    /^[1-9][0-9]{0,19}$/.test(identity.creationTime100ns) &&
    BigInt(identity.creationTime100ns) <= 0xffff_ffff_ffff_ffffn
  );
}

function requirePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffff_ffff) {
    throw new WindowsOwnershipError("invalid-request");
  }
}

function requireIdentity(identity: WindowsProcessIdentity): void {
  if (!isWindowsProcessIdentity(identity)) throw new WindowsOwnershipError("invalid-request");
}

function optionalReason(value: unknown): WindowsOwnershipReason | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !reasons.has(value)) {
    throw new WindowsOwnershipError("invalid-response");
  }
  return value as WindowsOwnershipReason;
}

function decodeProcessResult(
  value: unknown,
  mode: "capture" | "observe" | "terminate",
  requestedPid: number,
): WindowsProcessCapture | WindowsProcessObservation | WindowsProcessTermination {
  const result = object(value);
  if (result.status === "present" && mode === "capture") {
    if (!isWindowsProcessIdentity(result.identity) || result.identity.pid !== requestedPid) {
      throw new WindowsOwnershipError("invalid-response");
    }
    return { status: "present", identity: result.identity };
  }
  if (
    result.status === "exited" ||
    result.status === "unknown" ||
    (result.status === "different-process" && mode !== "capture") ||
    (result.status === "same-process" && mode === "observe")
  ) {
    const reason = optionalReason(result.reason);
    return { status: result.status, ...(reason === undefined ? {} : { reason }) };
  }
  throw new WindowsOwnershipError("invalid-response");
}

export function windowsOwnershipCredentialPath(legacyCredentialPath: string, ownershipId: string) {
  if (!generationPattern.test(ownershipId) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(ownershipId)) {
    throw new WindowsOwnershipError("invalid-request");
  }
  return `${legacyCredentialPath}.${ownershipId}`;
}

function validBase64(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1_368 &&
    Buffer.from(value, "base64").length <= WINDOWS_OWNERSHIP_LIMITS.credentialBytes &&
    Buffer.from(value, "base64").toString("base64") === value
  );
}

function decodeSnapshot(value: unknown): WindowsOwnershipSnapshot {
  const result = object(value);
  if (
    result.markerJson === null &&
    result.revision === null &&
    result.credentialBase64 === undefined
  ) {
    return { markerJson: null, revision: null };
  }
  if (
    typeof result.markerJson !== "string" ||
    Buffer.byteLength(result.markerJson) > WINDOWS_OWNERSHIP_LIMITS.markerBytes ||
    typeof result.revision !== "string" ||
    !revisionPattern.test(result.revision) ||
    (result.credentialBase64 !== undefined && !validBase64(result.credentialBase64))
  ) {
    throw new WindowsOwnershipError("invalid-response");
  }
  return {
    markerJson: result.markerJson,
    revision: result.revision,
    ...(result.credentialBase64 === undefined ? {} : { credentialBase64: result.credentialBase64 }),
  };
}

interface HelperTransport {
  request(input: JsonObject): Promise<unknown>;
  close(): void;
  waitForExit(): Promise<void>;
}

function helperTransport(dependencies: WindowsOwnershipDependencies): HelperTransport {
  if ((dependencies.platform ?? process.platform) !== "win32") {
    throw new WindowsOwnershipError("unsupported-platform");
  }
  const environment = dependencies.environment ?? process.env;
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT;
  if (systemRoot === undefined || !/^[A-Za-z]:\\/.test(systemRoot) || systemRoot.includes("\0")) {
    throw new WindowsOwnershipError("helper-unavailable");
  }
  const executable = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  // Only fixed repository code enters argv. No profile loading, PATH lookup,
  // policy bypass, user hooks or provider credentials enter this subprocess.
  // Windows limits the entire command line to 32 KiB. The fixed bootstrap reads
  // the fixed helper source from stdin; subsequent lines carry structured data.
  // Neither script source nor private data requires a temporary .ps1 file.
  // Set InputEncoding BEFORE the first Console.In access. Changing it inside
  // the loaded script replaces Console's buffered reader and can discard the
  // already-prefetched first JSON request, leaving native startup waiting forever.
  // Use the PS5.1 .NET constructor directly: New-Object first performs Utility
  // module discovery, which can stall a deliberately minimal child environment.
  const bootstrap =
    '$ErrorActionPreference = "Stop"; try { [Console]::InputEncoding = [Text.UTF8Encoding]::new($false); [Console]::Out.WriteLine(\'{"id":0,"ok":true,"phase":"bootstrap"}\'); [Console]::Out.Flush(); & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())))) } catch { [Console]::Out.WriteLine(\'{"id":0,"ok":false,"reason":"helper-unavailable"}\'); [Console]::Out.Flush() }';
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(bootstrap, "utf16le").toString("base64"),
  ];
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (dependencies.spawn ?? ((file, argv, options) => spawn(file, argv, options)))(
      executable,
      args,
      {
        shell: false,
        windowsHide: true,
        env: {
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
          PATH: path.win32.join(systemRoot, "System32"),
          // Do not enumerate user/module-cache directories for the one trusted
          // inbox cmdlet used by the fixed script. No user module can be loaded.
          PSModulePath: path.win32.join(
            systemRoot,
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "Modules",
          ),
          ...(environment.TEMP === undefined ? {} : { TEMP: environment.TEMP }),
          ...(environment.TMP === undefined ? {} : { TMP: environment.TMP }),
        },
      },
    );
  } catch {
    throw new WindowsOwnershipError("helper-unavailable");
  }
  let pending:
    | {
        id: number;
        resolve: (value: unknown) => void;
        reject: (error: WindowsOwnershipError) => void;
        timer: ReturnType<typeof setTimeout>;
        encoded: string;
      }
    | undefined;
  let closed = false;
  let exited = false;
  const exitWaiters = new Set<() => void>();
  let sequence = 0;
  let startupPhase = 0;
  let buffered = "";
  let queued: Promise<unknown> = Promise.resolve();
  const abort = (reason: WindowsOwnershipReason): void => {
    if (closed) return;
    closed = true;
    clearTimeout(lifetime);
    const current = pending;
    pending = undefined;
    if (current !== undefined) {
      clearTimeout(current.timer);
      current.reject(new WindowsOwnershipError(reason));
    }
    // This is the disposable helper child, never the target runtime PID. EOF
    // releases its own guard; the native fixed deadline is the final backstop.
    child.stdin.destroy();
    child.kill();
  };
  // Native process deadline: preserve hard wall-clock expiry and exact handle cleanup.
  // @effect-diagnostics-next-line globalTimers:off
  const lifetime = setTimeout(
    () => abort("helper-timeout"),
    dependencies.sessionTimeoutMs ?? WINDOWS_OWNERSHIP_LIMITS.sessionTimeoutMs,
  );
  lifetime.unref();
  const sendPending = (): void => {
    if (pending === undefined || startupPhase !== 3 || closed) return;
    child.stdin.write(pending.encoded, (error) => {
      if (error !== null && error !== undefined) abort("helper-exited");
    });
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (closed) return;
    buffered += chunk;
    if (Buffer.byteLength(buffered) > WINDOWS_OWNERSHIP_LIMITS.responseBytes) {
      abort("invalid-response");
      return;
    }
    try {
      while (buffered.includes("\n")) {
        const newline = buffered.indexOf("\n");
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const response = object(JSON.parse(line));
        const current = pending;
        if (
          response.id === 0 &&
          response.ok === false &&
          response.reason === "helper-unavailable"
        ) {
          abort("helper-unavailable");
          return;
        }
        // The source and JSON protocol share stdin, so do not send any request
        // until the compiled helper owns its final reader. PowerShell may replace
        // buffered readers while initializing; startup phases are fixed data and
        // never allow replay or extend the operation's original deadline.
        if (response.id === 0 && response.ok === true) {
          const expected = ["bootstrap", "source", "ready"] as const;
          const phase = expected[startupPhase];
          if (phase === undefined || response.phase !== phase)
            throw new WindowsOwnershipError("invalid-response");
          startupPhase++;
          dependencies.onStartupPhase?.(phase);
          if (startupPhase === 3) sendPending();
          continue;
        }
        if (current === undefined || response.id !== current.id || buffered.length > 0) {
          throw new WindowsOwnershipError("invalid-response");
        }
        if (response.ok !== true && response.ok !== false)
          throw new WindowsOwnershipError("invalid-response");
        const reason = response.ok === false ? optionalReason(response.reason) : undefined;
        if (response.ok === false && reason === undefined)
          throw new WindowsOwnershipError("invalid-response");
        pending = undefined;
        clearTimeout(current.timer);
        if (response.ok === true) current.resolve(response.result);
        else current.reject(new WindowsOwnershipError(reason!));
      }
    } catch {
      abort("invalid-response");
    }
  });
  // Drain but never retain/forward stderr (PowerShell may include private paths).
  child.stderr.on("data", () => undefined);
  child.on("error", () => abort("helper-unavailable"));
  child.on("exit", () => {
    // A close ACK is emitted before the native helper's finally block releases
    // its guard. Only actual child exit proves every native handle was closed,
    // so cross-role callers must await this before opening the other role.
    exited = true;
    for (const notify of exitWaiters) notify();
    exitWaiters.clear();
    abort("helper-exited");
  });
  child.stdin.on("error", () => abort("helper-exited"));
  child.stdin.write(
    `${Buffer.from(WINDOWS_PROCESS_OWNERSHIP_SCRIPT, "utf8").toString("base64")}\n`,
  );
  return {
    request(input) {
      const request = queued.then(
        () =>
          new Promise<unknown>((resolve, reject) => {
            if (closed) {
              reject(new WindowsOwnershipError("session-closed"));
              return;
            }
            const id = ++sequence;
            const encoded = `${JSON.stringify({ id, ...input })}\n`;
            if (Buffer.byteLength(encoded) > WINDOWS_OWNERSHIP_LIMITS.requestBytes) {
              reject(new WindowsOwnershipError("invalid-request"));
              return;
            }
            // Native process deadline: preserve hard wall-clock expiry and exact handle cleanup.
            // @effect-diagnostics-next-line globalTimers:off
            const timer = setTimeout(
              () => abort("helper-timeout"),
              dependencies.operationTimeoutMs ?? WINDOWS_OWNERSHIP_LIMITS.operationTimeoutMs,
            );
            pending = { id, resolve, reject, timer, encoded };
            sendPending();
          }),
      );
      // One outstanding operation per guard. A failed mutation is never replayed
      // by this layer; consumers must re-observe under a newly acquired session.
      queued = request.catch(() => undefined);
      return request;
    },
    close: () => abort("session-closed"),
    waitForExit() {
      if (exited) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const notify = () => {
          clearTimeout(timer);
          resolve();
        };
        // Native process deadline: preserve hard wall-clock expiry and exact handle cleanup.
        // @effect-diagnostics-next-line globalTimers:off
        const timer = setTimeout(() => {
          exitWaiters.delete(notify);
          reject(new WindowsOwnershipError("helper-exit-unconfirmed"));
        }, dependencies.helperExitTimeoutMs ?? WINDOWS_OWNERSHIP_LIMITS.helperExitTimeoutMs);
        exitWaiters.add(notify);
      });
    },
  };
}

async function processRequest(
  transport: HelperTransport,
  mode: "capture" | "observe" | "terminate",
  subject: number | WindowsProcessIdentity,
) {
  if (typeof subject === "number") requirePid(subject);
  else requireIdentity(subject);
  const result = await transport.request({
    op: mode,
    ...(typeof subject === "number" ? { pid: subject } : { identity: subject }),
  });
  return decodeProcessResult(result, mode, typeof subject === "number" ? subject : subject.pid);
}

async function standalone(
  mode: "capture" | "observe" | "terminate",
  subject: number | WindowsProcessIdentity,
  dependencies: WindowsOwnershipDependencies,
) {
  let transport: HelperTransport | undefined;
  try {
    transport = helperTransport(dependencies);
    return await processRequest(transport, mode, subject);
  } catch (error) {
    return {
      status: "unknown" as const,
      reason: error instanceof WindowsOwnershipError ? error.reason : ("native-failure" as const),
    };
  } finally {
    transport?.close();
  }
}

export async function captureWindowsProcessIdentity(
  pid: number,
  dependencies: WindowsOwnershipDependencies = {},
): Promise<WindowsProcessCapture> {
  return (await standalone("capture", pid, dependencies)) as WindowsProcessCapture;
}

export async function observeWindowsProcess(
  identity: WindowsProcessIdentity,
  dependencies: WindowsOwnershipDependencies = {},
): Promise<WindowsProcessObservation> {
  return (await standalone("observe", identity, dependencies)) as WindowsProcessObservation;
}

export async function terminateWindowsProcess(
  identity: WindowsProcessIdentity,
  dependencies: WindowsOwnershipDependencies = {},
): Promise<WindowsProcessTermination> {
  return (await standalone("terminate", identity, dependencies)) as WindowsProcessTermination;
}

export async function openWindowsOwnershipSession(
  input: {
    readonly markerPath: string;
    readonly legacyCredentialPath: string;
    readonly role: "daemon" | "supervisor" | "provider-daemon" | "provider-supervisor";
  },
  dependencies: WindowsOwnershipDependencies = {},
): Promise<WindowsOwnershipSession> {
  const transport = helperTransport(dependencies);
  try {
    const result = object(
      await transport.request({ op: "open", ...input, role: input.role.replace("provider-", "") }),
    );
    if (result.opened !== true) throw new WindowsOwnershipError("invalid-response");
  } catch (error) {
    transport.close();
    throw error;
  }
  return {
    async read() {
      return decodeSnapshot(await transport.request({ op: "read" }));
    },
    async publish(value) {
      if (
        (value.expectedRevision !== null && !revisionPattern.test(value.expectedRevision)) ||
        Buffer.byteLength(value.markerJson) > WINDOWS_OWNERSHIP_LIMITS.markerBytes ||
        (value.credentialBase64 !== undefined && !validBase64(value.credentialBase64))
      )
        throw new WindowsOwnershipError("invalid-request");
      const result = object(await transport.request({ op: "publish", ...value }));
      if (typeof result.revision !== "string" || !revisionPattern.test(result.revision))
        throw new WindowsOwnershipError("invalid-response");
      return result.revision;
    },
    async retire(expectedRevision) {
      if (!revisionPattern.test(expectedRevision))
        throw new WindowsOwnershipError("invalid-request");
      const result = object(await transport.request({ op: "retire", expectedRevision }));
      if (result.retired !== true) throw new WindowsOwnershipError("invalid-response");
    },
    async capture(pid) {
      return (await processRequest(transport, "capture", pid)) as WindowsProcessCapture;
    },
    async observe(identity) {
      return (await processRequest(transport, "observe", identity)) as WindowsProcessObservation;
    },
    async terminate(identity) {
      return (await processRequest(transport, "terminate", identity)) as WindowsProcessTermination;
    },
    async close() {
      let closeFailure: unknown;
      try {
        await transport.request({ op: "close" });
      } catch (error) {
        closeFailure = error;
      }
      transport.close();
      // Never transfer authority to a different ownership guard solely from
      // an ACK or a dispatched kill request. A bounded failure is uncertainty
      // and must prevent that caller from continuing its cross-role action.
      await transport.waitForExit();
      // Node can report exit before stdout delivers the final close ACK. Close
      // has no file mutation to replay: actual exit already proves guard release.
      // Do not similarly promote malformed replies or an operation timeout.
      if (
        closeFailure instanceof WindowsOwnershipError &&
        (closeFailure.reason === "helper-exited" || closeFailure.reason === "session-closed")
      )
        return;
      if (closeFailure !== undefined) throw closeFailure;
    },
  };
}
