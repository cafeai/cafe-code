import {
  generateKeyPair,
  generateKeyPairFromSeed,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
  publicKeyFromRaw,
} from "@libp2p/crypto/keys";
import type {
  ComponentLogger,
  Ed25519PrivateKey,
  Logger,
  MessageStream,
  PeerId,
  Upgrader,
} from "@libp2p/interface";
import { UnexpectedPeerError } from "@libp2p/interface";
import { noise, pureJsCrypto } from "@libp2p/noise";
import { peerIdFromPrivateKey, peerIdFromPublicKey } from "@libp2p/peer-id";
import { concatenate, opaque, unopaque, utf8 } from "./bytes.ts";
import { RelayError, requireRelay } from "./errors.ts";
import { RELAY_LIMITS } from "./limits.ts";

export interface RelayIdentity {
  readonly key: Ed25519PrivateKey;
  readonly peer: PeerId;
  readonly publicKey: string;
}

/**
 * Both Noise components and the raw MessageStream must use this exact logger.
 * noise@17.0.7 prefers connection.log, and its debug path can print cipher keys.
 * A frozen closed logger cannot be enabled by DEBUG or browser localStorage.
 */
function quietLogger(): Logger {
  const log: Logger = Object.assign(() => {}, {
    enabled: false,
    error: () => {},
    trace: () => {},
    newScope: (_name: string): Logger => log,
  });
  return Object.freeze(log);
}
export const NOISE_LOGGER = quietLogger();
const componentLogger: ComponentLogger = Object.freeze({ forComponent: () => NOISE_LOGGER });

/**
 * This is a capability-denying Upgrader, not a pretend libp2p transport. Cafe
 * invokes the public ConnectionEncrypter directly with mux negotiation disabled.
 * Every general libp2p connection-upgrade operation is deliberately refused.
 * If a dependency update starts using one, it fails closed instead of silently
 * enabling an extra listener, dialer, encryption negotiation or stream muxer.
 *
 * Public contracts reviewed at js-libp2p d41cc9f.../interface/src/transport.ts
 * and connection-encrypter-noise/src/noise.ts. No private API/type cast is used.
 */
export const RELAY_UPGRADER: Upgrader = Object.freeze({
  upgradeInbound: () => Promise.reject(new RelayError("PROTOCOL_ERROR")),
  upgradeOutbound: () => Promise.reject(new RelayError("PROTOCOL_ERROR")),
  createInboundAbortSignal: () => {
    throw new RelayError("PROTOCOL_ERROR");
  },
  getStreamMuxers: () => new Map(),
  getConnectionEncrypters: () => new Map(),
});

function identity(key: Ed25519PrivateKey): RelayIdentity {
  return { key, peer: peerIdFromPrivateKey(key), publicKey: opaque(key.publicKey.raw) };
}

export async function createIdentity(): Promise<RelayIdentity> {
  return identity(await generateKeyPair("Ed25519"));
}
export async function identityFromSeed(seed: Uint8Array): Promise<RelayIdentity> {
  requireRelay(seed.byteLength === 32);
  return identity(await generateKeyPairFromSeed("Ed25519", seed));
}

export function restoreIdentity(bytes: Uint8Array): RelayIdentity {
  requireRelay(bytes.byteLength <= 128);
  try {
    const key = privateKeyFromProtobuf(bytes);
    requireRelay(key.type === "Ed25519");
    return identity(key);
  } catch {
    throw new RelayError("CRYPTO_FAILURE");
  }
}

export function privateIdentityBytes(value: RelayIdentity): Uint8Array {
  return privateKeyToProtobuf(value.key);
}

export function peerForKey(publicKey: string): PeerId {
  try {
    const key = publicKeyFromRaw(unopaque(publicKey, 32));
    requireRelay(key.type === "Ed25519");
    return peerIdFromPublicKey(key);
  } catch {
    throw new RelayError("HOST_IDENTITY_MISMATCH");
  }
}

export function sha256(bytes: Uint8Array): Uint8Array {
  return pureJsCrypto.hashSHA256(bytes);
}

export function deriveIdentityId(kind: "network" | "node", publicKey: string): string {
  return opaque(
    sha256(concatenate(utf8.encode("CafeCode/relay/" + kind + "/v1\0"), unopaque(publicKey, 32))),
  );
}

export async function signBytes(value: RelayIdentity, bytes: Uint8Array): Promise<string> {
  return opaque(await value.key.sign(bytes));
}

export async function verifyBytes(
  publicKey: string,
  bytes: Uint8Array,
  signature: string,
): Promise<boolean> {
  try {
    return await publicKeyFromRaw(unopaque(publicKey, 32)).verify(bytes, unopaque(signature, 64));
  } catch {
    return false;
  }
}

export interface ChannelContext {
  readonly networkId: string;
  readonly locator: string;
  readonly registrationId: string;
  readonly viewerCircuitNonce: string;
}

export function channelPrologue(context: ChannelContext): Uint8Array {
  return concatenate(
    utf8.encode("CafeCode/relay/e2e/v1\0"),
    new Uint8Array([0, 1]),
    unopaque(context.networkId, 32),
    unopaque(context.locator, 32),
    unopaque(context.registrationId, 16),
    unopaque(context.viewerCircuitNonce, 16),
  );
}

export async function secureChannel(input: {
  readonly identity: RelayIdentity;
  readonly stream: MessageStream;
  readonly context: ChannelContext;
  readonly direction: "viewer" | "host";
  readonly expectedHostKey?: string;
  readonly signal: AbortSignal;
}): Promise<{ readonly stream: MessageStream; readonly remotePublicKey: string }> {
  requireRelay(input.stream.log === NOISE_LOGGER);
  requireRelay(
    input.direction !== "viewer" || input.expectedHostKey !== undefined,
    "HOST_IDENTITY_MISMATCH",
  );
  const encrypter = noise({
    crypto: pureJsCrypto,
    prologueBytes: channelPrologue(input.context),
  })({
    privateKey: input.identity.key,
    peerId: input.identity.peer,
    logger: componentLogger,
    upgrader: RELAY_UPGRADER,
  });
  try {
    const options = {
      skipStreamMuxerNegotiation: true,
      signal: input.signal,
      ...(input.expectedHostKey ? { remotePeer: peerForKey(input.expectedHostKey) } : {}),
    };
    const secured =
      input.direction === "viewer"
        ? await encrypter.secureOutbound(input.stream, options)
        : await encrypter.secureInbound(input.stream, options);
    const key = secured.remotePeer.publicKey;
    requireRelay(key?.type === "Ed25519", "CRYPTO_FAILURE");
    const remotePublicKey = opaque(key.raw);
    requireRelay(
      input.direction !== "viewer" || remotePublicKey === input.expectedHostKey,
      "HOST_IDENTITY_MISMATCH",
    );
    // These public limits override the library's default plaintext read/write
    // buffers. The outer adapter also limits encrypted records before decoding.
    secured.connection.maxReadBufferLength = RELAY_LIMITS.channelWindowBytes;
    secured.connection.maxWriteBufferLength = RELAY_LIMITS.channelWindowBytes;
    return { stream: secured.connection, remotePublicKey };
  } catch (error) {
    // Capture the category before retirement: resetting this stream may abort
    // its owner signal and must not disguise a proven peer mismatch as an outage.
    const code = input.signal.aborted
      ? "UNAVAILABLE"
      : error instanceof UnexpectedPeerError
        ? "HOST_IDENTITY_MISMATCH"
        : "CRYPTO_FAILURE";
    input.stream.abort(new RelayError(code));
    throw new RelayError(code);
  }
}
