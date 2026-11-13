import { RELAY_RPC_MESSAGE_BYTES } from "@cafecode/relay/ndjson";
import { RelayError } from "@cafecode/relay/errors";
import { RelayRpcTransport, relayRpcHeaders, readRelayRpcProtocol } from "@cafecode/relay/rpc";
import type { RelaySession, RelayStream } from "@cafecode/relay/session";

/** DOM-compatible byte-stream socket used only by this target's NDJSON RPC. */
export class RelayWebSocket extends EventTarget implements WebSocket {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly url: string;
  readonly extensions = "";
  readonly protocol = "cafe-relay.ndjson";
  binaryType: BinaryType = "arraybuffer";
  bufferedAmount = 0;
  readyState: number = this.CONNECTING;
  onopen: ((this: WebSocket, event: Event) => unknown) | null = null;
  onerror: ((this: WebSocket, event: Event) => unknown) | null = null;
  onclose: ((this: WebSocket, event: CloseEvent) => unknown) | null = null;
  onmessage: ((this: WebSocket, event: MessageEvent) => unknown) | null = null;
  private stream: RelayStream | undefined;
  private transport: RelayRpcTransport | undefined;
  private readonly pending: Uint8Array[] = [];
  private sending = false;

  constructor(url: string, acquire: () => Promise<RelaySession>) {
    super();
    this.url = url;
    this.addEventListener("open", (event) => this.onopen?.call(this, event));
    this.addEventListener("error", (event) => this.onerror?.call(this, event));
    this.addEventListener("close", (event) => this.onclose?.call(this, event));
    this.addEventListener("message", (event) => this.onmessage?.call(this, event));
    void acquire()
      .then(async (session) => {
        if (this.readyState !== this.CONNECTING) return;
        const parsed = new URL(url);
        const headers = relayRpcHeaders();
        const stream = await session.open("rpc", {
          method: "GET",
          path: "/ws" + parsed.search,
          headers,
        });
        if (this.readyState !== this.CONNECTING) {
          stream.retire();
          return;
        }
        this.stream = stream;
        const protocol = readRelayRpcProtocol(await stream.metadata, headers);
        if (this.readyState !== this.CONNECTING) {
          stream.retire();
          return;
        }
        const transport = new RelayRpcTransport(stream, protocol);
        this.transport = transport;
        this.readyState = this.OPEN;
        this.dispatchEvent(new Event("open"));
        const decoder = new TextDecoder("utf-8", { fatal: true });
        for (;;) {
          const chunk = await transport.read();
          if (this.readyState !== this.OPEN) return;
          if (!chunk) {
            decoder.decode();
            this.finish(1000);
            return;
          }
          const text = decoder.decode(chunk, { stream: true });
          if (text) this.dispatchEvent(new MessageEvent("message", { data: text }));
        }
      })
      .catch(() => {
        if (this.readyState === this.CLOSED) return;
        this.dispatchEvent(new Event("error"));
        this.finish(1006);
      });
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== this.OPEN) throw new RelayError("UNAVAILABLE");
    let bytes: Uint8Array;
    if (typeof data === "string") {
      if (data.length > RELAY_RPC_MESSAGE_BYTES) throw new RelayError("BUSY");
      // Check unusually large strings before encoding can overallocate. Small
      // strings are bounded by at most three UTF-8 bytes per code unit.
      if (data.length > RELAY_RPC_MESSAGE_BYTES / 3) {
        let length = 0;
        for (const character of data) {
          const point = character.codePointAt(0)!;
          length += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
          if (length > RELAY_RPC_MESSAGE_BYTES) throw new RelayError("BUSY");
        }
      }
      bytes = new TextEncoder().encode(data);
    } else if (ArrayBuffer.isView(data))
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else throw new RelayError("PROTOCOL_ERROR");
    if (
      bytes.byteLength > RELAY_RPC_MESSAGE_BYTES ||
      bytes.byteLength + this.bufferedAmount > RELAY_RPC_MESSAGE_BYTES + 65_536 ||
      this.pending.length >= 64
    )
      throw new RelayError("BUSY");
    this.bufferedAmount += bytes.byteLength;
    this.pending.push(typeof data === "string" ? bytes : bytes.slice());
    void this.flush();
  }
  private async flush(): Promise<void> {
    if (this.sending || !this.transport || this.readyState !== this.OPEN) return;
    this.sending = true;
    try {
      while (this.pending.length && this.readyState === this.OPEN) {
        const bytes = this.pending.shift()!;
        await this.transport.write(bytes);
        this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes.byteLength);
      }
    } catch {
      if (!this.isClosed()) {
        this.dispatchEvent(new Event("error"));
        this.finish(1006);
      }
    } finally {
      this.sending = false;
    }
  }
  close(_code?: number, _reason?: string): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSING;
    this.finish(1000);
  }
  private isClosed(): boolean {
    return this.readyState === this.CLOSED;
  }
  private finish(code: number): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.stream?.retire();
    void this.transport?.close();
    this.pending.length = 0;
    this.bufferedAmount = 0;
    this.dispatchEvent(new CloseEvent("close", { code, wasClean: code === 1000 }));
  }
  override addEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (this: WebSocket, event: WebSocketEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener, options);
  }
  override removeEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (this: WebSocket, event: WebSocketEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void;
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    super.removeEventListener(type, listener, options);
  }
}
