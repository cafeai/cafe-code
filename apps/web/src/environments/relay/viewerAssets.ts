import { readBoundedResponse } from "@cafecode/relay/discovery";
import { RelayError, requireRelay } from "@cafecode/relay/errors";
import { fetchRelayed } from "@cafecode/relay/http";
import type { Lifetime } from "@cafecode/relay/lifetime";
import type { RelaySession } from "@cafecode/relay/session";
import * as Schema from "effect/Schema";
import {
  RELAY_VIEWER_MAX_MANIFEST,
  RELAY_VIEWER_PATH,
  RELAY_VIEWER_PROBE_ACCEPT,
  RELAY_VIEWER_PROBE_PATH,
  readRelayViewerManifest,
  relayViewerAssetType,
} from "@cafecode/relay/viewerBundle";
import type { ActiveRelay, BrowserRelay } from "./active";
import { RelayWebSocket } from "./socket";

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const manifestPath = RELAY_VIEWER_PATH + "/manifest";
const readJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

async function advertisedBuild(session: RelaySession, signal: AbortSignal) {
  const response = await fetchRelayed(session, RELAY_VIEWER_PROBE_PATH, {
    headers: { accept: RELAY_VIEWER_PROBE_ACCEPT },
    signal,
  });
  const bytes = await readBoundedResponse(response, 8192);
  const data = readJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  // Older hosts return the ordinary environment descriptor to this request.
  const value =
    data && typeof data === "object" && "relayViewerBuildDigest" in data
      ? data.relayViewerBuildDigest
      : undefined;
  if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) return value;
  return undefined;
}

async function readManifest(response: Response) {
  if (response.status === 404) throw new RelayError("NOT_FOUND");
  return readBoundedResponse(response, RELAY_VIEWER_MAX_MANIFEST);
}

/** A reconnect can reach an upgraded process under the same host pin. Qualify
 * the exact new native session before it can carry any old renderer RPC. */
export async function pinViewerTransport(
  relay: Pick<ActiveRelay, "session" | "close" | "environmentId" | "httpBaseUrl" | "wsBaseUrl">,
  lifetime: Lifetime,
  startup: AbortSignal,
  changed: () => void,
) {
  const initial = await relay.session();
  const expected = await advertisedBuild(initial, startup);
  requireRelay(expected, "NOT_FOUND");
  const manifest = await readManifest(
    await fetchRelayed(initial, manifestPath, { signal: startup }),
  );
  requireRelay((await digest(manifest)) === expected);
  startup.throwIfAborted();
  let admitted: { session: RelaySession; check: Promise<void> } | undefined = {
    session: initial,
    check: Promise.resolve(),
  };
  const verify = async (session: RelaySession) => {
    const deadline = lifetime.deadline(30_000);
    try {
      const observed = await advertisedBuild(session, deadline.signal);
      requireRelay(
        lifetime.active && admitted?.session === session && session.active,
        "UNAVAILABLE",
      );
      if (observed !== expected) {
        changed();
        throw new RelayError("UNAVAILABLE");
      }
    } finally {
      deadline.cancel();
    }
  };
  const acquire = async () => {
    const session = await relay.session();
    requireRelay(lifetime.active && session.active, "UNAVAILABLE");
    if (admitted?.session !== session) admitted = { session, check: verify(session) };
    const owner = admitted;
    try {
      await owner.check;
    } catch (error) {
      if (admitted === owner) admitted = undefined;
      throw error;
    }
    requireRelay(lifetime.active && admitted === owner && session.active, "UNAVAILABLE");
    return session;
  };
  const transport: BrowserRelay = {
    environmentId: relay.environmentId,
    httpBaseUrl: relay.httpBaseUrl,
    wsBaseUrl: relay.wsBaseUrl,
    request: async (path, init) => fetchRelayed(await acquire(), path, init),
    socket: (url) => new RelayWebSocket(url, acquire),
    close: () => relay.close(),
  };
  return { transport, manifest };
}

export async function openViewerAssets(
  relay: BrowserRelay,
  signal: AbortSignal,
  pinnedManifest?: Uint8Array,
) {
  const manifest =
    pinnedManifest ?? (await readManifest(await relay.request(manifestPath, { signal })));
  const { files } = readRelayViewerManifest(manifest);
  const prefix = RELAY_VIEWER_PATH + "/asset/" + (await digest(manifest)) + "/";
  signal.throwIfAborted();
  return async (file: string, signal: AbortSignal) => {
    const entry = files.get(file);
    if (!entry) return undefined;
    const reply = await relay.request(prefix + file, { signal });
    requireRelay(
      reply.ok && reply.body && reply.headers.get("content-type") === "application/gzip",
    );
    const decoded = reply.body.pipeThrough(new DecompressionStream("gzip"));
    const bytes = await readBoundedResponse(new Response(decoded), entry.bytes);
    signal.throwIfAborted();
    requireRelay(bytes.byteLength === entry.bytes && (await digest(bytes)) === entry.sha256);
    signal.throwIfAborted();
    return { body: bytes.slice().buffer, contentType: relayViewerAssetType(file)! };
  };
}
