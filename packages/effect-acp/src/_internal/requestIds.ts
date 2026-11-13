import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import type * as RpcMessage from "effect/unstable/rpc/RpcMessage";

type Message = RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Effect's JSON-RPC codec requires numeric internal IDs. ACP peers may use
 * strings (Axiom uses UUIDs), so keep their wire identity private to this codec.
 * Callback requests/replies preserve their IDs, and outgoing notifications omit
 * Effect's empty ID. Streamed updates and outgoing prompts keep the normal path.
 */
export function makeAcpRequestIdParser(maxPendingRequests: number) {
  const parser = RpcSerialization.ndJsonRpc().makeUnsafe();
  const inbound = new Map<string, { wireId: string | number; key: string }>();
  const wireIds = new Set<string>();
  let nextAlias = -1;

  const admit = (value: unknown) => {
    if (
      !isRecord(value) ||
      typeof value.method !== "string" ||
      value.id === undefined ||
      value.id === null
    )
      return value;
    const wireId = value.id;
    if (
      (typeof wireId === "string" && wireId.length > 1024) ||
      (typeof wireId !== "string" && !(typeof wireId === "number" && Number.isFinite(wireId)))
    )
      throw new Error("Invalid ACP request ID.");
    const key = JSON.stringify([typeof wireId, wireId]);
    if (wireIds.has(key)) throw new Error("Duplicate pending ACP request ID.");
    if (inbound.size >= maxPendingRequests)
      throw new Error("Too many pending ACP callback requests.");
    let internalId =
      typeof wireId === "number" && Number.isSafeInteger(wireId) ? String(wireId) : undefined;
    if (internalId === undefined || inbound.has(internalId)) {
      while (inbound.has(String(nextAlias))) nextAlias--;
      if (!Number.isSafeInteger(nextAlias)) throw new Error("ACP request ID space exhausted.");
      internalId = String(nextAlias--);
    }
    inbound.set(internalId, { wireId, key });
    wireIds.add(key);
    return { ...value, id: Number(internalId) };
  };

  return {
    decode(line: string) {
      // Normalize before Effect registers a batch's response correlation.
      if (line.trimStart().startsWith("[")) {
        const batch = JSON.parse(line) as unknown[];
        return parser.decode(`${JSON.stringify(batch.map(admit))}\n`) as ReadonlyArray<Message>;
      }
      const messages = parser.decode(line) as ReadonlyArray<Message>;
      const request = messages[0];
      if (request?._tag !== "Request" || request.id === "") return messages;
      const admitted = admit(JSON.parse(line));
      if (!isRecord(admitted)) throw new Error("Invalid ACP request.");
      return [{ ...request, id: String(admitted.id) }];
    },
    encode(message: Message) {
      const encoded = parser.encode(message);
      if (encoded && message._tag === "Request" && message.id === "") {
        // JSON-RPC notifications omit the id entirely. An empty string is a
        // request ID to native ACP peers, so session/cancel would be ignored.
        const notification = JSON.parse(
          typeof encoded === "string" ? encoded : new TextDecoder().decode(encoded),
        ) as Record<string, unknown>;
        delete notification.id;
        return `${JSON.stringify(notification)}\n`;
      }
      if (!encoded || (message._tag !== "Exit" && message._tag !== "Chunk")) return encoded;
      const completed: string[] = [];
      const restore = (value: unknown) => {
        if (!isRecord(value) || typeof value.method === "string") return value;
        const internalId = String(value.id);
        const request = inbound.get(internalId);
        if (!request) return value;
        if (value.chunk !== true) completed.push(internalId);
        return { ...value, id: request.wireId };
      };
      const text = typeof encoded === "string" ? encoded : new TextDecoder().decode(encoded);
      // The framing codec emits batched responses as multiple JSONL records.
      const result =
        text
          .trimEnd()
          .split("\n")
          .map((line) => {
            const wire = JSON.parse(line) as unknown;
            return JSON.stringify(Array.isArray(wire) ? wire.map(restore) : restore(wire));
          })
          .join("\n") + "\n";
      for (const id of completed) {
        const request = inbound.get(id)!;
        inbound.delete(id);
        wireIds.delete(request.key);
      }
      return result;
    },
  };
}
