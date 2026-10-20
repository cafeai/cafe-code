// These native descriptors qualify the real child/receipt lifetime, not app IO.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
// The inert peer argv and private working directories use actual host paths.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  launchLocalTypecheckCompiler,
  runLocalTypecheckPrograms,
  type LocalCompilerExit,
  type LocalCompilerLaunch,
  type LocalTypecheckResult,
} from "./lib/local-typecheck.ts";
import {
  runEffectCompilerQualificationProcess,
  type CompilerProcessResult,
} from "./lib/effect-compiler-qualification.ts";

const encodeJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const decodeFifoRefusal = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      reason: Schema.Literal("workspace"),
      message: Schema.String,
      metadataCalls: Schema.Number,
      compilerCalls: Schema.Number,
    }),
  ),
);

type ReceiptFailure =
  | "incomplete"
  | "argv"
  | "receipt-config"
  | "receipt-connect"
  | "receipt-ended"
  | "release-frame"
  | "environment-keys"
  | "heap-policy"
  | "native-signal"
  | "native-transport"
  | "unexpected-exit";

function deferred<T>() {
  let complete!: (value: T) => void;
  let fail!: (phase?: ReceiptFailure) => void;
  const promise = new Promise<T>((resolve, reject) => {
    complete = resolve;
    fail = (phase = "incomplete") =>
      reject(new Error(`The owned native fixture did not complete its receipt (${phase}).`));
  });
  // Cleanup may reject an unobserved queued peer's readiness. It is not an
  // unhandled rejection, and an awaited readiness still retains that failure.
  void promise.catch(() => undefined);
  return { promise, complete, fail };
}

const names = ["first", "second", "queued"] as const;
type PeerName = (typeof names)[number];

/** Project only the inert peer's closed finite exit protocol. Never attach its
 * environment, source path, argv, stderr or a received native error to output. */
function closedReceiptPhase(exit: LocalCompilerExit): ReceiptFailure {
  if (exit.transportError) return "native-transport";
  if (exit.signal !== null) return "native-signal";
  switch (exit.code) {
    case 71:
      return "argv";
    case 72:
      return "receipt-config";
    case 73:
      return "receipt-connect";
    case 74:
      return "receipt-ended";
    case 75:
      return "release-frame";
    case 76:
      return "environment-keys";
    case 77:
      return "heap-policy";
    default:
      return "unexpected-exit";
  }
}

/** Both inert sources accept the production launcher's exact --noEmit argv.
 * One remains live until the native termination signal; the other exits zero
 * only after its exact owning receipt socket receives a release. No compiler,
 * provider, user file, inherited loader or shell is involved. */
function peerSource(exitOnRelease: boolean): string {
  return `import { writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, join } from "node:path";
const role = basename(process.cwd());
if (process.argv.length !== 3 || process.argv[2] !== "--noEmit") process.exit(71);
const nonce = process.env.CAFE_LOCAL_TYPE_RECEIPT_NONCE;
const port = Number(process.env.CAFE_LOCAL_TYPE_RECEIPT_PORT);
if (!/^[a-f0-9]{64}$/.test(nonce ?? "") || !Number.isInteger(port) || port < 1 || port > 65535) process.exit(72);
// Darwin itself injects this text-encoding key even when the parent's native
// spawn environment omits it. No caller value is copied by the fixture below.
const allowed = new Set(["HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "CAFE_LOCAL_TYPE_RECEIPT_NONCE", "CAFE_LOCAL_TYPE_RECEIPT_PORT", "NODE_OPTIONS", ...(process.platform === "win32" ? ["SystemRoot", "WINDIR"] : []), ...(process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : [])]);
const refusedKeys = Object.keys(process.env).filter((name) => !allowed.has(name));
if (refusedKeys.length) {
  const names = refusedKeys.slice(0, 16).map((name) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ? name : "<nonstandard-key>");
  if (refusedKeys.length > 16) names.push("<more-keys>");
  writeFileSync(join(process.cwd(), "refused-environment-keys"), names.join("\\n"), { flag: "wx", mode: 0o600 });
  process.exit(76);
}
if (process.env.NODE_OPTIONS !== "--max-old-space-size=4096") process.exit(77);
writeFileSync(join(process.cwd(), "started"), nonce, { flag: "wx", mode: 0o600 });
const socket = createConnection({ host: "127.0.0.1", port });
socket.once("connect", () => socket.write(nonce + " " + role + "\\n"));
socket.once("error", () => process.exit(73));
socket.once("end", () => process.exit(74));
${exitOnRelease ? 'let release = ""; socket.on("data", (bytes) => { if (bytes.length > 5 || Buffer.byteLength(release) + bytes.length > 5) process.exit(75); release += bytes.toString("utf8"); if (release === "exit\\n") process.exit(0); else if (release.includes("\\n")) process.exit(75); });' : ""}
`;
}

async function withNativePeers(
  use: (fixture: {
    readonly signal: AbortSignal;
    readonly abort: () => void;
    readonly launch: LocalCompilerLaunch;
    readonly programs: (firstExitsZero: boolean) => readonly {
      name: string;
      cwd: string;
      compiler: string;
    }[];
    readonly started: (name: PeerName) => Promise<void>;
    readonly releaseZero: (name: PeerName) => void;
    readonly beforeCleanup: (release: () => void) => void;
    readonly trackRun: (run: Promise<LocalTypecheckResult>) => Promise<LocalTypecheckResult>;
    readonly assertNotStarted: (name: PeerName) => Promise<void>;
    readonly closed: Map<string, LocalCompilerExit>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cafe-native-local-types-"));
  const nonce = randomBytes(32).toString("hex");
  const controller = new AbortController();
  const receipts = new Map(names.map((name) => [name, deferred<void>()]));
  const sockets = new Set<Socket>();
  const peers = new Map<PeerName, Socket>();
  const nativeCloses: Promise<LocalCompilerExit>[] = [];
  const runs: Promise<LocalTypecheckResult>[] = [];
  const releases: (() => void)[] = [];
  const closed = new Map<string, LocalCompilerExit>();
  let retired = false;
  let cleanupPromise: Promise<void> | undefined;
  let listenSettlement: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let bytes = "";
    let admitted = false;
    socket.on("error", () => {
      for (const receipt of receipts.values()) receipt.fail();
    });
    socket.on("data", (chunk: Buffer) => {
      if (admitted || chunk.length > 80 || Buffer.byteLength(bytes) + chunk.length > 80) {
        for (const receipt of receipts.values()) receipt.fail();
        socket.destroy();
        return;
      }
      bytes += chunk.toString("utf8");
      if (!bytes.endsWith("\n")) return;
      const name = names.find((candidate) => bytes === `${nonce} ${candidate}\n`);
      if (name === undefined || peers.has(name)) {
        for (const receipt of receipts.values()) receipt.fail();
        socket.destroy();
        return;
      }
      admitted = true;
      peers.set(name, socket);
      receipts.get(name)!.complete();
    });
  });
  server.maxConnections = names.length;
  server.on("error", () => {
    for (const receipt of receipts.values()) receipt.fail();
  });
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      retired = true;
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      for (const release of releases) release();
      for (const receipt of receipts.values()) receipt.fail();
      // Queue completion is not inferred from signal delivery. Every launched
      // production child adapter must deliver its actual native close first.
      await Promise.allSettled(runs);
      await Promise.allSettled(nativeCloses);
      for (const socket of sockets) socket.destroy();
      if (listenSettlement !== undefined) await Promise.allSettled([listenSettlement]);
      if (server.listening)
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    })();
    return cleanupPromise;
  };
  // Hard-timeout cleanup owns the same children even if the async body never
  // resumes. Register it before the first native listen/readiness await.
  onTestFinished(cleanup);
  // This is the native-child fixture's fixed wall-clock budget, not an Effect
  // test clock or a renewable timeout for a stalled compiler/provider.
  // @effect-diagnostics-next-line globalTimers:off
  timer = setTimeout(() => {
    controller.abort();
    for (const receipt of receipts.values()) receipt.fail();
  }, 30_000);
  try {
    await mkdir(join(root, "home"));
    for (const name of names) await mkdir(join(root, name));
    await writeFile(join(root, "held.mjs"), peerSource(false), { flag: "wx", mode: 0o600 });
    await writeFile(join(root, "zero.mjs"), peerSource(true), { flag: "wx", mode: 0o600 });
    if (retired) throw new Error("The native fixture was retired before listener admission.");
    listenSettlement = new Promise<void>((resolveListen, reject) => {
      server.once("error", () =>
        reject(new Error("The private receipt listener could not start.")),
      );
      server.listen({ host: "127.0.0.1", port: 0 }, () => resolveListen());
    });
    await listenSettlement;
    if (retired) throw new Error("The native fixture was retired before admission.");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("The private receipt listener has no owned TCP address.");
    // The actual launcher intentionally inherits its caller's environment.
    // Isolate this test worker while invoking it: no provider credentials,
    // user home, PATH, Node hook or loader configuration reaches either peer.
    const environment: Record<string, string> = {
      HOME: join(root, "home"),
      USERPROFILE: join(root, "home"),
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      CAFE_LOCAL_TYPE_RECEIPT_NONCE: nonce,
      CAFE_LOCAL_TYPE_RECEIPT_PORT: String(address.port),
    };
    if (process.platform === "win32") {
      for (const name of ["SystemRoot", "WINDIR"]) {
        const value = process.env[name];
        if (value !== undefined) environment[name] = value;
      }
    }
    for (const name of Object.keys(process.env)) vi.stubEnv(name, undefined);
    for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
    await use({
      signal: controller.signal,
      abort: () => controller.abort(),
      launch: (program) => {
        const child = launchLocalTypecheckCompiler(program);
        const actualClose = child.closed.then(async (exit) => {
          closed.set(program.name, exit);
          if (exit.code === 76) {
            // The inert peer retains names only, never environment values.
            // Unknown keys remain a refusal; this observation grants nothing.
            try {
              const file = await open(join(program.cwd, "refused-environment-keys"), "r");
              try {
                const bytes = Buffer.alloc(1_201);
                const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
                const names = bytes.toString("utf8", 0, bytesRead);
                if (
                  bytesRead <= 1_200 &&
                  names.split("\n").length <= 17 &&
                  names
                    .split("\n")
                    .every(
                      (name) =>
                        /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ||
                        name === "<nonstandard-key>" ||
                        name === "<more-keys>",
                    )
                )
                  process.stderr.write(
                    `[native-local-types] refused environment key names: ${names.replaceAll("\n", ", ")}\n`,
                  );
              } finally {
                await file.close();
              }
            } catch {
              process.stderr.write(
                "[native-local-types] refused environment key observation unavailable.\n",
              );
            }
          }
          const name = names.find((candidate) => program.name === `@fixture/${candidate}`);
          if (name !== undefined) receipts.get(name)!.fail(closedReceiptPhase(exit));
          return exit;
        });
        nativeCloses.push(actualClose);
        return { closed: actualClose, terminate: child.terminate };
      },
      programs: (firstExitsZero) =>
        names.map((name, index) => ({
          name: `@fixture/${name}`,
          cwd: join(root, name),
          compiler: join(root, firstExitsZero && index === 0 ? "zero.mjs" : "held.mjs"),
        })),
      started: (name) => receipts.get(name)!.promise,
      releaseZero: (name) => {
        const socket = peers.get(name);
        if (!socket) throw new Error("The exact native peer has not been admitted.");
        socket.write("exit\n");
      },
      beforeCleanup: (release) => {
        releases.push(release);
      },
      trackRun: (run) => {
        runs.push(run);
        void run.catch(() => undefined);
        return run;
      },
      assertNotStarted: async (name) => {
        expect(peers.has(name)).toBe(false);
        await expect(readFile(join(root, name, "started"), "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      closed,
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await cleanup();
  }
}

describe.skipIf(process.env.CAFE_CODE_LOCAL_TYPECHECK_E2E !== "1")(
  "native local typecheck cancellation",
  () => {
    it("retires both exact live children and never starts the queued third program", async () => {
      await withNativePeers(async (fixture) => {
        const run = fixture.trackRun(
          runLocalTypecheckPrograms(fixture.programs(false), 2, fixture.signal, fixture.launch),
        );
        await Promise.all([fixture.started("first"), fixture.started("second")]);
        expect(fixture.closed.size).toBe(0);
        fixture.abort();
        const result = await run;
        expect(result.passed).toBe(false);
        expect(result.cancelled).toBe(true);
        expect(result.completed).toBe(2);
        expect([...fixture.closed.keys()].sort()).toEqual(["@fixture/first", "@fixture/second"]);
        for (const exit of fixture.closed.values()) expect(exit.transportError).toBe(false);
        await fixture.assertNotStarted("queued");
      });
    }, 30_000);

    it("cannot qualify or admit queued work from an actual zero close delivered after cancellation", async () => {
      await withNativePeers(async (fixture) => {
        const actualClose = deferred<LocalCompilerExit>();
        const releaseClose = deferred<void>();
        fixture.beforeCleanup(() => releaseClose.complete());
        const run = fixture.trackRun(
          runLocalTypecheckPrograms(fixture.programs(true), 1, fixture.signal, (program) => {
            const child = fixture.launch(program);
            return {
              terminate: child.terminate,
              closed: child.closed.then(async (exit) => {
                actualClose.complete(exit);
                await releaseClose.promise;
                return exit;
              }),
            };
          }),
        );
        await fixture.started("first");
        fixture.releaseZero("first");
        expect(await actualClose.promise).toEqual({ code: 0, signal: null, transportError: false });
        fixture.abort();
        releaseClose.complete();
        expect(await run).toEqual({ passed: false, cancelled: true, completed: 1, failures: [] });
        await fixture.assertNotStarted("second");
        await fixture.assertNotStarted("queued");
      });
    }, 30_000);

    // POSIX O_NONBLOCK is the boundary under qualification. Windows has no
    // POSIX FIFO manifest or flag; its native cancellation cases above remain.
    it.skipIf(process.platform === "win32")(
      "refuses a real FIFO manifest before metadata or compiler admission without blocking the test worker",
      async () => {
        const root = await mkdtemp(join(tmpdir(), "cafe-local-types-fifo-"));
        const controller = new AbortController();
        let retired = false;
        let running: Promise<CompilerProcessResult> | undefined;
        let cleanupPromise: Promise<void> | undefined;
        const cleanup = () => {
          cleanupPromise ??= (async () => {
            retired = true;
            controller.abort();
            // The reviewed helper resolves only at the exact held child's
            // native close, even if its filesystem worker is stuck opening a
            // FIFO. Never leave that operation in the Vitest process itself.
            if (running !== undefined) await Promise.allSettled([running]);
            await rm(root, { recursive: true, force: true });
          })();
          return cleanupPromise;
        };
        onTestFinished(cleanup);
        try {
          const sourceRoot = join(root, "source");
          const peer = join(root, "fifo-refusal.mjs");
          await mkdir(sourceRoot);
          // Both the FIFO creation and the potentially blocking source read
          // belong to this one disposable Node child. The fixed system tool
          // receives only structured fixture-owned argv, no shell or PATH.
          await writeFile(
            peer,
            `import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { discoverLocalTypecheckPrograms, LocalTypecheckError, runLocalTypecheckPrograms } from ${encodeJsonString(new URL("./lib/local-typecheck.ts", import.meta.url).href)};
const source = ${encodeJsonString(sourceRoot)};
const created = spawnSync("/usr/bin/mkfifo", ["-m", "600", join(source, "package.json")], {
  env: {}, stdio: "ignore", shell: false, timeout: 5000,
});
if (created.status !== 0 || created.signal !== null || created.error !== undefined) process.exit(71);
let metadataCalls = 0;
let compilerCalls = 0;
const controller = new AbortController();
try {
  const programs = await discoverLocalTypecheckPrograms(source, controller.signal, async () => {
    metadataCalls++;
    return JSON.stringify({ name: "@fixture/fifo-root", location: "." }) + "\\n";
  });
  await runLocalTypecheckPrograms(programs, 1, controller.signal, () => {
    compilerCalls++;
    return { closed: Promise.resolve({ code: 0, signal: null, transportError: false }), terminate() {} };
  });
  process.exitCode = 72;
} catch (error) {
  if (!(error instanceof LocalTypecheckError) || error.reason !== "workspace") process.exitCode = 73;
  else process.stdout.write(JSON.stringify({ reason: error.reason, message: error.message, metadataCalls, compilerCalls }) + "\\n");
}
`,
            { flag: "wx", mode: 0o600 },
          );
          if (retired) throw new Error("The FIFO fixture retired before native admission.");
          // Reuse the established 30s/64KiB/4GiB disposable-child boundary and
          // its sanitized environment: no inherited loaders, profiles or PATH.
          running = runEffectCompilerQualificationProcess([peer], root, controller.signal);
          const result = await running;
          if (retired) throw new Error("The FIFO fixture retired before its close receipt.");
          expect(result).toMatchObject({ code: 0, signal: null, failure: null, stderr: "" });
          expect(decodeFifoRefusal(result.stdout)).toEqual({
            reason: "workspace",
            message:
              "Local typechecking refused an unsupported workspace contract. Run corepack yarn typecheck and review the local coordinator policy; no complete qualification was granted.",
            metadataCalls: 0,
            compilerCalls: 0,
          });
        } finally {
          await cleanup();
        }
      },
      30_000,
    );
  },
);
