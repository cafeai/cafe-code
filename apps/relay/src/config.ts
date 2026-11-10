// @effect-diagnostics nodeBuiltinImport:off
// The standalone service reads one bounded private operator configuration.
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as Schema from "effect/Schema";
import { NetworkDescriptor } from "@cafecode/relay/descriptor";
import { Id32, readCanonical, SafeCounter } from "@cafecode/relay/protocol";
import { RelayError, requireRelay } from "@cafecode/relay/errors";
import { unopaque } from "@cafecode/relay/bytes";
import { HOST_WORK } from "@cafecode/relay/hostWork";
const Port = SafeCounter.check(Schema.isLessThanOrEqualTo(65_535));
const Address = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
const FilePath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
export const RelayNodeConfig = Schema.Struct({
  version: Schema.Literal(1),
  rootPublicKey: Id32,
  descriptor: NetworkDescriptor,
  nodeId: Id32,
  privateIdentity: Schema.String.check(Schema.isMaxLength(172)),
  forwardedIpKeys: Schema.optionalKey(
    Schema.Array(Id32).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
  ),
  hostWork: Schema.optionalKey(
    Schema.Struct({
      difficulty: SafeCounter.check(
        Schema.isGreaterThanOrEqualTo(HOST_WORK.minimumDifficulty),
        Schema.isLessThanOrEqualTo(HOST_WORK.maximumDifficulty),
      ),
      reservationMs: SafeCounter.check(
        Schema.isGreaterThanOrEqualTo(120_000),
        Schema.isLessThanOrEqualTo(600_000),
      ),
    }),
  ),
  grants: Schema.Array(
    Schema.Struct({ locator: Id32, admissionPublicKey: Id32, tokenDigest: Id32 }),
  ).check(Schema.isMaxLength(32)),
  listen: Schema.Struct({ host: Address, port: Port }),
  tls: Schema.optionalKey(Schema.Struct({ key: FilePath, certificate: FilePath })),
  mesh: Schema.Struct({
    host: Address,
    port: Port,
    peers: Schema.Array(
      Schema.Struct({ nodeId: Id32, url: Schema.String.check(Schema.isMaxLength(256)) }),
    ).check(Schema.isMaxLength(15)),
  }),
});
export type RelayNodeConfig = typeof RelayNodeConfig.Type;

export async function readPrivateFile(filename: string, maximum: number): Promise<Uint8Array> {
  let file: fs.FileHandle | undefined;
  try {
    requireRelay(typeof process.getuid === "function" && typeof process.getgid === "function");
    file = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat({ bigint: true });
    const owned = stat.uid === BigInt(process.getuid());
    const rootReadOnly =
      stat.uid === 0n && stat.gid === BigInt(process.getgid()) && (stat.mode & 0o027n) === 0n;
    requireRelay(
      stat.isFile() &&
        stat.nlink === 1n &&
        (owned || rootReadOnly) &&
        (stat.mode & 0o007n) === 0n &&
        (owned ? (stat.mode & 0o077n) === 0n : true) &&
        stat.size > 0n &&
        stat.size <= BigInt(maximum),
    );
    const bytes = new Uint8Array(Number(stat.size));
    let used = 0;
    while (used < bytes.byteLength) {
      const chunk = await file.read(bytes, used, bytes.byteLength - used, used);
      requireRelay(chunk.bytesRead > 0);
      used += chunk.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    requireRelay(
      after.nlink === 1n &&
        after.size === stat.size &&
        after.mtimeNs === stat.mtimeNs &&
        after.ctimeNs === stat.ctimeNs,
    );
    return bytes;
  } catch {
    throw new RelayError("UNAVAILABLE");
  } finally {
    await file?.close();
  }
}
export async function readNodeConfig(filename: string): Promise<RelayNodeConfig> {
  const config = readCanonical(RelayNodeConfig, await readPrivateFile(filename, 65_536), 65_536);
  for (const key of config.forwardedIpKeys ?? []) unopaque(key, 32);
  return config;
}
