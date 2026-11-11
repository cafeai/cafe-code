// Exact native child execution inside the provider-owned shell sandbox. Native
// streams/timers own one held child through close; no detached process or PID scan.
// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import * as path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import {
  hasCafeSecretReference,
  makeCafeSecretStreamRedactor,
  redactCafeSecretText,
  substituteCafeSecretReferences,
} from "@cafecode/shared/cafeSecrets";
import { readSecretRunnerConnection } from "./session.ts";
import { ThreadSecretsStore } from "./store.ts";

const MAX_REQUEST_BYTES = 65_536;
const MAX_READ_BYTES = 1_048_576;
const failure = () =>
  new Error(
    "Cafe Secrets could not execute this request. Check the reference and use env/stdin for secret values.",
  );
type SecretRequest =
  | { operation: "run"; argv: string[]; env?: Record<string, string>; stdin?: string; cwd?: string }
  | { operation: "write_file"; path: string; content: string }
  | { operation: "read_file"; path: string };
export function parseSecretRequest(input: string): SecretRequest {
  if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) throw failure();
  const value: unknown = JSON.parse(input);
  if (!value || typeof value !== "object" || !("operation" in value)) throw failure();
  if (value.operation === "run") {
    if (
      !("argv" in value) ||
      !Array.isArray(value.argv) ||
      value.argv.length === 0 ||
      value.argv.length > 256 ||
      value.argv.some(
        (arg) => typeof arg !== "string" || arg.includes("\0") || hasCafeSecretReference(arg),
      )
    )
      throw failure();
    if (
      "cwd" in value &&
      (typeof value.cwd !== "string" ||
        !path.isAbsolute(value.cwd) ||
        hasCafeSecretReference(value.cwd))
    )
      throw failure();
    if ("stdin" in value && typeof value.stdin !== "string") throw failure();
    if (
      "env" in value &&
      (!value.env ||
        typeof value.env !== "object" ||
        Array.isArray(value.env) ||
        Object.entries(value.env).length > 128 ||
        Object.entries(value.env).some(
          ([name, val]) =>
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof val !== "string" || val.includes("\0"),
        ))
    )
      throw failure();
    if (
      Object.keys(value).some((key) => !["operation", "argv", "cwd", "stdin", "env"].includes(key))
    )
      throw failure();
    return value as SecretRequest;
  }
  if (
    (value.operation === "write_file" || value.operation === "read_file") &&
    "path" in value &&
    typeof value.path === "string" &&
    path.isAbsolute(value.path) &&
    !hasCafeSecretReference(value.path)
  ) {
    if (
      value.operation === "write_file" &&
      (!("content" in value) || typeof value.content !== "string")
    )
      throw failure();
    if (
      Object.keys(value).some(
        (key) =>
          !["operation", "path", ...(value.operation === "write_file" ? ["content"] : [])].includes(
            key,
          ),
      )
    )
      throw failure();
    return value as SecretRequest;
  }
  throw failure();
}

function redactor(values: ReadonlyMap<string, string>) {
  const decode = new StringDecoder("utf8");
  const redact = makeCafeSecretStreamRedactor(values);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      callback(null, redact(decode.write(chunk)));
    },
    flush(callback) {
      callback(null, redact(decode.end(), true));
    },
  });
}

export async function executeSecretRequest(
  request: SecretRequest,
  values: ReadonlyMap<string, string>,
): Promise<number> {
  if (request.operation === "read_file") {
    const namedBefore = await fs.lstat(request.path, { bigint: true });
    if (!namedBefore.isFile() || namedBefore.isSymbolicLink()) throw failure();
    const file = await fs.open(
      request.path,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const info = await file.stat({ bigint: true });
      if (
        !info.isFile() ||
        info.size > BigInt(MAX_READ_BYTES) ||
        info.dev !== namedBefore.dev ||
        info.ino !== namedBefore.ino
      )
        throw failure();
      const data = Buffer.alloc(Number(info.size) + 1);
      let offset = 0;
      while (offset < data.length) {
        const read = await file.read(data, offset, data.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      const after = await file.stat({ bigint: true });
      const namedAfter = await fs.lstat(request.path, { bigint: true });
      if (
        BigInt(offset) !== info.size ||
        info.size !== after.size ||
        info.mtimeNs !== after.mtimeNs ||
        info.ctimeNs !== after.ctimeNs ||
        !namedAfter.isFile() ||
        namedAfter.isSymbolicLink() ||
        namedAfter.dev !== info.dev ||
        namedAfter.ino !== info.ino
      )
        throw failure();
      process.stdout.write(
        redactCafeSecretText(
          new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, offset)),
          values,
        ),
      );
      return 0;
    } finally {
      await file.close();
    }
  }
  if (request.operation === "write_file") {
    const content = substituteCafeSecretReferences(request.content, values);
    if (Buffer.byteLength(content) > MAX_READ_BYTES) throw failure();
    let namedBefore: BigIntStats | undefined;
    try {
      namedBefore = await fs.lstat(request.path, { bigint: true });
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
        throw failure();
    }
    if (
      namedBefore &&
      (!namedBefore.isFile() || namedBefore.isSymbolicLink() || namedBefore.nlink !== 1n)
    )
      throw failure();
    const file = await fs.open(
      request.path,
      constants.O_WRONLY |
        (namedBefore ? 0 : constants.O_CREAT | constants.O_EXCL) |
        constants.O_NONBLOCK |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const info = await file.stat({ bigint: true });
      const named = await fs.lstat(request.path, { bigint: true });
      if (
        !info.isFile() ||
        info.nlink !== 1n ||
        !named.isFile() ||
        named.isSymbolicLink() ||
        named.dev !== info.dev ||
        named.ino !== info.ino ||
        (namedBefore && (namedBefore.dev !== info.dev || namedBefore.ino !== info.ino))
      )
        throw failure();
      if (process.platform !== "win32") await file.chmod(0o600);
      await file.truncate(0);
      await file.writeFile(content);
      await file.sync();
      process.stdout.write("File written with Cafe Secrets.\n");
      return 0;
    } finally {
      await file.close();
    }
  }
  const env = { ...process.env };
  for (const [name, value] of Object.entries(request.env ?? {}))
    Object.defineProperty(env, name, {
      value: substituteCafeSecretReferences(value, values),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  // Resolve every value before acquiring a native child. Raw values never
  // become Cafe/helper argv; env and stdin are the explicit expansion channels.
  const stdin =
    request.stdin === undefined ? undefined : substituteCafeSecretReferences(request.stdin, values);
  if (
    (stdin !== undefined && Buffer.byteLength(stdin) > MAX_READ_BYTES) ||
    Object.values(request.env ?? {}).reduce(
      (size, value) => size + Buffer.byteLength(substituteCafeSecretReferences(value, values)),
      0,
    ) > MAX_READ_BYTES
  )
    throw failure();
  const child = spawn(request.argv[0]!, request.argv.slice(1), {
    cwd: request.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
    windowsHide: true,
  });
  let stopping = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (!stopping) {
      stopping = true;
      child.kill("SIGTERM");
      // Native signal retirement owns this exact held child through close;
      // the timer cannot run an Effect after the helper runtime has exited.
      // @effect-diagnostics-next-line globalTimers:off
      escalation = setTimeout(() => child.kill("SIGKILL"), 1000);
      escalation.unref();
    }
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("SIGHUP", stop);
  let failed = false;
  const closed = new Promise<number>((resolve) => {
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code) => resolve(failed ? 1 : (code ?? 1)));
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(stdin);
  try {
    const outputs = await Promise.allSettled([
      pipeline(child.stdout, redactor(values), process.stdout, { end: false }).catch(
        (error: unknown) => {
          stop();
          throw error;
        },
      ),
      pipeline(child.stderr, redactor(values), process.stderr, { end: false }).catch(
        (error: unknown) => {
          stop();
          throw error;
        },
      ),
    ]);
    if (outputs.some((result) => result.status === "rejected")) stop();
    return await closed;
  } finally {
    if (escalation) clearTimeout(escalation);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGHUP", stop);
  }
}

export async function runSecretRunner(args: readonly string[]): Promise<void> {
  try {
    if (args.length !== 2 || !args[0] || !args[1]) throw failure();
    const connection = await readSecretRunnerConnection(args[0]);
    const request = parseSecretRequest(args[1]);
    const values = await new ThreadSecretsStore(connection.secretsDir).snapshot(
      connection.threadId,
    );
    process.exitCode = await executeSecretRequest(request, values);
  } catch {
    process.stderr.write(
      "Cafe Secrets could not execute this request. Check the reference, runner availability, and use env/stdin for secret values.\n",
    );
    process.exitCode = 1;
  }
}
