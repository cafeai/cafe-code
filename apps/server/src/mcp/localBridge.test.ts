import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readBridgeConnection, runLocalBridge } from "./localBridge.ts";
import { writeMcpFile } from "./privateFiles.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cafe-mcp-bridge-test-")));
  roots.push(root);
  const connectionPath = path.join(root, "connection.json");
  const connection = JSON.stringify({
    url: "http://127.0.0.1:12345/mcp",
    token: "test-private-token-".repeat(4),
  });
  await writeMcpFile(connectionPath, connection, undefined);
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: Array<Record<string, unknown>> = [];
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split("\n")) replies.push(JSON.parse(line));
  });
  const send = (id: number, method = "tools/list") =>
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method })}\n`);
  return { connectionPath, connection, input, output, replies, send };
}

describe("local MCP bridge", () => {
  it("keeps desktop and Cafe management targets and credential audiences separate", async () => {
    const f = await fixture();
    await expect(readBridgeConnection(f.connectionPath, "cafe-desktop")).rejects.toThrow();
    await fs.writeFile(
      f.connectionPath,
      JSON.stringify({
        audience: "cafe-desktop",
        url: "http://127.0.0.1:12345/mcp/desktop",
        token: "a".repeat(64),
      }),
    );
    await expect(readBridgeConnection(f.connectionPath, "cafe-desktop")).resolves.toHaveProperty(
      "token",
    );
    await expect(readBridgeConnection(f.connectionPath, "cafe-code")).rejects.toThrow();
    await fs.writeFile(
      f.connectionPath,
      JSON.stringify({ url: "http://127.0.0.1:12345/mcp/desktop", token: "a".repeat(64) }),
    );
    await expect(readBridgeConnection(f.connectionPath, "cafe-desktop")).rejects.toThrow();
  });
  it("rejects oversized lines before sending an HTTP request", async () => {
    const f = await fixture();
    const request = vi.fn<typeof fetch>();
    const running = runLocalBridge({ ...f, fetch: request });
    const rejected = expect(running).rejects.toThrow("too large");
    f.input.write(Buffer.alloc(16 * 1024 * 1024 + 1, 120));
    await rejected;
    expect(request).not.toHaveBeenCalled();
  });

  it("parses fragmented UTF-8 and multiple lines without dropping a request", async () => {
    const f = await fixture();
    const requests: Array<{ id: number; method: string }> = [];
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const value = JSON.parse(String(init?.body));
      requests.push({ id: value.id, method: value.method });
      return Response.json({ jsonrpc: "2.0", id: value.id, result: {} });
    });
    const running = runLocalBridge({ ...f, fetch: request });
    try {
      const lines = Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/日本語" }) +
          "\n" +
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) +
          "\n",
      );
      for (const byte of lines) f.input.write(Buffer.from([byte]));
      await vi.waitFor(() => expect(f.replies).toHaveLength(2));
      // Forwarding reads the current credential asynchronously for each RPC,
      // so concurrent requests may reach HTTP in either order. Preserve the
      // exact decoded payload/id pairing without requiring arrival order.
      expect(requests.toSorted((a, b) => a.id - b.id)).toEqual([
        { id: 1, method: "tools/日本語" },
        { id: 2, method: "tools/list" },
      ]);
      expect(f.replies.map((reply) => reply.id).toSorted()).toEqual([1, 2]);
    } finally {
      f.input.end();
      await running;
    }
  });
  it("forwards native image results and rereads the address and credential for each call", async () => {
    const f = await fixture();
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const request = vi.fn<typeof fetch>(async (url, init) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      expect(init?.redirect).toBe("error");
      const { id } = JSON.parse(String(init?.body));
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "image", mimeType: "image/png", data: "fixture-image" }] },
      });
    });
    const running = runLocalBridge({ ...f, fetch: request });
    try {
      f.send(1, "tools/call");
      await vi.waitFor(() => expect(f.replies).toHaveLength(1));
      const next = { url: "http://127.0.0.1:54321/mcp", token: "rotated-private-token-".repeat(4) };
      await writeMcpFile(f.connectionPath, JSON.stringify(next), f.connection);
      f.send(2, "tools/call");
      await vi.waitFor(() => expect(f.replies).toHaveLength(2));
      expect(requests[1]).toEqual({ url: next.url, authorization: `Bearer ${next.token}` });
      expect(f.replies[1]?.result).toEqual({
        content: [{ type: "image", mimeType: "image/png", data: "fixture-image" }],
      });
    } finally {
      f.input.end();
      await running;
    }
  });

  it("does not retry mutations or expose HTTP/file failure details", async () => {
    const f = await fixture();
    const request = vi.fn<typeof fetch>(async () => {
      throw new Error("Authorization: secret /private/path");
    });
    const running = runLocalBridge({ ...f, fetch: request });
    try {
      f.send(1, "tools/call");
      await vi.waitFor(() => expect(f.replies).toHaveLength(1));
      expect(request).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(f.replies)).not.toContain("secret");
      expect(JSON.stringify(f.replies)).not.toContain("/private/path");
    } finally {
      f.input.end();
      await running;
    }
  });

  it("cancels a request without blocking the input reader and aborts notifications at EOF", async () => {
    const f = await fixture();
    const signals: AbortSignal[] = [];
    const request = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init!.signal!;
          signals.push(signal);
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const running = runLocalBridge({ ...f, fetch: request });
    f.send(1);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    f.input.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })}\n`,
    );
    await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
    f.input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    f.input.end();
    await running;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("rejects non-loopback targets and public credential permissions", async () => {
    const f = await fixture();
    for (const url of [
      "https://example.com/mcp",
      "http://localhost:1234/mcp",
      "http://127.0.0.1:1234/mcp?token=secret",
      "http://127.0.0.1:1234/other",
    ]) {
      await fs.writeFile(f.connectionPath, JSON.stringify({ url, token: "x".repeat(48) }));
      await expect(readBridgeConnection(f.connectionPath)).rejects.toThrow();
    }
    await fs.writeFile(f.connectionPath, f.connection);
    if (process.platform !== "win32") {
      await fs.chmod(f.connectionPath, 0o644);
      await expect(readBridgeConnection(f.connectionPath)).rejects.toThrow("permissions");
    }
  });
});
