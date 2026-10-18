import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 1024 * 1024;
let inFlight = 0;
let executions = 0;
let controls = 0;
const discardedError = () => {};

/** Independent Glide transport allowance: a 128 KiB JS string can expand six
 * times under JSON escaping. Never enlarge the unrelated App message parser. */
function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((yes, no) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", data);
      request.off("end", end);
      request.off("aborted", fail);
      request.off("error", fail);
      request.once("error", discardedError);
      chunks.length = 0;
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      request.pause();
      cleanup();
      no(new Error("Invalid Glide request."));
    };
    const data = (chunk: Buffer) => {
      if (
        !Buffer.isBuffer(chunk) ||
        size + chunk.length > MAX_BODY_BYTES ||
        chunks.length >= 2048
      ) {
        fail();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    };
    const end = () => {
      if (settled) return;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
        // Bound structure independently of byte count before JSON.parse. All
        // free-form program source lives inside one JSON string.
        let depth = 0,
          quoted = false,
          escaped = false;
        for (const char of text) {
          if (quoted) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') quoted = false;
          } else if (char === '"') quoted = true;
          else if (char === "{" || char === "[") {
            if (++depth > 16) throw new Error();
          } else if (char === "}" || char === "]") depth--;
        }
        const value: unknown = JSON.parse(text);
        settled = true;
        cleanup();
        yes(value);
      } catch {
        fail();
      }
    };
    const timer = setTimeout(fail, 10_000);
    request.on("data", data);
    request.once("end", end);
    request.once("aborted", fail);
    request.once("error", fail);
    if (request.destroyed || request.readableEnded) fail();
  });
}

export async function runPrivateGlideRequest(
  request: IncomingMessage,
  response: ServerResponse,
  execute: (body: unknown, signal: AbortSignal) => Promise<unknown>,
) {
  const deny = (status: number) => {
    if (response.headersSent || response.destroyed) {
      response.destroy();
      return;
    }
    response.shouldKeepAlive = false;
    response.once("finish", () => request.destroy());
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"Glide session is unavailable."}');
  };
  if (inFlight >= 8) {
    request.pause();
    request.once("error", discardedError);
    deny(503);
    return;
  }
  inFlight++;
  let admitted: "execution" | "control" | undefined;
  const controller = new AbortController();
  const closed = () => {
    if (!response.writableFinished) controller.abort();
  };
  response.once("close", closed);
  try {
    const body = await readBody(request);
    const isExecution =
      typeof body === "object" && body !== null && "kind" in body && body.kind === "execute";
    if ((isExecution ? executions : controls) >= 4) {
      deny(503);
      return;
    }
    if (isExecution) {
      executions++;
      admitted = "execution";
    } else {
      controls++;
      admitted = "control";
    }
    const value = await execute(body, controller.signal);
    if (controller.signal.aborted) throw new Error();
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > 12 * 1024 * 1024) throw new Error();
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(json);
  } catch {
    deny(403);
  } finally {
    // Hold the lane through native drain/finish rather than releasing on end().
    await new Promise<void>((yes) => {
      if (response.writableFinished || response.destroyed) {
        yes();
        return;
      }
      const complete = () => {
        clearTimeout(timer);
        response.off("finish", complete);
        response.off("close", complete);
        response.off("error", retire);
        response.once("error", discardedError);
        yes();
      };
      const retire = () => {
        response.destroy();
        complete();
      };
      const timer = setTimeout(retire, 10_000);
      response.once("finish", complete);
      response.once("close", complete);
      response.once("error", retire);
    });
    response.off("close", closed);
    if (admitted === "execution") executions--;
    else if (admitted === "control") controls--;
    inFlight--;
  }
}
