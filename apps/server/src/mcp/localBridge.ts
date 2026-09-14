import type { Readable, Writable } from "node:stream";
import { readMcpFile } from "./privateFiles.ts";

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_IN_FLIGHT = 4;

type RequestId = string | number;
type RpcMessage = { jsonrpc: "2.0"; id?: RequestId; method: string; params?: unknown };

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function readBridgeConnection(
  connectionPath: string,
  target: "cafe-code" | "cafe-desktop" = "cafe-code",
): Promise<{ url: string; token: string }> {
  const raw = await readMcpFile(connectionPath, { private: true, maxBytes: 16 * 1024 });
  const connection = object(JSON.parse(raw ?? "null"));
  if (
    typeof connection?.url !== "string" ||
    typeof connection.token !== "string" ||
    connection.token.length < 32
  ) {
    throw new Error("Cafe Code is unavailable. Open the desktop app and reinstall MCP.");
  }
  const url = new URL(connection.url);
  // This bridge is a local capability, never an arbitrary HTTP proxy. Redirects
  // are also rejected by fetch so credentials cannot leave the loopback target.
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== (target === "cafe-desktop" ? "/mcp/desktop" : "/mcp") ||
    (target === "cafe-desktop" && connection.audience !== "cafe-desktop") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.port ||
    Number(url.port) === 0
  ) {
    throw new Error("Invalid Cafe MCP connection.");
  }
  return { url: url.href, token: connection.token };
}

async function readResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MESSAGE_BYTES) throw new Error("Cafe MCP response is too large.");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * A bounded stdio-to-stateless-HTTP relay, not a second MCP implementation.
 * Cafe's SDK server handles initialize, discovery, tool results (including
 * images), and protocol validation. Requests are never replayed: a lost
 * response does not prove that a mutating tool failed to run.
 */
export async function runLocalBridge(options: {
  readonly connectionPath: string;
  readonly target?: "cafe-code" | "cafe-desktop";
  readonly input: Readable;
  readonly output: Writable;
  readonly fetch?: typeof fetch;
}): Promise<void> {
  const fetchRequest = options.fetch ?? fetch;
  const pending = new Map<RequestId, AbortController>();
  const controllers = new Set<AbortController>();
  const tasks = new Set<Promise<void>>();
  let protocolVersion = "2025-03-26";
  let writes = Promise.resolve();
  const send = (message: unknown) => {
    writes = writes.then(
      () =>
        new Promise<void>((resolve, reject) => {
          options.output.write(`${JSON.stringify(message)}\n`, (error) =>
            error ? reject(error) : resolve(),
          );
        }),
    );
    return writes;
  };
  const fail = (id: RequestId | null, message: string) =>
    send({ jsonrpc: "2.0", id, error: { code: -32000, message } });

  const forward = async (message: RpcMessage, controller: AbortController): Promise<void> => {
    let requestStarted = false;
    try {
      const connection = await readBridgeConnection(options.connectionPath, options.target);
      requestStarted = true;
      const response = await fetchRequest(connection.url, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${connection.token}`,
          "MCP-Protocol-Version": protocolVersion,
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (message.id !== undefined)
          await fail(
            message.id,
            response.status === 403
              ? "Cafe Code MCP is off or this connection is not authorized."
              : "Cafe Code MCP is unavailable. Check Settings → MCP in the desktop app.",
          );
        return;
      }
      const text = await readResponse(response);
      if (message.id === undefined) return;
      const result = object(JSON.parse(text));
      if (result?.jsonrpc !== "2.0" || result.id !== message.id) throw new Error();
      const negotiated = object(result.result)?.protocolVersion;
      if (message.method === "initialize" && typeof negotiated === "string")
        protocolVersion = negotiated;
      await send(result);
    } catch {
      if (message.id !== undefined)
        await fail(
          message.id,
          controller.signal.aborted
            ? "Cafe MCP request was cancelled; already-started work may still finish."
            : requestStarted && message.method === "tools/call"
              ? "The Cafe MCP connection was lost. The tool may have completed; check its result before repeating the action."
              : "Cafe Code MCP is unavailable. Open the desktop app and check Settings → MCP.",
        );
    } finally {
      controllers.delete(controller);
      if (message.id !== undefined) pending.delete(message.id);
    }
  };

  // Geometric growth keeps fragmented input linear in its size. Repeatedly
  // concatenating the entire partial line makes large tool arguments quadratic.
  const initialBufferSize = 8192;
  let buffer = Buffer.alloc(initialBufferSize);
  let used = 0;
  const onOutputError = () => {
    for (const controller of controllers) controller.abort();
    options.input.destroy();
  };
  options.output.on("error", onOutputError);
  try {
    for await (const rawChunk of options.input) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline;
        const required = used + end - offset;
        if (required > MAX_MESSAGE_BYTES) throw new Error("Cafe MCP input is too large.");
        if (required > buffer.length) {
          const grown = Buffer.alloc(
            Math.min(MAX_MESSAGE_BYTES, Math.max(required, buffer.length * 2)),
          );
          buffer.copy(grown, 0, 0, used);
          buffer = grown;
        }
        chunk.copy(buffer, used, offset, end);
        used = required;
        offset = end + 1;
        if (newline === -1) break;
        const line = buffer.subarray(0, used).toString("utf8");
        used = 0;
        if (buffer.length > initialBufferSize) buffer = Buffer.alloc(initialBufferSize);
        if (!line.trim()) continue;
        let value: Record<string, unknown> | undefined;
        try {
          value = object(JSON.parse(line));
        } catch {
          /* Only a fixed protocol error is emitted. */
        }
        if (
          value?.jsonrpc !== "2.0" ||
          typeof value.method !== "string" ||
          (value.id !== undefined && typeof value.id !== "string" && typeof value.id !== "number")
        ) {
          await fail(null, "Invalid MCP request.");
          continue;
        }
        const message = value as RpcMessage;
        if (message.method === "notifications/cancelled") {
          const requestId = object(message.params)?.requestId;
          if (typeof requestId === "string" || typeof requestId === "number")
            pending.get(requestId)?.abort();
          continue;
        }
        if (tasks.size >= MAX_IN_FLIGHT || (message.id !== undefined && pending.has(message.id))) {
          if (message.id !== undefined)
            await fail(message.id, "Cafe MCP is busy. Wait for the pending requests.");
          continue;
        }
        const controller = new AbortController();
        controllers.add(controller);
        if (message.id !== undefined) pending.set(message.id, controller);
        const task = forward(message, controller);
        tasks.add(task);
        void task.finally(() => tasks.delete(task)).catch(() => undefined);
      }
    }
  } finally {
    // EOF means the owning provider has gone away, not a detached handoff.
    // Close all outstanding HTTP requests instead of keeping an orphan alive.
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(tasks);
    try {
      await writes;
    } finally {
      options.output.off("error", onOutputError);
    }
  }
}
