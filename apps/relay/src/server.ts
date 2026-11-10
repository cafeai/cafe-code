// @effect-diagnostics nodeBuiltinImport:off
// This module owns native HTTP/TLS/WS descriptors. Error listeners precede
// asynchronous admission and remain installed after upgrade/finish/close.
import * as http from "node:http";
import * as https from "node:https";
import type { Socket } from "node:net";
import { WebSocketServer } from "ws";
import { AdmissionLimiter, Budget } from "@cafecode/relay";
import { RelayBroker, type HostCapacityGrant } from "@cafecode/relay/broker";
import { canonicalBytes, readCanonical } from "@cafecode/relay/protocol";
import { Lookup } from "@cafecode/relay/controls";
import { verifyNetwork, type NetworkDescriptor } from "@cafecode/relay/descriptor";
import type { RelayIdentity } from "@cafecode/relay/crypto";
import { RelayMesh } from "@cafecode/relay/mesh";
import { RelayError, requireRelay } from "@cafecode/relay/errors";
import { epochNow, Lifetime } from "@cafecode/relay/lifetime";
import { RELAY_LIMITS } from "@cafecode/relay/limits";
import { nativeDriver } from "@cafecode/relay/nativeWire";
import { PacketConnection, relayResources } from "@cafecode/relay/wire";
import { PeerAttribution, peerPrefix } from "./peer.ts";

export { peerPrefix } from "./peer.ts";

export interface RelayServerOptions {
  readonly network: NetworkDescriptor;
  readonly nodeId: string;
  readonly grants: readonly HostCapacityGrant[];
  readonly host: string;
  readonly port: number;
  readonly tls?: { readonly key: string; readonly cert: string };
  readonly allowLoopbackTest?: boolean;
  readonly nodeIdentity?: RelayIdentity;
  readonly meshListen?: { readonly host: string; readonly port: number };
  readonly meshPeerUrls?: ReadonlyMap<string, string>;
  readonly manualMeshSync?: boolean;
  readonly forwardedIpKeys?: readonly string[];
}

export async function startRelayServer(options: RelayServerOptions) {
  requireRelay(
    options.tls || (options.allowLoopbackTest && ["127.0.0.1", "::1"].includes(options.host)),
  );
  const resources = relayResources(),
    lifetime = new Lifetime();
  const admission = new AdmissionLimiter(epochNow(), "native"),
    requests = new AdmissionLimiter(epochNow(), "native");
  const anonymous = new AdmissionLimiter(epochNow());
  const pending = new Budget(RELAY_LIMITS.pendingTls);
  const peers = new PeerAttribution(options.forwardedIpKeys);
  const sockets = new Set<Socket>();
  const requestsHeld = new Set<Promise<void>>();
  const broker = new RelayBroker({
    network: options.network,
    nodeId: options.nodeId,
    grants: options.grants,
    resources,
  });
  const mesh = options.nodeIdentity
    ? new RelayMesh({
        network: options.network,
        nodeId: options.nodeId,
        bootId: broker.bootId,
        identity: options.nodeIdentity,
        directory: broker.directory,
        snapshot: () => broker.snapshot(),
        ...(options.meshPeerUrls ? { peerUrls: options.meshPeerUrls } : {}),
        ...(options.allowLoopbackTest ? { allowLoopbackTest: true } : {}),
      })
    : undefined;
  const serverOptions: http.ServerOptions = {
    maxHeaderSize: RELAY_LIMITS.metadataBytes,
    requestTimeout: RELAY_LIMITS.handshakeMs,
    headersTimeout: RELAY_LIMITS.handshakeMs,
    keepAliveTimeout: 5_000,
    connectionsCheckingInterval: 1_000,
  };
  const server = options.tls
    ? https.createServer({
        ...serverOptions,
        ...options.tls,
        handshakeTimeout: RELAY_LIMITS.handshakeMs,
      })
    : http.createServer(serverOptions);
  const meshServer = options.meshListen ? http.createServer(serverOptions) : undefined;
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: RELAY_LIMITS.outerBytes,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has("cafe-relay.v1") ? "cafe-relay.v1" : false),
  });
  // Server-level errors have fixed categories; raw OS/TLS errors are never logged.
  server.on("error", () => {});
  meshServer?.on("error", () => {});
  webSockets.on("error", () => {});
  server.maxConnections = RELAY_LIMITS.owners;
  const acceptSocket = (socket: Socket) => {
    socket.on("error", () => socket.destroy());
    try {
      const owner = resources.owners.reserve(),
        pendingOwner = pending.reserve();
      if (
        !owner ||
        !pendingOwner ||
        !admission.admit(peerPrefix(socket.remoteAddress), epochNow())
      ) {
        owner?.();
        pendingOwner?.();
        socket.destroy();
        return;
      }
      sockets.add(socket);
      // Deliberately conservative pilot limit: at most eight accepted native
      // connections, including TLS handshakes. No hidden unbounded TLS queue.
      socket.once("close", () => {
        sockets.delete(socket);
        owner();
        pendingOwner();
      });
    } catch {
      socket.destroy();
    }
  };
  server.on("connection", acceptSocket);
  meshServer?.on("connection", acceptSocket);
  const respond = (response: http.ServerResponse, status: number, value: unknown) => {
    if (response.destroyed) return;
    const bytes = canonicalBytes(value, RELAY_LIMITS.descriptorBytes);
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": bytes.byteLength,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      connection: "close",
    });
    response.end(bytes);
  };
  const handleRequest =
    (meshOnly: boolean) => (request: http.IncomingMessage, response: http.ServerResponse) => {
      request.on("error", () => request.destroy());
      response.on("error", () => response.destroy());
      const controller = new AbortController();
      const retire = () => controller.abort();
      request.once("aborted", retire);
      response.once("close", retire);
      const cancel = lifetime.later(RELAY_LIMITS.handshakeMs, () => {
        retire();
        request.destroy();
        response.destroy();
      });
      response.once("close", cancel);
      const task = (async () => {
        try {
          const isMesh =
            request.method === "POST" &&
            request.url === "/v1/mesh" &&
            mesh &&
            (meshOnly || !meshServer);
          requireRelay(
            lifetime.active &&
              (isMesh ||
                requests.admit(
                  peers.prefix(request.headers, request.socket.remoteAddress),
                  epochNow(),
                )),
            "BUSY",
          );
          requireRelay(
            !request.headers["content-encoding"] &&
              !request.headers["authorization"] &&
              !request.headers.cookie,
          );
          requireRelay(!meshOnly || isMesh, "NOT_FOUND");
          if (request.method === "OPTIONS" && request.url === "/v1/lookup") {
            response.writeHead(204, {
              "access-control-allow-origin": "*",
              "access-control-allow-methods": "POST",
              "access-control-allow-headers": "content-type",
              "cache-control": "no-store",
            });
            response.end();
            return;
          }
          if (request.method === "GET" && request.url === "/v1/network") {
            respond(response, 200, broker.network);
            return;
          }
          if (request.method === "GET" && request.url === "/v1/latency") {
            respond(response, 200, { version: 1 });
            return;
          }
          if (request.method === "GET" && request.url === "/healthz") {
            respond(response, 200, { version: 1, ready: lifetime.active });
            return;
          }
          requireRelay(
            isMesh || (request.method === "POST" && request.url === "/v1/lookup"),
            "NOT_FOUND",
          );
          const chunks: Uint8Array[] = [];
          let length = 0;
          for await (const chunk of request) {
            requireRelay(!controller.signal.aborted && chunk instanceof Uint8Array);
            length += chunk.byteLength;
            requireRelay(length <= (isMesh ? RELAY_LIMITS.controlBytes : RELAY_LIMITS.lookupBytes));
            chunks.push(chunk);
          }
          const body = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
          }
          if (isMesh) {
            const answer = await mesh.answer(body);
            requireRelay(!controller.signal.aborted && lifetime.active, "UNAVAILABLE");
            response.writeHead(200, {
              "content-type": "application/json",
              "content-length": answer.byteLength,
              "cache-control": "no-store",
              connection: "close",
            });
            response.end(answer);
            return;
          }
          const lookup = readCanonical(Lookup, body, RELAY_LIMITS.lookupBytes);
          requireRelay(lookup.networkId === options.network.networkId, "NETWORK_MISMATCH");
          requireRelay(!controller.signal.aborted && lifetime.active, "UNAVAILABLE");
          let result = broker.directory.lookup(lookup.locator, epochNow());
          if (!result.candidates.length && mesh) {
            await mesh.refresh();
            result = broker.directory.lookup(lookup.locator, epochNow());
          }
          requireRelay(!controller.signal.aborted && lifetime.active, "UNAVAILABLE");
          respond(response, 200, result);
        } catch (error) {
          if (controller.signal.aborted) return;
          const code = error instanceof RelayError ? error.code : "PROTOCOL_ERROR";
          respond(response, code === "BUSY" ? 429 : code === "NOT_FOUND" ? 404 : 400, { code });
        } finally {
          cancel();
        }
      })();
      requestsHeld.add(task);
      void task.then(
        () => requestsHeld.delete(task),
        () => {
          requestsHeld.delete(task);
          response.destroy();
        },
      );
    };
  server.on("request", handleRequest(false));
  meshServer?.on("request", handleRequest(true));
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    try {
      requireRelay(lifetime.active && request.method === "GET" && request.url === "/v1/relay");
      requireRelay(
        anonymous.admit(peers.prefix(request.headers, request.socket.remoteAddress), epochNow()),
        "BUSY",
      );
      requireRelay(request.headers["sec-websocket-protocol"] === "cafe-relay.v1");
      // Browsers always offer compression. The no-compression server declines
      // that offer; rejecting the header would reject ordinary browser clients.
      requireRelay(
        !request.headers.authorization &&
          !request.headers.cookie &&
          head.byteLength <= RELAY_LIMITS.outerBytes,
      );
      webSockets.handleUpgrade(request, socket, head, (socket) => {
        // The TCP listener already owns this exact socket until native close.
        const connection = new PacketConnection(nativeDriver(socket), resources, () => {});
        broker.accept(connection);
      });
    } catch {
      socket.destroy();
    }
  });
  let retired = false;
  const close = async () => {
    if (!retired) {
      retired = true;
      lifetime.retire();
      broker.retire();
      mesh?.retire();
      for (const socket of sockets) socket.destroy();
      webSockets.close();
    }
    await broker.close();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (meshServer?.listening)
      await new Promise<void>((resolve) => meshServer.close(() => resolve()));
    await mesh?.close();
    await Promise.allSettled([...requestsHeld]);
    await lifetime.close();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const error = () => {
        server.off("listening", listening);
        reject(new RelayError("UNAVAILABLE"));
      };
      const listening = () => {
        server.off("error", error);
        resolve();
      };
      server.once("error", error);
      server.once("listening", listening);
      server.listen(options.port, options.host);
    });
    const address = server.address();
    requireRelay(address && typeof address !== "string");
    if (meshServer && options.meshListen)
      await new Promise<void>((resolve, reject) => {
        meshServer.once("error", () => reject(new RelayError("UNAVAILABLE")));
        meshServer.listen(options.meshListen!.port, options.meshListen!.host, () => resolve());
      });
    if (mesh && !options.manualMeshSync) mesh.start();
    const updateNetwork = async (bytes: Uint8Array, peerUrls?: ReadonlyMap<string, string>) => {
      const network = await verifyNetwork(bytes, {
        rootPublicKey: broker.network.rootPublicKey,
        now: epochNow(),
        minimumRevision: broker.network.revision + 1,
        ...(options.allowLoopbackTest ? { allowLoopbackTest: true } : {}),
      });
      requireRelay(lifetime.active, "UNAVAILABLE");
      broker.updateNetwork(network);
      mesh?.update(network, peerUrls);
    };
    const updateTls = (tls: { readonly key: string; readonly cert: string }) => {
      requireRelay(lifetime.active && server instanceof https.Server);
      server.setSecureContext(tls);
    };
    const meshAddress = meshServer?.address();
    return {
      port: address.port,
      meshPort: meshAddress && typeof meshAddress !== "string" ? meshAddress.port : undefined,
      broker,
      mesh,
      updateNetwork,
      updateTls,
      resources,
      close,
      stats: () => ({
        ...broker.stats(),
        owners: resources.owners.current,
        pendingBytes: resources.pending.current,
        nativeSockets: sockets.size,
      }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
