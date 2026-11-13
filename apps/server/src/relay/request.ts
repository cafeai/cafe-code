import * as Effect from "effect/Effect";
import * as Inspectable from "effect/Inspectable";
import * as Option from "effect/Option";
import * as Incoming from "effect/unstable/http/HttpIncomingMessage";
import * as Request from "effect/unstable/http/HttpServerRequest";
import * as Socket from "effect/unstable/socket/Socket";
import type { RelayStream } from "@cafecode/relay/session";
import { RelayError } from "@cafecode/relay/errors";
import { NdjsonGuard, RELAY_RPC_MESSAGE_BYTES } from "@cafecode/relay/ndjson";
import { Budget } from "@cafecode/relay/budget";
import { RelayRpcTransport, type RelayRpcProtocol } from "@cafecode/relay/rpc";

// Backend-wide retained-prefix lane, including closing channels. Complete
// small commands need no prefix reservation while another stream holds a
// large partial command; decoded app payloads keep their existing limits.
const rpcPrefixes = new Budget(RELAY_RPC_MESSAGE_BYTES * 2);

/** Public request interface; modify retains exact virtual-upgrade ownership. */
export class RelayServerRequest implements Request.HttpServerRequest {
  readonly [Request.TypeId]: typeof Request.TypeId = Request.TypeId;
  readonly [Incoming.TypeId]: typeof Incoming.TypeId = Incoming.TypeId;
  readonly base: Request.HttpServerRequest;
  readonly upgrade: Request.HttpServerRequest["upgrade"];
  constructor(base: Request.HttpServerRequest, upgrade?: Request.HttpServerRequest["upgrade"]) {
    this.base = base;
    this.upgrade = upgrade ?? base.upgrade;
  }
  get source() {
    return this.base.source;
  }
  get url() {
    return this.base.url;
  }
  get originalUrl() {
    return this.base.originalUrl;
  }
  get method() {
    return this.base.method;
  }
  get headers() {
    return this.base.headers;
  }
  readonly cookies = Object.freeze({});
  readonly remoteAddress = Option.none<string>();
  get json() {
    return this.base.json;
  }
  get text() {
    return this.base.text;
  }
  get urlParamsBody() {
    return this.base.urlParamsBody;
  }
  get arrayBuffer() {
    return this.base.arrayBuffer;
  }
  get stream() {
    return this.base.stream;
  }
  get multipart() {
    return this.base.multipart;
  }
  get multipartStream() {
    return this.base.multipartStream;
  }
  modify(options: Parameters<Request.HttpServerRequest["modify"]>[0]) {
    return new RelayServerRequest(this.base.modify(options), this.upgrade);
  }
  toJSON() {
    return { _id: "RelayServerRequest" };
  }
  toString() {
    return "RelayServerRequest";
  }
  [Inspectable.NodeInspectSymbol]() {
    return this.toJSON();
  }
}

/** NDJSON framing belongs to RPC; this socket carries bounded byte chunks. */
export function relayEffectSocket(stream: RelayStream, protocol: RelayRpcProtocol = "ndjson") {
  const guard = new NdjsonGuard(rpcPrefixes, RELAY_RPC_MESSAGE_BYTES);
  const transport = new RelayRpcTransport(stream, protocol);
  const readable = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const chunk = await transport.read();
          if (chunk) {
            guard.admit(chunk);
            controller.enqueue(chunk);
          } else {
            guard.finish();
            controller.close();
          }
        } catch {
          guard.close();
          transport.retire();
          controller.error(new RelayError("INCOMPLETE"));
        }
      },
      cancel() {
        guard.close();
        transport.retire();
      },
    },
    { highWaterMark: 0 },
  );
  const writable = new WritableStream<Uint8Array>({
    write: (bytes) => transport.write(bytes),
    close: () => transport.finish(),
    abort: () => transport.close(),
  });
  return Socket.fromTransformStream(
    Effect.acquireRelease(Effect.succeed({ readable, writable }), () =>
      Effect.promise(async () => {
        guard.close();
        await transport.close();
      }),
    ),
  );
}
