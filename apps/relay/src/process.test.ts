// @effect-diagnostics nodeBuiltinImport:off
// These fixtures own exactly the returned Node children, IPC channels and files.
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
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
import { relayResources, type PacketConnection } from "@cafecode/relay/wire";
import type { RelayNodeConfig } from "./config.ts";

it.skipIf(process.platform === "win32")(
  "runs three separate service processes, reloads membership, discovers a remote registration and reaps every child",
  async (test) => {
    let retired = false,
      directory: string | undefined;
    const lifetime = new Lifetime(),
      children = new Set<ChildProcess>(),
      closes = new Map<ChildProcess, Promise<void>>(),
      connections = new Set<PacketConnection>();
    const nativeLogs: string[] = [];
    const retire = () => {
      if (retired) return;
      retired = true;
      for (const connection of connections) connection.retire();
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    };
    // The public test signal owns retirement before filesystem/key/native IO.
    test.signal.addEventListener("abort", retire, { once: true });
    test.onTestFinished(async () => {
      retire();
      let forced = false;
      const cancel = lifetime.later(2_000, () => {
        for (const child of children)
          if (child.exitCode === null && child.signalCode === null) {
            forced = true;
            child.kill("SIGKILL");
          }
      });
      await Promise.allSettled([...connections].map((connection) => connection.close()));
      await Promise.all([...closes.values()]);
      cancel();
      await lifetime.close();
      if (directory) await fs.rm(directory, { recursive: true, force: true });
      expect(forced).toBe(false);
    });
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "cafe-relay-process-"));
    if (retired) throw new Error("fixture-retired");
    const [root, nodeA, nodeB, nodeC, admission] = await Promise.all(
      Array.from({ length: 5 }, () => createIdentity()),
    );
    const identities = [nodeA!, nodeB!, nodeC!],
      nodeIds = identities.map((node) => deriveIdentityId("node", node.publicKey));
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
      if (retired) throw new Error("fixture-retired");
      const filename = path.join(directory, `node-${index}.json`);
      await fs.writeFile(filename, canonicalBytes(configs[index], 65_536), {
        flag: "wx",
        mode: 0o600,
      });
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
      const closed = Promise.withResolvers<void>();
      closes.set(child, closed.promise);
      child.once("close", () => closed.resolve());
      let outputBytes = 0;
      const output = (chunk: Uint8Array) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > 4096) {
          retire();
          return;
        }
        nativeLogs.push(new TextDecoder().decode(chunk));
      };
      child.stdout!.on("data", output);
      child.stderr!.on("data", output);
      const ready = Promise.withResolvers<{ port: number; meshPort: number }>();
      child.on("error", () => {
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
      started.push({ child, ...(await ready.promise) });
    }
    const updated = await signNetwork({
      root: root!,
      revision: 2,
      expiresAt: epochNow() + 3_600_000,
      nodes: network.nodes.map((node, index) => ({
        ...node,
        url: `ws://127.0.0.1:${started[index]!.port}/v1/relay`,
      })),
    });
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
          void fs
            .writeFile(
              path.join(directory!, `node-${index}.json`),
              canonicalBytes(replacement, 65_536),
              { mode: 0o600 },
            )
            .then(() => {
              if (!retired && entry.child.exitCode === null && entry.child.signalCode === null)
                entry.child.kill("SIGHUP");
              else reject(new Error("fixture-retired"));
            }, reject);
        }),
    );
    await Promise.all(reloads);
    const resources = relayResources(),
      connection = connectNative(`ws://127.0.0.1:${started[0]!.port}/v1/relay`, resources);
    connections.add(connection);
    const leg = new RelayLeg(connection, resources, network.networkId, nodeIds[0]!);
    const registered = await leg.register(locator, capacity, admission!);
    const response = await fetch(`http://127.0.0.1:${started[2]!.port}/v1/lookup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: canonicalBytes({ networkId: network.networkId, locator }).slice(),
    });
    expect(response.ok).toBe(true);
    const lookup = readCanonical(LookupResult, new Uint8Array(await response.arrayBuffer()));
    expect(lookup.candidates).toContainEqual({
      nodeId: nodeIds[0],
      registrationId: registered.registrationId,
      priority: 0,
    });
    for (const config of configs) expect(nativeLogs.join("")).not.toContain(config.privateIdentity);
    expect(nativeLogs.join("")).not.toContain(capacity);
    retire();
    await Promise.all([...closes.values()]);
    for (const child of children) {
      expect(child.exitCode).toBe(0);
      expect(child.signalCode).toBeNull();
    }
  },
);
