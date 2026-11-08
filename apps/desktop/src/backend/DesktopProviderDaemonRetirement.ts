import * as crypto from "node:crypto";
// Native no-follow descriptors and bigint identity are the control boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs/promises";
// O_NOFOLLOW has no equivalent in the ordinary filesystem abstraction.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { constants } from "node:fs";
// Resolve the exact native namespace whose inode is checked below.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as path from "node:path";
// Abortable polling belongs to this native Promise and its absolute deadline.
import { setTimeout } from "node:timers/promises";
import * as Schema from "effect/Schema";
import {
  PROVIDER_DAEMON_RETIRE_PATH,
  ProviderDaemonMarker,
  ProviderDaemonRetirementRequest,
  ProviderDaemonRetirementResponse,
  type ProviderDaemonClientConfig,
  type ProviderDaemonHealth,
} from "@cafecode/contracts";
import { requestProviderDaemonJson } from "@cafecode/shared/providerDaemonHttp";

/** Only ESRCH is positive absence. EPERM or malformed PIDs preserve the owner. */
export function observeProviderDaemonProcess(pid: number): "present" | "exited" | "unknown" {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) return "unknown";
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    return error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH"
      ? "exited"
      : "unknown";
  }
}

/** Fixed feedback only: received bodies, credentials and native errors stay private. */
export class ProviderDaemonRetirementError extends Error {
  constructor() {
    super(
      "The old provider daemon could not be safely stopped. Its recovery files were preserved. Stop it from its owning Cafe Code instance before retrying.",
    );
  }
}

const decodeMarker = Schema.decodeUnknownSync(Schema.fromJsonString(ProviderDaemonMarker));
const encodeMarker = Schema.encodeSync(Schema.fromJsonString(ProviderDaemonMarker));
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(ProviderDaemonRetirementRequest));
const decodeResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderDaemonRetirementResponse),
);

interface FileEvidence {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly digest: string;
}

async function readPrivateFile(filePath: string, maximum: number, held?: fs.FileHandle) {
  const handle =
    held ??
    (await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid!()) ||
      (before.mode & 0o077n) !== 0n ||
      before.size < 0n ||
      before.size > BigInt(maximum)
    )
      throw new ProviderDaemonRetirementError();
    // A concurrent grow must never turn the bounded admission read into an
    // unbounded readFile allocation. Read at most the allowance plus one byte.
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const named = await fs.lstat(filePath, { bigint: true });
    if (
      length > maximum ||
      BigInt(length) !== before.size ||
      (["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"] as const).some(
        (field) => after[field] !== before[field] || named[field] !== before[field],
      ) ||
      !named.isFile() ||
      named.isSymbolicLink()
    )
      throw new ProviderDaemonRetirementError();
    const bytes = buffer.subarray(0, length);
    return {
      bytes,
      evidence: {
        dev: before.dev,
        ino: before.ino,
        uid: before.uid,
        gid: before.gid,
        mode: before.mode,
        size: before.size,
        mtimeNs: before.mtimeNs,
        ctimeNs: before.ctimeNs,
        digest: crypto.createHash("sha256").update(bytes).digest("hex"),
      } satisfies FileEvidence,
    };
  } finally {
    if (held === undefined) await handle.close();
  }
}

function sameEvidence(left: FileEvidence, right: FileEvidence) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.digest === right.digest
  );
}

interface StartupRetirementInput {
  readonly endpoint: ProviderDaemonClientConfig;
  readonly marker: ProviderDaemonMarker;
  readonly markerPath: string;
  readonly credentialPath: string;
  readonly socketPath: string;
  readonly decryptCredential: (bytes: Uint8Array) => Promise<string>;
}

/** Opaque, live controller evidence. No credential or filesystem identity is public. */
export interface ProviderDaemonStartupRetirementEvidence {
  readonly _tag: "ProviderDaemonStartupRetirementEvidence";
}

interface StartupRetirementRecord {
  readonly input: StartupRetirementInput;
  readonly marker: FileEvidence;
  readonly credential: FileEvidence;
  readonly socket:
    | {
        readonly dev: bigint;
        readonly ino: bigint;
        readonly uid: bigint;
        readonly gid: bigint;
        readonly mode: bigint;
        readonly nlink: bigint;
        readonly size: bigint;
        readonly mtimeNs: bigint;
        readonly ctimeNs: bigint;
      }
    | undefined;
  readonly parent: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly uid: bigint;
    readonly gid: bigint;
    readonly mode: bigint;
  };
}

async function socketEvidence(socketPath: string): Promise<StartupRetirementRecord["socket"]> {
  try {
    const socket = await fs.lstat(socketPath, { bigint: true });
    if (
      !socket.isSocket() ||
      socket.isSymbolicLink() ||
      socket.nlink !== 1n ||
      socket.uid !== BigInt(process.getuid!())
    )
      throw new ProviderDaemonRetirementError();
    return {
      dev: socket.dev,
      ino: socket.ino,
      uid: socket.uid,
      gid: socket.gid,
      mode: socket.mode,
      nlink: socket.nlink,
      size: socket.size,
      mtimeNs: socket.mtimeNs,
      ctimeNs: socket.ctimeNs,
    };
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return undefined;
    throw new ProviderDaemonRetirementError();
  }
}

function sameSocket(
  left: NonNullable<StartupRetirementRecord["socket"]>,
  right: NonNullable<StartupRetirementRecord["socket"]>,
) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function verifyCapturedSocket(record: StartupRetirementRecord) {
  const current = await socketEvidence(record.input.socketPath);
  // The selected listener may have closed itself. A new entry never inherits
  // the captured owner, including when the original listener was already absent.
  if (current !== undefined && (record.socket === undefined || !sameSocket(record.socket, current)))
    throw new ProviderDaemonRetirementError();
}

// A structural lookalike cannot mint a captured owner. These records are live
// manager capabilities only; none is persisted, logged or hydrated from JSON.
const startupRetirementEvidence = new WeakMap<
  ProviderDaemonStartupRetirementEvidence,
  StartupRetirementRecord
>();

async function privateSocketParent(socketPath: string) {
  const parent = await fs.lstat(path.dirname(socketPath), { bigint: true });
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== BigInt(process.getuid!()) ||
    (parent.mode & 0o077n) !== 0n
  )
    throw new ProviderDaemonRetirementError();
  return parent;
}

/** Capture BEFORE the first retirement POST and before asking the human.
 * Only exact existing private bytes and namespace can survive that await. */
export async function captureProviderDaemonStartupRetirementEvidence(
  input: StartupRetirementInput & { readonly signal: AbortSignal },
): Promise<ProviderDaemonStartupRetirementEvidence> {
  try {
    input.signal.throwIfAborted();
    if (
      input.marker.transport !== "ipc" ||
      input.endpoint.transport !== "ipc" ||
      input.marker.socketPath !== input.socketPath ||
      input.endpoint.socketPath !== input.socketPath ||
      (input.marker.credentialPath ?? input.credentialPath) !== input.credentialPath
    )
      throw new ProviderDaemonRetirementError();
    const marker = await readPrivateFile(input.markerPath, 65_536);
    const credential = await readPrivateFile(input.credentialPath, 8_192);
    if (encodeMarker(decodeMarker(marker.bytes.toString("utf8"))) !== encodeMarker(input.marker))
      throw new ProviderDaemonRetirementError();
    const token =
      input.marker.credentialEncrypted === false
        ? credential.bytes.toString("utf8")
        : await input.decryptCredential(credential.bytes);
    const actual = Buffer.from(token, "utf8"),
      expected = Buffer.from(input.endpoint.token, "utf8");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected))
      throw new ProviderDaemonRetirementError();
    const parent = await privateSocketParent(input.socketPath);
    const socket = await socketEvidence(input.socketPath);
    // Keyring decryption may await. Do not publish a capability if either
    // recovery file or the private socket namespace changed during that await.
    const markerAfter = await readPrivateFile(input.markerPath, 65_536);
    const credentialAfter = await readPrivateFile(input.credentialPath, 8_192);
    const parentAfter = await privateSocketParent(input.socketPath);
    if (
      !sameEvidence(marker.evidence, markerAfter.evidence) ||
      !sameEvidence(credential.evidence, credentialAfter.evidence) ||
      parentAfter.dev !== parent.dev ||
      parentAfter.ino !== parent.ino ||
      parentAfter.uid !== parent.uid ||
      parentAfter.gid !== parent.gid ||
      parentAfter.mode !== parent.mode
    )
      throw new ProviderDaemonRetirementError();
    input.signal.throwIfAborted();
    const evidence: ProviderDaemonStartupRetirementEvidence = Object.freeze({
      _tag: "ProviderDaemonStartupRetirementEvidence",
    });
    const record: StartupRetirementRecord = {
      input: {
        endpoint: { ...input.endpoint },
        marker: { ...input.marker },
        markerPath: input.markerPath,
        credentialPath: input.credentialPath,
        socketPath: input.socketPath,
        decryptCredential: input.decryptCredential,
      },
      marker: marker.evidence,
      credential: credential.evidence,
      socket,
      parent: {
        dev: parent.dev,
        ino: parent.ino,
        uid: parent.uid,
        gid: parent.gid,
        mode: parent.mode,
      },
    };
    await verifyCapturedSocket(record);
    input.signal.throwIfAborted();
    startupRetirementEvidence.set(evidence, record);
    return evidence;
  } catch {
    throw new ProviderDaemonRetirementError();
  }
}

/** Read-only revalidation; this grants no HTTP, signalling or spawn authority. */
export async function verifyProviderDaemonStartupRetirementEvidence(
  evidence: ProviderDaemonStartupRetirementEvidence,
  signal: AbortSignal,
): Promise<void> {
  try {
    const record = startupRetirementEvidence.get(evidence);
    if (record === undefined) throw new ProviderDaemonRetirementError();
    signal.throwIfAborted();
    const marker = await readPrivateFile(record.input.markerPath, 65_536);
    const credential = await readPrivateFile(record.input.credentialPath, 8_192);
    const parent = await privateSocketParent(record.input.socketPath);
    if (
      !sameEvidence(record.marker, marker.evidence) ||
      !sameEvidence(record.credential, credential.evidence) ||
      parent.dev !== record.parent.dev ||
      parent.ino !== record.parent.ino ||
      parent.uid !== record.parent.uid ||
      parent.gid !== record.parent.gid ||
      parent.mode !== record.parent.mode
    )
      throw new ProviderDaemonRetirementError();
    await verifyCapturedSocket(record);
    signal.throwIfAborted();
  } catch {
    throw new ProviderDaemonRetirementError();
  }
}

/** Runtime incompatibility is allowed only for retirement, never for adoption. */
export function providerDaemonRetirementRequest(
  marker: ProviderDaemonMarker,
  health: ProviderDaemonHealth,
): ProviderDaemonRetirementRequest | undefined {
  if (
    health.retirementProtocol !== 1 ||
    marker.version !== 2 ||
    marker.transport !== "ipc" ||
    health.transport !== "ipc" ||
    marker.mode !== "provider-daemon" ||
    health.mode !== "provider-daemon" ||
    marker.pid !== health.pid ||
    marker.protocolVersion !== 1 ||
    health.protocolVersion !== 1 ||
    marker.appVersion !== health.version ||
    marker.runtimeBuildId !== health.runtimeBuildId ||
    !health.runtimeBuildId ||
    health.runtimeBuildId.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(health.runtimeBuildId) ||
    marker.dataProfile === undefined ||
    marker.dataProfile !== health.dataProfile ||
    marker.dataProfileId === undefined ||
    marker.dataProfileId !== health.dataProfileId ||
    health.upstreamSupervisor?.configured === true ||
    health.supervisorProcess !== undefined
  )
    return undefined;
  return {
    protocolVersion: 1,
    pid: health.pid,
    startedAt: health.startedAt,
    runtimeBuildId: health.runtimeBuildId,
    dataProfile: marker.dataProfile,
    dataProfileId: marker.dataProfileId,
    nonce: crypto.randomBytes(32).toString("hex"),
  };
}

/**
 * Native desktop startup already holds its data-profile single-instance lock;
 * its manager additionally serializes lifecycle calls. This routine grants no
 * control to arbitrary standalone callers or ordinary backend leases. It asks
 * the authenticated old owner to stop itself, never signals its observed PID.
 */
async function holdStartupRetirementNamespace(
  input: StartupRetirementInput & {
    readonly request?: ProviderDaemonRetirementRequest;
    readonly evidence?: ProviderDaemonStartupRetirementEvidence;
    readonly signal: AbortSignal;
  },
  dependencies: {
    readonly requestJson?: typeof requestProviderDaemonJson;
    readonly observeProcess?: typeof observeProviderDaemonProcess;
    readonly removeCapturedSocketAfterNativeExit?: boolean;
  },
  reconcileOnly: boolean,
): Promise<{
  readonly verifyBeforeSpawn: () => Promise<void>;
  readonly close: () => Promise<void>;
}> {
  let markerHandle: fs.FileHandle | undefined;
  let credentialHandle: fs.FileHandle | undefined;
  let transferred = false;
  let closed = false;
  const close = async () => {
    closed = true;
    input.signal.removeEventListener("abort", onAbort);
    await Promise.allSettled([markerHandle?.close(), credentialHandle?.close()]);
  };
  // The outer Effect may be cancelled after its Promise resolves but before it
  // receives the guard. This listener still owns exact descriptor retirement.
  const onAbort = () => {
    void close();
  };
  input.signal.addEventListener("abort", onAbort, { once: true });
  try {
    input.signal.throwIfAborted();
    const evidence =
      input.evidence ?? (await captureProviderDaemonStartupRetirementEvidence(input));
    const captured = startupRetirementEvidence.get(evidence);
    if (
      captured === undefined ||
      encodeMarker(captured.input.marker) !== encodeMarker(input.marker) ||
      captured.input.markerPath !== input.markerPath ||
      captured.input.credentialPath !== input.credentialPath ||
      captured.input.socketPath !== input.socketPath ||
      captured.input.endpoint.transport !== input.endpoint.transport ||
      captured.input.endpoint.httpBaseUrl !== input.endpoint.httpBaseUrl ||
      captured.input.endpoint.socketPath !== input.endpoint.socketPath ||
      captured.input.endpoint.token !== input.endpoint.token
    )
      throw new ProviderDaemonRetirementError();
    markerHandle = await fs.open(
      input.markerPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    input.signal.throwIfAborted();
    credentialHandle = await fs.open(
      input.credentialPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    input.signal.throwIfAborted();
    const markerFile = await readPrivateFile(input.markerPath, 65_536, markerHandle);
    const credentialFile = await readPrivateFile(input.credentialPath, 8_192, credentialHandle);
    if (
      !sameEvidence(captured.marker, markerFile.evidence) ||
      !sameEvidence(captured.credential, credentialFile.evidence)
    )
      throw new ProviderDaemonRetirementError();
    if (
      encodeMarker(decodeMarker(markerFile.bytes.toString("utf8"))) !== encodeMarker(input.marker)
    )
      throw new ProviderDaemonRetirementError();
    // Capture already decrypted and constant-time authenticated these exact
    // held bytes against this exact endpoint. Equality above retains that
    // authority without opening another keyring operation across an await.
    const parent = await privateSocketParent(input.socketPath);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== BigInt(process.getuid!()) ||
      (parent.mode & 0o077n) !== 0n ||
      parent.dev !== captured.parent.dev ||
      parent.ino !== captured.parent.ino ||
      parent.gid !== captured.parent.gid ||
      parent.mode !== captured.parent.mode
    )
      throw new ProviderDaemonRetirementError();
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(18_000)]);
    signal.throwIfAborted();
    await verifyCapturedSocket(captured);
    // Exactly one request. A timeout, malformed response or unknown ACK never
    // authorizes replay, evidence deletion or a competing replacement.
    if (!reconcileOnly) {
      const request = input.request;
      if (request === undefined) throw new ProviderDaemonRetirementError();
      const response = await (dependencies.requestJson ?? requestProviderDaemonJson)(
        input.endpoint,
        PROVIDER_DAEMON_RETIRE_PATH,
        {
          method: "POST",
          body: encodeRequest(request),
          timeoutMs: 5_000,
          maxResponseBytes: 2_048,
          signal,
        },
      );
      if (response.statusCode !== 200) throw new ProviderDaemonRetirementError();
      const receipt = decodeResponse(response.body);
      for (const key of Object.keys(request) as (keyof ProviderDaemonRetirementRequest)[]) {
        if (receipt[key] !== request[key]) throw new ProviderDaemonRetirementError();
      }
    }
    const observe = dependencies.observeProcess ?? observeProviderDaemonProcess;
    if (reconcileOnly) {
      // Human confirmation does not turn an uncertain ACK into permission to
      // replay its POST. Reconciliation is a single conclusive absence check.
      if (observe(input.marker.pid) !== "exited") throw new ProviderDaemonRetirementError();
    } else {
      while (observe(input.marker.pid) !== "exited") {
        await setTimeout(100, undefined, { signal });
      }
    }
    let socketCleanupAvailable =
      reconcileOnly && dependencies.removeCapturedSocketAfterNativeExit === true;
    const checkNamespace = async () => {
      input.signal.throwIfAborted();
      if (closed) throw new ProviderDaemonRetirementError();
      if (observe(input.marker.pid) !== "exited") throw new ProviderDaemonRetirementError();
      const markerNow = await readPrivateFile(input.markerPath, 65_536, markerHandle);
      const credentialNow = await readPrivateFile(input.credentialPath, 8_192, credentialHandle);
      if (
        !sameEvidence(markerFile.evidence, markerNow.evidence) ||
        !sameEvidence(credentialFile.evidence, credentialNow.evidence)
      )
        throw new ProviderDaemonRetirementError();
      const parentNow = await fs.lstat(path.dirname(input.socketPath), { bigint: true });
      if (
        !parentNow.isDirectory() ||
        parentNow.isSymbolicLink() ||
        parentNow.dev !== parent.dev ||
        parentNow.ino !== parent.ino ||
        parentNow.uid !== BigInt(process.getuid!()) ||
        parentNow.gid !== parent.gid ||
        parentNow.mode !== parent.mode ||
        (parentNow.mode & 0o077n) !== 0n
      )
        throw new ProviderDaemonRetirementError();
      // The old listener must remove its own socket during scoped shutdown.
      // Never unlink a possibly new listener merely to make the bind succeed.
      try {
        const mayRemoveCapturedSocket = socketCleanupAvailable;
        // This permission belongs to the initial verified transition only.
        // Unknown unlink results and later spawn fences cannot replay cleanup.
        socketCleanupAvailable = false;
        const currentSocket = await socketEvidence(input.socketPath);
        if (currentSocket === undefined) return;
        if (
          !mayRemoveCapturedSocket ||
          captured.socket === undefined ||
          !sameSocket(captured.socket, currentSocket)
        )
          throw new ProviderDaemonRetirementError();
        // Only the explicit kernel-generation stop path can retire a leftover
        // captured socket. ESRCH and held private namespace were checked above;
        // an unknown/replacement entry is preserved. The profile singleton and
        // lifecycle mutex remain held across this final namespace publication.
        await fs.unlink(input.socketPath);
        try {
          await fs.lstat(input.socketPath);
        } catch (error) {
          if (
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return;
          throw new ProviderDaemonRetirementError();
        }
      } catch (error) {
        if (
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return;
        throw new ProviderDaemonRetirementError();
      }
      throw new ProviderDaemonRetirementError();
    };
    const verifyBeforeSpawn = async () => {
      try {
        await checkNamespace();
      } catch {
        throw new ProviderDaemonRetirementError();
      }
    };
    await verifyBeforeSpawn();
    input.signal.throwIfAborted();
    transferred = true;
    return { verifyBeforeSpawn, close };
  } catch {
    throw new ProviderDaemonRetirementError();
  } finally {
    if (!transferred) await close();
  }
}

/** Exactly one authenticated request; callers retain the opaque pre-POST
 * evidence if its acknowledgement becomes unknown. */
export function retireProviderDaemonForStartup(
  input: StartupRetirementInput & {
    readonly request: ProviderDaemonRetirementRequest;
    readonly evidence?: ProviderDaemonStartupRetirementEvidence;
    readonly signal: AbortSignal;
  },
  dependencies: {
    readonly requestJson?: typeof requestProviderDaemonJson;
    readonly observeProcess?: typeof observeProviderDaemonProcess;
  } = {},
) {
  return holdStartupRetirementNamespace(input, dependencies, false);
}

/** Explicit startup recovery only: no request, PID signal, stale cleanup or
 * timer retry. Exact pre-POST files, ESRCH and the old socket's absence are all
 * required; the returned guard rechecks them immediately before fresh spawn. */
export function reconcileProviderDaemonStartupRetirement(
  evidence: ProviderDaemonStartupRetirementEvidence,
  signal: AbortSignal,
  dependencies: {
    readonly observeProcess?: typeof observeProviderDaemonProcess;
    readonly removeCapturedSocketAfterNativeExit?: boolean;
  } = {},
) {
  const record = startupRetirementEvidence.get(evidence);
  if (record === undefined) return Promise.reject(new ProviderDaemonRetirementError());
  return holdStartupRetirementNamespace({ ...record.input, evidence, signal }, dependencies, true);
}
