// Native fixture owns exact child argv, stdio handles and retirement; keep that process boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn, spawnSync } from "node:child_process";
// Native fixture exercises actual file identity, namespace and cleanup behavior.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// Native fixture paths retain host drive, separator and namespace semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { glideChildEnvironment } from "../src/glide/runtime.ts";

interface Receipt {
  kind: string;
  pid: number;
  birth: { seconds: number; microseconds: number };
  foreground: { pid: number; birth: { seconds: number; microseconds: number } };
  pointer: { x: number; y: number };
  marker?: number;
  target?: number;
}
interface Peer {
  child: ReturnType<typeof spawn>;
  exit: Promise<void>;
  records: Receipt[];
  waiters: Set<{
    accept: (value: Receipt) => boolean;
    resolve: (value: Receipt) => void;
    reject: (error: unknown) => void;
  }>;
}

// Real PID-tap transport between exact fresh native processes. This qualifies
// repost/drop, helper-source passing and retirement without sending a key to
// the human foreground. Production CPS/AX admission is qualified separately.
it.skipIf(process.platform !== "darwin")(
  "rescues native PID-addressed control events only to the exact owned recipient",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cafe-glide-key-rescue-transport-"));
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const executable = join(directory, "OwnedNativePeer");
    const peers: Peer[] = [];
    let initial: Receipt | undefined;
    let retired = false;
    let failure: unknown;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        retired = true;
        for (const peer of peers) {
          for (const waiter of peer.waiters) waiter.reject(new Error("Owned native peer retired."));
          peer.waiters.clear();
          peer.child.stdin?.end();
        }
        await Promise.all(
          peers.map(async (peer) => {
            // Native opt-in fixture retains its exact wall-clock deadline, callback and child cleanup.
            // @effect-diagnostics-next-line globalTimers:off
            const force = setTimeout(() => peer.child.kill("SIGKILL"), 1500);
            try {
              await peer.exit;
            } finally {
              clearTimeout(force);
            }
          }),
        );
        await rm(directory, { recursive: true, force: true });
      })());
    onTestFinished(cleanup);
    const fail = (error: unknown) => {
      if (retired) return;
      failure = error;
      for (const peer of peers) {
        for (const waiter of peer.waiters) waiter.reject(error);
        peer.waiters.clear();
        peer.child.stdin?.end();
      }
    };
    const bounded = async <A>(promise: Promise<A>): Promise<A> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_resolve, reject) => {
            // Native opt-in fixture retains its exact wall-clock deadline, callback and child cleanup.
            // @effect-diagnostics-next-line globalTimers:off
            timer = setTimeout(
              () => reject(new Error("Owned native event receipt deadline.")),
              10_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const until = (peer: Peer, accept: (value: Receipt) => boolean) => {
      if (failure) return Promise.reject(failure);
      const existing = peer.records.find(accept);
      if (existing) return Promise.resolve(existing);
      const result = new Promise<Receipt>((resolveReceipt, reject) =>
        peer.waiters.add({ accept, resolve: resolveReceipt, reject }),
      );
      void result.catch(() => undefined);
      return result;
    };
    const start = (arguments_: string[]) => {
      const child = spawn(executable, arguments_, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...glideChildEnvironment(process.env),
          HOME: directory,
          CFFIXED_USER_HOME: directory,
          TMPDIR: directory,
        },
      });
      const peer: Peer = { child, exit: Promise.resolve(), records: [], waiters: new Set() };
      let pending = "";
      child.stderr?.resume();
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (data: string) => {
        try {
          pending += data;
          if (pending.length > 64 * 1024) throw new Error("Native receipt frame bound.");
          for (;;) {
            const end = pending.indexOf("\n");
            if (end < 0) break;
            const value = JSON.parse(pending.slice(0, end)) as Receipt;
            pending = pending.slice(end + 1);
            if (retired) continue;
            if (peer.records.length >= 32) throw new Error("Native receipt count bound.");
            initial ??= value;
            expect(value.foreground).toEqual(initial.foreground);
            expect(value.pointer).toEqual(initial.pointer);
            expect(value.pid).toBe(child.pid);
            expect(value.birth.seconds).toBeGreaterThan(0);
            expect(value.kind).not.toBe("failure");
            peer.records.push(value);
            for (const waiter of peer.waiters)
              if (waiter.accept(value)) {
                peer.waiters.delete(waiter);
                waiter.resolve(value);
              }
          }
        } catch (error) {
          fail(error);
        }
      });
      peer.exit = new Promise<void>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", () => resolveExit());
      });
      void peer.exit.catch(fail);
      peers.push(peer);
      return peer;
    };
    const send = (peer: Peer, value: Record<string, unknown>) =>
      peer.child.stdin!.write(JSON.stringify(value) + "\n");
    const identityArguments = (value: Receipt) => [
      String(value.pid),
      String(value.birth.seconds),
      String(value.birth.microseconds),
    ];
    try {
      const compiler = spawnSync(
        "xcrun",
        [
          "swiftc",
          "-target",
          `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`,
          join(root, "apps/desktop/native/mac-glide-focus-policy.swift"),
          join(root, "apps/desktop/native/mac-glide-incoming-focus.swift"),
          join(root, "apps/desktop/native/mac-glide-key-rescue-policy.swift"),
          join(root, "apps/desktop/native/mac-glide-key-rescue-guard.swift"),
          fileURLToPath(
            new URL("./fixtures/glide-key-rescue-transport.fixture.swift", import.meta.url),
          ),
          "-o",
          executable,
        ],
        { shell: false, timeout: 30_000, encoding: "utf8" },
      );
      expect(compiler.status, compiler.stderr).toBe(0);
      const thief = start(["--peer"]),
        receiver = start(["--peer"]);
      const thiefIdentity = await bounded(until(thief, (value) => value.kind === "ready"));
      const receiverIdentity = await bounded(until(receiver, (value) => value.kind === "ready"));
      expect(thiefIdentity.pid).not.toBe(receiverIdentity.pid);
      expect([thiefIdentity.pid, receiverIdentity.pid]).not.toContain(initial!.foreground.pid);
      const controller = start([
        "--controller",
        ...identityArguments(thiefIdentity),
        ...identityArguments(receiverIdentity),
      ]);
      await bounded(until(controller, (value) => value.kind === "ready"));
      // Observers are appended after the active rescue tap, so a dropped
      // original event never becomes a thief receipt.
      for (const peer of [thief, receiver]) {
        const observing = until(peer, (value) => value.kind === "observing");
        send(peer, { op: "observe" });
        await bounded(observing);
      }
      const generate = async (marker: number) => {
        const source = start(["--post", ...identityArguments(thiefIdentity), String(marker)]);
        await bounded(until(source, (value) => value.kind === "posted"));
        await bounded(source.exit);
      };
      const baseline = until(thief, (value) => value.kind === "event" && value.marker === 1001);
      await generate(1001);
      expect((await bounded(baseline)).target).toBe(thiefIdentity.pid);
      const armed = until(controller, (value) => value.kind === "armed");
      send(controller, { op: "arm" });
      await bounded(armed);
      const rescued = until(receiver, (value) => value.kind === "event" && value.marker === 1002);
      await generate(1002);
      expect((await bounded(rescued)).target).toBe(receiverIdentity.pid);
      // An own-source positive fences the later thief stream and establishes
      // the helper's pass rule without sleeps or replayed human input.
      const own = until(thief, (value) => value.kind === "event" && value.marker === 1003);
      send(controller, { op: "post-own", marker: 1003 });
      await bounded(own);
      expect(thief.records.some((value) => value.marker === 1002)).toBe(false);
      expect(receiver.records.filter((value) => value.marker === 1002)).toHaveLength(1);
      const stopped = until(controller, (value) => value.kind === "retired");
      send(controller, { op: "retire" });
      await bounded(stopped);
      const after = until(thief, (value) => value.kind === "event" && value.marker === 1004);
      await generate(1004);
      expect((await bounded(after)).target).toBe(thiefIdentity.pid);
      expect(receiver.records.some((value) => value.marker === 1004)).toBe(false);
      if (failure) throw failure;
      if (process.env.CAFE_GLIDE_NATIVE_RECEIPTS === "1") {
        await mkdir(join(root, ".logs"), { recursive: true });
        await writeFile(
          join(root, ".logs/glide-key-rescue-transport-receipts.json"),
          JSON.stringify(
            peers.map((peer) => peer.records),
            null,
            2,
          ),
          { mode: 0o600 },
        );
      }
      // Explicit native qualification output retains the existing stdout/stderr receipt protocol.
      // @effect-diagnostics-next-line globalConsole:off
      console.info(
        JSON.stringify({
          qualification: "glide-native-key-rescue-transport",
          receipts: peers.reduce((count, peer) => count + peer.records.length, 0),
          foreground: initial!.foreground,
          pointer: initial!.pointer,
          exactRescuedMarker: 1002,
          originalDropped: true,
          ownSourcePassed: true,
          retiredPassed: true,
        }),
      );
    } catch (error) {
      // Explicit native qualification output retains the existing stdout/stderr receipt protocol.
      // @effect-diagnostics-next-line globalConsole:off
      console.error(
        "Native key rescue transport failed",
        JSON.stringify(peers.map((peer) => peer.records)),
      );
      throw error;
    } finally {
      await cleanup();
    }
  },
  60_000,
);
