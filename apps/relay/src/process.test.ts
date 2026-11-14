// @effect-diagnostics nodeBuiltinImport:off
// These fixtures own exactly the returned Node children, IPC channels and files.
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import {
  createIdentity,
  deriveIdentityId,
  privateIdentityBytes,
  sha256,
} from "@cafecode/relay/crypto";
import { signNetwork } from "@cafecode/relay/descriptor";
import { opaque, randomOpaque, unopaque } from "@cafecode/relay/bytes";
import { canonicalBytes, readCanonical } from "@cafecode/relay/protocol";
import { LookupResult } from "@cafecode/relay/controls";
import { epochNow, Lifetime } from "@cafecode/relay/lifetime";
import { RelayLeg } from "@cafecode/relay/leg";
import { connectNative } from "@cafecode/relay/nativeWire";
import { NativeHostWorkClient } from "@cafecode/relay/nativeHostWork";
import { relayResources, type PacketConnection } from "@cafecode/relay/wire";
import type { RelayNodeConfig } from "./config.ts";

it.skipIf(process.platform === "win32")(
  "runs three separate service processes, reloads membership, discovers a remote registration and reaps every child",
  // Three cold native Node starts, reloads and authenticated discovery share
  // this integration-test allowance. Production and native cleanup budgets
  // remain independent and unchanged.
  { timeout: 15_000 },
  async (test) => {
    let retired = false,
      directory: string | undefined;
    const lifetime = new Lifetime(),
      cleanupLifetime = new Lifetime(),
      work = new NativeHostWorkClient(),
      children = new Set<ChildProcess>(),
      closes = new Map<ChildProcess, Promise<void>>(),
      connections = new Set<PacketConnection>(),
      operations = new Set<Promise<unknown>>();
    const nativeLogs: string[] = [];
    const reloadRefusalsByChild: number[] = [];
    let phase:
        | "temporary-directory"
        | "identities"
        | "initial-network"
        | "config-write"
        | "child-ready"
        | "updated-network"
        | "reload"
        | "host-work"
        | "register"
        | "lookup-headers"
        | "lookup-body"
        | "assertions"
        | "native-close" = "temporary-directory",
      readyCount = 0,
      reloadCount = 0,
      completedReloadWrites = 0,
      requestedReloadSignals = 0,
      closedCount = 0;
    const startedAt = performance.now();
    const phaseObservation = () => ({
      phase,
      children: children.size,
      ready: readyCount,
      reloaded: reloadCount,
      completedReloadWrites,
      requestedReloadSignals,
      reloadRefusalsByChild: [...reloadRefusalsByChild],
      closed: closedCount,
      elapsedMs: Math.min(60_000, Math.max(0, Math.round(performance.now() - startedAt))),
    });
    let failureObservation: ReturnType<typeof phaseObservation> | undefined;
    const freezeFailure = () => {
      failureObservation ??= phaseObservation();
    };
    const assertActive = () => {
      if (retired || test.signal.aborted) throw new Error("fixture-retired");
    };
    // Keep the actual acquisition/body promises, not merely their callers.
    // Retirement fences new operations, while cleanup joins admitted writes
    // and lookup decoding before removing their private filesystem owner.
    const own = <A>(start: () => Promise<A>): Promise<A> => {
      assertActive();
      const operation = start();
      operations.add(operation);
      void operation.then(
        () => operations.delete(operation),
        () => operations.delete(operation),
      );
      return operation;
    };
    const retire = () => {
      if (retired) return;
      retired = true;
      // This parent also owns host-work HTTP/worker cancellation and the
      // lookup request. Neither may remain admitted until a later finalizer.
      lifetime.retire();
      for (const connection of connections) connection.retire();
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    };
    const onAbort = () => {
      freezeFailure();
      retire();
    };
    // The public test signal owns retirement before filesystem/key/native IO.
    test.signal.addEventListener("abort", onAbort, { once: true });
    test.onTestFailed(() => {
      freezeFailure();
      try {
        Effect.runSync(
          Effect.logError("Synthetic relay process failure phase", failureObservation),
        );
      } catch {
        // Passive fixed metadata cannot replace the original failure.
      }
    });
    test.onTestFinished(async () => {
      // Preserve the first body/timeout observation before cleanup changes
      // native counts. Successful runs never publish this observation.
      freezeFailure();
      retire();
      test.signal.removeEventListener("abort", onAbort);
      let forced = false;
      const cancel = cleanupLifetime.later(2_000, () => {
        for (const child of children)
          if (child.exitCode === null && child.signalCode === null) {
            forced = true;
            child.kill("SIGKILL");
          }
      });
      await Promise.allSettled([...connections].map((connection) => connection.close()));
      await Promise.all([...closes.values()]);
      cancel();
      await cleanupLifetime.close();
      await lifetime.close();
      await work.close();
      while (operations.size) await Promise.allSettled([...operations]);
      if (directory) await fs.rm(directory, { recursive: true, force: true });
      expect(forced).toBe(false);
    });
    if (test.signal.aborted) onAbort();
    await own(async () => {
      // Adopt a late directory inside the held promise so timeout cleanup
      // cannot finish before learning the exact path it must remove.
      directory = await fs.mkdtemp(path.join(os.tmpdir(), "cafe-relay-process-"));
    });
    assertActive();
    phase = "identities";
    const [root, nodeA, nodeB, nodeC, admission] = await Promise.all(
      Array.from({ length: 5 }, () => createIdentity()),
    );
    assertActive();
    const identities = [nodeA!, nodeB!, nodeC!],
      nodeIds = identities.map((node) => deriveIdentityId("node", node.publicKey));
    phase = "initial-network";
    const network = await signNetwork({
      root: root!,
      revision: 1,
      expiresAt: epochNow() + 3_600_000,
      nodes: identities.map((node, index) => ({
        id: nodeIds[index]!,
        publicKey: node.publicKey,
        url: `ws://127.0.0.1:${10001 + index}/v1/relay`,
      })),
    });
    assertActive();
    const locator = randomOpaque(),
      capacity = randomOpaque();
    const configs: RelayNodeConfig[] = identities.map((identity, index) => ({
      version: 1,
      rootPublicKey: root!.publicKey,
      descriptor: network,
      nodeId: nodeIds[index]!,
      privateIdentity: opaque(privateIdentityBytes(identity)),
      grants: [
        {
          locator,
          admissionPublicKey: admission!.publicKey,
          tokenDigest: opaque(sha256(unopaque(capacity, 32))),
        },
      ],
      listen: { host: "127.0.0.1", port: 0 },
      mesh: { host: "127.0.0.1", port: 0, peers: [] },
    }));
    const started: Array<{ child: ChildProcess; port: number; meshPort: number }> = [];
    for (let index = 0; index < configs.length; index++) {
      assertActive();
      phase = "config-write";
      const filename = path.join(directory!, `node-${index}.json`);
      await own(() =>
        fs.writeFile(filename, canonicalBytes(configs[index], 65_536), {
          flag: "wx",
          mode: 0o600,
        }),
      );
      // The file write yields. A timeout must not acquire a child after the
      // cleanup owner has captured and joined its exact native children.
      assertActive();
      const child = spawn(
        process.execPath,
        [
          "--max-old-space-size=256",
          process.env.CAFE_RELAY_ARTIFACT ?? fileURLToPath(new URL("./main.ts", import.meta.url)),
          "--config",
          filename,
          "--local-test",
        ],
        {
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" },
        },
      );
      children.add(child);
      reloadRefusalsByChild.push(0);
      const closed = Promise.withResolvers<void>();
      closes.set(child, closed.promise);
      child.once("close", () => {
        closedCount += 1;
        closed.resolve();
      });
      let outputBytes = 0;
      const outputLineTails = { stdout: "", stderr: "" };
      const output = (channel: "stdout" | "stderr") => (chunk: Uint8Array) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > 4096) {
          freezeFailure();
          retire();
          return;
        }
        const decoded = new TextDecoder().decode(chunk);
        nativeLogs.push(decoded);
        // Each exact child owns its partial line. Count only this complete,
        // fixed native phase within the existing 4096-byte output bound;
        // diagnostic publication never includes the buffered output itself.
        const lines = (outputLineTails[channel] + decoded).split("\n");
        outputLineTails[channel] = lines.pop()!;
        for (const line of lines)
          if (line === "relay-reload-refused") reloadRefusalsByChild[index]! += 1;
      };
      child.stdout!.on("data", output("stdout"));
      child.stderr!.on("data", output("stderr"));
      const ready = Promise.withResolvers<{ port: number; meshPort: number }>();
      child.on("error", () => {
        freezeFailure();
        ready.reject(new Error("native-acquisition-failed"));
        retire();
      });
      child.once("close", () => ready.reject(new Error("native-before-ready")));
      child.on("message", (value) => {
        if (
          typeof value !== "object" ||
          value === null ||
          !("phase" in value) ||
          value.phase !== "ready" ||
          !("port" in value) ||
          !("meshPort" in value)
        )
          return;
        if (
          typeof value.port === "number" &&
          Number.isInteger(value.port) &&
          value.port > 0 &&
          typeof value.meshPort === "number" &&
          Number.isInteger(value.meshPort) &&
          value.meshPort > 0
        )
          ready.resolve({ port: value.port, meshPort: value.meshPort });
      });
      if (retired) {
        child.kill("SIGTERM");
        throw new Error("fixture-retired");
      }
      phase = "child-ready";
      const readyState = await ready.promise;
      assertActive();
      readyCount += 1;
      started.push({ child, ...readyState });
    }
    phase = "updated-network";
    const updated = await signNetwork({
      root: root!,
      revision: 2,
      expiresAt: epochNow() + 3_600_000,
      nodes: network.nodes.map((node, index) => ({
        ...node,
        url: `ws://127.0.0.1:${started[index]!.port}/v1/relay`,
      })),
    });
    assertActive();
    phase = "reload";
    const reloads = started.map(
      (entry, index) =>
        new Promise<void>((resolve, reject) => {
          entry.child.once("close", () => reject(new Error("native-before-reload")));
          const reloaded = (value: unknown) => {
            if (
              typeof value === "object" &&
              value !== null &&
              "phase" in value &&
              value.phase === "reloaded" &&
              "revision" in value &&
              value.revision === 2
            ) {
              entry.child.off("message", reloaded);
              reloadCount += 1;
              resolve();
            }
          };
          entry.child.on("message", reloaded);
          const replacement: RelayNodeConfig = {
            ...configs[index]!,
            descriptor: updated,
            mesh: {
              ...configs[index]!.mesh,
              peers: nodeIds.flatMap((nodeId, peer) =>
                index === peer
                  ? []
                  : [{ nodeId, url: `http://127.0.0.1:${started[peer]!.meshPort}/v1/mesh` }],
              ),
            },
          };
          void own(async () => {
            await fs.writeFile(
              path.join(directory!, `node-${index}.json`),
              canonicalBytes(replacement, 65_536),
              { mode: 0o600 },
            );
            completedReloadWrites += 1;
            assertActive();
            if (entry.child.exitCode === null && entry.child.signalCode === null) {
              // A successful native request is not signal delivery, reload
              // adoption or an IPC acknowledgement.
              if (entry.child.kill("SIGHUP")) requestedReloadSignals += 1;
            } else throw new Error("fixture-retired");
          }).catch(reject);
        }),
    );
    await Promise.all(reloads);
    assertActive();
    const resources = relayResources(),
      connection = connectNative(`ws://127.0.0.1:${started[0]!.port}/v1/relay`, resources);
    connections.add(connection);
    const leg = new RelayLeg(connection, resources, network.networkId, nodeIds[0]!);
    phase = "host-work";
    const paid = await work.acquire(
      {
        network,
        node: { ...network.nodes[0]!, url: `ws://127.0.0.1:${started[0]!.port}/v1/relay` },
        locator,
        capacityToken: capacity,
        admissionIdentity: admission!,
        allowLoopbackTest: true,
      },
      lifetime,
    );
    assertActive();
    phase = "register";
    const registered = await leg.register(locator, capacity, admission!, 0, paid.credential);
    assertActive();
    phase = "lookup-headers";
    const lookup = await own(async () => {
      const response = await fetch(`http://127.0.0.1:${started[2]!.port}/v1/lookup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: canonicalBytes({ networkId: network.networkId, locator }).slice(),
        signal: lifetime.signal,
      });
      assertActive();
      expect(response.ok).toBe(true);
      phase = "lookup-body";
      const bytes = await response.arrayBuffer();
      assertActive();
      return readCanonical(LookupResult, new Uint8Array(bytes));
    });
    assertActive();
    phase = "assertions";
    expect(lookup.candidates).toContainEqual({
      nodeId: nodeIds[0],
      registrationId: registered.registrationId,
      priority: 0,
    });
    for (const config of configs) expect(nativeLogs.join("")).not.toContain(config.privateIdentity);
    expect(nativeLogs.join("")).not.toContain(capacity);
    phase = "native-close";
    retire();
    await Promise.all([...closes.values()]);
    for (const child of children) {
      expect(child.exitCode).toBe(0);
      expect(child.signalCode).toBeNull();
    }
  },
);
