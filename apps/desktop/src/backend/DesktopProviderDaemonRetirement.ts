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
  readonly digest: string;
}

async function readPrivateFile(filePath: string, maximum: number, held?: fs.FileHandle) {
  const handle = held ?? (await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW));
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid!()) ||
      (before.mode & 0o077n) !== 0n ||
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
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      named.nlink !== 1n ||
      named.isSymbolicLink()
    )
      throw new ProviderDaemonRetirementError();
    const bytes = buffer.subarray(0, length);
    return {
      bytes,
      evidence: {
        dev: before.dev,
        ino: before.ino,
        digest: crypto.createHash("sha256").update(bytes).digest("hex"),
      } satisfies FileEvidence,
    };
  } finally {
    if (held === undefined) await handle.close();
  }
}

function sameEvidence(left: FileEvidence, right: FileEvidence) {
  return left.dev === right.dev && left.ino === right.ino && left.digest === right.digest;
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
export async function retireProviderDaemonForStartup(
  input: {
    readonly endpoint: ProviderDaemonClientConfig;
    readonly marker: ProviderDaemonMarker;
    readonly request: ProviderDaemonRetirementRequest;
    readonly markerPath: string;
    readonly credentialPath: string;
    readonly socketPath: string;
    readonly signal: AbortSignal;
    /** Decrypt only the exact held private credential bytes, never a path reread. */
    readonly decryptCredential: (bytes: Uint8Array) => Promise<string>;
  },
  dependencies: {
    readonly requestJson?: typeof requestProviderDaemonJson;
    readonly observeProcess?: typeof observeProviderDaemonProcess;
  } = {},
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
    markerHandle = await fs.open(input.markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    input.signal.throwIfAborted();
    credentialHandle = await fs.open(
      input.credentialPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    input.signal.throwIfAborted();
    const markerFile = await readPrivateFile(input.markerPath, 65_536, markerHandle);
    const credentialFile = await readPrivateFile(input.credentialPath, 8_192, credentialHandle);
    if (
      encodeMarker(decodeMarker(markerFile.bytes.toString("utf8"))) !== encodeMarker(input.marker)
    )
      throw new ProviderDaemonRetirementError();
    const heldToken =
      input.marker.credentialEncrypted === false
        ? credentialFile.bytes.toString("utf8")
        : await input.decryptCredential(credentialFile.bytes);
    const actualToken = Buffer.from(heldToken, "utf8");
    const expectedToken = Buffer.from(input.endpoint.token, "utf8");
    if (
      actualToken.length !== expectedToken.length ||
      !crypto.timingSafeEqual(actualToken, expectedToken)
    )
      throw new ProviderDaemonRetirementError();
    const parent = await fs.lstat(path.dirname(input.socketPath), { bigint: true });
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== BigInt(process.getuid!()) ||
      (parent.mode & 0o077n) !== 0n
    )
      throw new ProviderDaemonRetirementError();
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(18_000)]);
    signal.throwIfAborted();
    // Exactly one request. A timeout, malformed response or unknown ACK never
    // authorizes replay, evidence deletion or a competing replacement.
    const response = await (dependencies.requestJson ?? requestProviderDaemonJson)(
      input.endpoint,
      PROVIDER_DAEMON_RETIRE_PATH,
      {
        method: "POST",
        body: encodeRequest(input.request),
        timeoutMs: 5_000,
        maxResponseBytes: 2_048,
        signal,
      },
    );
    if (response.statusCode !== 200) throw new ProviderDaemonRetirementError();
    const receipt = decodeResponse(response.body);
    for (const key of Object.keys(input.request) as (keyof ProviderDaemonRetirementRequest)[]) {
      if (receipt[key] !== input.request[key]) throw new ProviderDaemonRetirementError();
    }
    const observe = dependencies.observeProcess ?? observeProviderDaemonProcess;
    while (observe(input.marker.pid) !== "exited") {
      await setTimeout(100, undefined, { signal });
    }
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
        (parentNow.mode & 0o077n) !== 0n
      )
        throw new ProviderDaemonRetirementError();
      // The old listener must remove its own socket during scoped shutdown.
      // Never unlink a possibly new listener merely to make the bind succeed.
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
