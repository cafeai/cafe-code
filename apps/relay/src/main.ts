// @effect-diagnostics nodeBuiltinImport:off
// Standalone native entrypoint. Signal handlers own only this process's server.
import { verifyNetwork } from "@cafecode/relay/descriptor";
import { deriveIdentityId, restoreIdentity } from "@cafecode/relay/crypto";
import { decodeUtf8, unopaqueBounded } from "@cafecode/relay/bytes";
import { canonicalBytes } from "@cafecode/relay/protocol";
import { epochNow } from "@cafecode/relay/lifetime";
import { requireRelay } from "@cafecode/relay/errors";
import { startRelayServer } from "./server.ts";
import { readNodeConfig, readPrivateFile, type RelayNodeConfig } from "./config.ts";
import { configureNetwork } from "./operator.ts";
import { createSecureContext } from "node:tls";

function admitMesh(config: RelayNodeConfig, localTest: boolean): void {
  const peerIds = new Set<string>();
  for (const peer of config.mesh.peers) {
    const url = new URL(peer.url);
    requireRelay(
      !peerIds.has(peer.nodeId) &&
        config.descriptor.nodes.some((node) => node.id === peer.nodeId) &&
        peer.nodeId !== config.nodeId,
    );
    requireRelay(
      url.protocol === "http:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/v1/mesh" &&
        (localTest ? url.hostname === "127.0.0.1" : /^10\.200\.0\.\d{1,3}$/.test(url.hostname)),
    );
    peerIds.add(peer.nodeId);
  }
  requireRelay(
    localTest
      ? config.listen.host === "127.0.0.1" && config.mesh.host === "127.0.0.1"
      : /^10\.200\.0\.\d{1,3}$/.test(config.mesh.host),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "configure") {
    requireRelay(args.length === 5 && args[1] === "--directory" && args[3] === "--spec");
    await configureNetwork(args[2]!, args[4]!);
    process.stdout.write("relay-configuration-written\n");
    return;
  }
  requireRelay(
    args.length >= 2 &&
      args[0] === "--config" &&
      args.slice(2).every((arg) => arg === "--check" || arg === "--local-test"),
  );
  const filename = args[1]!,
    config = await readNodeConfig(filename),
    localTest = args.includes("--local-test");
  const network = await verifyNetwork(canonicalBytes(config.descriptor), {
    rootPublicKey: config.rootPublicKey,
    now: epochNow(),
    ...(localTest ? { allowLoopbackTest: true } : {}),
  });
  const identity = restoreIdentity(unopaqueBounded(config.privateIdentity, 128));
  requireRelay(
    deriveIdentityId("node", identity.publicKey) === config.nodeId &&
      network.nodes.find((node) => node.id === config.nodeId)?.publicKey === identity.publicKey,
  );
  admitMesh(config, localTest);
  const tls = config.tls
    ? {
        key: decodeUtf8(await readPrivateFile(config.tls.key, 8192)),
        cert: decodeUtf8(await readPrivateFile(config.tls.certificate, 32768)),
      }
    : undefined;
  requireRelay(tls || localTest);
  if (tls) createSecureContext(tls);
  if (args.includes("--check")) {
    process.stdout.write("relay-configuration-valid\n");
    return;
  }
  const server = await startRelayServer({
    network,
    nodeId: config.nodeId,
    nodeIdentity: identity,
    grants: config.grants,
    host: config.listen.host,
    port: config.listen.port,
    ...(config.forwardedIpKeys ? { forwardedIpKeys: config.forwardedIpKeys } : {}),
    ...(config.hostWork ? { hostWork: config.hostWork } : {}),
    selfService: config.selfService === true,
    ...(tls ? { tls } : {}),
    meshListen: config.mesh,
    meshPeerUrls: new Map(config.mesh.peers.map((peer) => [peer.nodeId, peer.url])),
    ...(localTest ? { allowLoopbackTest: true } : {}),
  });
  let closing: Promise<void> | undefined;
  const retire = () => {
    closing ??= server.close().then(() => {
      process.stdout.write("relay-closed\n");
      if (localTest && process.connected) process.disconnect();
    });
    void closing.catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", retire);
  process.once("SIGINT", retire);
  process.once("disconnect", retire);
  let reloading = false;
  process.on("SIGHUP", () => {
    if (closing || reloading) return;
    reloading = true;
    void readNodeConfig(filename)
      .then(async (replacement) => {
        requireRelay(!closing);
        admitMesh(replacement, localTest);
        requireRelay(
          canonicalBytes(replacement.listen).toString() ===
            canonicalBytes(config.listen).toString() &&
            replacement.mesh.host === config.mesh.host &&
            replacement.mesh.port === config.mesh.port,
        );
        requireRelay(
          replacement.nodeId === config.nodeId &&
            replacement.selfService === config.selfService &&
            replacement.rootPublicKey === config.rootPublicKey &&
            replacement.privateIdentity === config.privateIdentity &&
            canonicalBytes(replacement.hostWork ?? null).toString() ===
              canonicalBytes(config.hostWork ?? null).toString() &&
            canonicalBytes(replacement.forwardedIpKeys ?? []).toString() ===
              canonicalBytes(config.forwardedIpKeys ?? []).toString() &&
            canonicalBytes(replacement.grants).toString() ===
              canonicalBytes(config.grants).toString(),
        );
        if (replacement.descriptor.revision > server.broker.network.revision)
          await server.updateNetwork(
            canonicalBytes(replacement.descriptor),
            new Map(replacement.mesh.peers.map((peer) => [peer.nodeId, peer.url])),
          );
        else
          requireRelay(
            canonicalBytes(replacement.descriptor).toString() ===
              canonicalBytes(server.broker.network).toString(),
          );
        if (replacement.tls) {
          const nextTls = {
            key: decodeUtf8(await readPrivateFile(replacement.tls.key, 8192)),
            cert: decodeUtf8(await readPrivateFile(replacement.tls.certificate, 32768)),
          };
          createSecureContext(nextTls);
          server.updateTls(nextTls);
        }
        process.stdout.write("relay-configuration-reloaded\n");
        if (localTest && process.send)
          process.send({ phase: "reloaded", revision: server.broker.network.revision });
      })
      .catch(() => process.stdout.write("relay-reload-refused\n"))
      .finally(() => {
        reloading = false;
      });
  });
  // Readiness includes the reload listener, so an owner acting on this
  // receipt cannot send SIGHUP before its native handler has been installed.
  process.stdout.write("relay-ready\n");
  if (localTest && process.send)
    process.send({ phase: "ready", port: server.port, meshPort: server.meshPort });
}
void main().catch(() => {
  process.stderr.write("relay-startup-refused\n");
  process.exitCode = 1;
});
