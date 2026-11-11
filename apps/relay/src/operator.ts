// @effect-diagnostics nodeBuiltinImport:off
// Explicit operator CLI. Root and admission keys are written only to private
// files; stdout contains a fixed completion category, never credential material.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as Schema from "effect/Schema";
import {
  createIdentity,
  deriveIdentityId,
  privateIdentityBytes,
  restoreIdentity,
  sha256,
  type RelayIdentity,
} from "@cafecode/relay/crypto";
import { opaque, randomOpaque, unopaque } from "@cafecode/relay/bytes";
import { relayEndpoint, signNetwork, NetworkDescriptor } from "@cafecode/relay/descriptor";
import { requireRelay } from "@cafecode/relay/errors";
import { epochNow } from "@cafecode/relay/lifetime";
import { canonicalBytes, readCanonical } from "@cafecode/relay/protocol";
import { readPrivateFile, readNodeConfig, RelayNodeConfig } from "./config.ts";

const Spec = Schema.Struct({
  version: Schema.Literal(1),
  viewerOrigin: Schema.String.check(Schema.isMaxLength(256)),
  nodes: Schema.Array(
    Schema.Struct({
      publicUrl: Schema.String.check(Schema.isMaxLength(256)),
      wireGuardAddress: Schema.String.check(Schema.isPattern(/^10\.200\.0\.\d{1,3}$/)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
});
async function exists(filename: string): Promise<boolean> {
  try {
    await fs.lstat(filename);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}
async function key(directory: string, filename: string): Promise<RelayIdentity> {
  const target = path.join(directory, filename);
  if (await exists(target)) return restoreIdentity(await readPrivateFile(target, 128));
  const identity = await createIdentity();
  await fs.writeFile(target, privateIdentityBytes(identity), { flag: "wx", mode: 0o600 });
  return identity;
}
async function replace(directory: string, filename: string, value: unknown): Promise<void> {
  const temporary = path.join(directory, "." + randomOpaque(16) + ".tmp"),
    target = path.join(directory, filename);
  const bytes = canonicalBytes(value, 65_536);
  try {
    const file = await fs.open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(temporary, target);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

/** Re-run a private recipe to add nodes/renew the descriptor; existing keys stay fixed. */
export async function configureNetwork(directory: string, specFile: string): Promise<void> {
  requireRelay(path.isAbsolute(directory));
  if (!(await exists(directory))) await fs.mkdir(directory, { mode: 0o700 });
  const stat = await fs.lstat(directory, { bigint: true });
  requireRelay(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === BigInt(process.getuid!()) &&
      (stat.mode & 0o777n) === 0o700n &&
      (await fs.realpath(directory)) === directory,
  );
  const lockPath = path.join(directory, "configure.lock"),
    lock = await fs.open(lockPath, "wx", 0o600),
    lockIdentity = await lock.stat({ bigint: true });
  try {
    const spec = readCanonical(Spec, await readPrivateFile(specFile, 8192));
    const origin = new URL(spec.viewerOrigin);
    requireRelay(origin.protocol === "https:" && origin.origin === spec.viewerOrigin);
    const oldNetworkPath = path.join(directory, "network.json"),
      hadNetwork = await exists(oldNetworkPath);
    if (hadNetwork) requireRelay(await exists(path.join(directory, "operator-root.key")));
    const root = await key(directory, "operator-root.key");
    let revision = 1;
    let previous: NetworkDescriptor | undefined;
    const previousConfigs: RelayNodeConfig[] = [];
    if (hadNetwork) {
      previous = readCanonical(NetworkDescriptor, await readPrivateFile(oldNetworkPath, 8192));
      requireRelay(
        previous.rootPublicKey === root.publicKey &&
          spec.nodes.length >= previous.nodes.length &&
          previous.nodes.every((node, index) => node.url === spec.nodes[index]!.publicUrl),
      );
      requireRelay(await exists(path.join(directory, "host-enrollment.json")));
      for (let index = 0; index < previous.nodes.length; index++) {
        requireRelay(await exists(path.join(directory, "node-" + index + ".key")));
        requireRelay(await exists(path.join(directory, "host-admission-" + index + ".key")));
        const saved = await readNodeConfig(path.join(directory, "node-" + index + ".json"));
        previousConfigs.push(saved);
        requireRelay(
          saved.nodeId === previous.nodes[index]!.id &&
            saved.mesh.host === spec.nodes[index]!.wireGuardAddress,
        );
      }
      revision = previous.revision + 1;
    }
    const identities: RelayIdentity[] = [];
    for (let index = 0; index < spec.nodes.length; index++) {
      relayEndpoint(spec.nodes[index]!.publicUrl);
      identities.push(await key(directory, "node-" + index + ".key"));
    }
    const nodes = identities.map((identity, index) => ({
      id: deriveIdentityId("node", identity.publicKey),
      publicKey: identity.publicKey,
      url: spec.nodes[index]!.publicUrl,
    }));
    requireRelay(
      !previous ||
        previous.nodes.every((node, index) => node.publicKey === nodes[index]!.publicKey),
    );
    requireRelay(
      new Set(nodes.map((node) => node.url)).size === nodes.length &&
        new Set(spec.nodes.map((node) => node.wireGuardAddress)).size === nodes.length,
    );
    const network: NetworkDescriptor = await signNetwork({
      root,
      nodes,
      revision,
      expiresAt: epochNow() + 30 * 86_400_000,
    });
    const hostPath = path.join(directory, "host-enrollment.json");
    const Enrollment = Schema.Struct({
      locator: Schema.String,
      tokens: Schema.Array(Schema.String),
    });
    const prior = (await exists(hostPath))
      ? readCanonical(Enrollment, await readPrivateFile(hostPath, 8192))
      : { locator: randomOpaque(), tokens: [] };
    const locator = prior.locator,
      tokens = [...prior.tokens];
    unopaque(locator, 32);
    const credentials = [];
    for (let index = 0; index < nodes.length; index++) {
      const admission = await key(directory, "host-admission-" + index + ".key"),
        token = tokens[index] ?? randomOpaque();
      tokens[index] = token;
      credentials.push({
        nodeId: nodes[index]!.id,
        token,
        admissionPrivateKey: opaque(privateIdentityBytes(admission)),
      });
      const forwardedIpKeys = previousConfigs[index]?.forwardedIpKeys;
      const hostWork = previousConfigs[index]?.hostWork;
      const selfService = previousConfigs[index]?.selfService;
      const config: RelayNodeConfig = {
        version: 1,
        rootPublicKey: root.publicKey,
        descriptor: network,
        nodeId: nodes[index]!.id,
        privateIdentity: opaque(privateIdentityBytes(identities[index]!)),
        ...(forwardedIpKeys ? { forwardedIpKeys } : {}),
        ...(hostWork ? { hostWork } : {}),
        ...(selfService !== undefined ? { selfService } : {}),
        grants: [
          {
            locator,
            admissionPublicKey: admission.publicKey,
            tokenDigest: opaque(sha256(unopaque(token, 32))),
          },
        ],
        listen: { host: "::", port: 8443 },
        tls: {
          key: "/etc/cafecode-relay-test/tls.key",
          certificate: "/etc/cafecode-relay-test/tls.crt",
        },
        mesh: {
          host: spec.nodes[index]!.wireGuardAddress,
          port: 9443,
          peers: nodes.flatMap((node, peerIndex) =>
            index === peerIndex
              ? []
              : [
                  {
                    nodeId: node.id,
                    url: "http://" + spec.nodes[peerIndex]!.wireGuardAddress + ":9443/v1/mesh",
                  },
                ],
          ),
        },
      };
      await replace(directory, "node-" + index + ".json", config);
    }
    await replace(directory, "host-enrollment.json", { locator, tokens });
    await replace(directory, "host-config.json", {
      version: 1,
      networks: [{ descriptor: network, viewerOrigin: spec.viewerOrigin, locator, credentials }],
    });
    await replace(directory, "network.json", network);
  } finally {
    await lock.close();
    const current = await fs.lstat(lockPath, { bigint: true });
    if (
      current.dev === lockIdentity.dev &&
      current.ino === lockIdentity.ino &&
      current.nlink === 1n
    )
      await fs.unlink(lockPath);
  }
}
