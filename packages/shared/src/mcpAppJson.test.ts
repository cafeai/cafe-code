import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_APP_MAX_MESSAGE_BYTES } from "@cafecode/contracts/mcpApps";
import {
  encodeBoundedMcpAppJson,
  MCP_APP_JSON_MAX_BYTES,
  readBoundedMcpAppJson,
  encodeBoundedMcpAppTransportJson,
  MCP_APP_JSON_MAX_TRANSPORT_BYTES,
  readBoundedMcpAppTransportJson,
} from "./mcpAppJson.ts";
import { encodeMcpAppReplay, McpAppProtocolSession } from "./mcpAppProtocol.ts";

const nested = (depth: number): unknown => {
  let result: unknown = 0;
  for (let index = 0; index < depth; index += 1) result = { value: result };
  return result;
};
afterEach(() => vi.restoreAllMocks());

describe("canonical bounded App JSON", () => {
  it("accounts JSON-string escaping only in the distinct private transport envelope", () => {
    const inner = encodeBoundedMcpAppJson({ result: '\\"'.repeat(25_000) });
    expect(inner).toBeDefined();
    const outer = encodeBoundedMcpAppTransportJson({ json: inner });
    expect(outer).toBeDefined();
    expect(new TextEncoder().encode(outer!).byteLength).toBeGreaterThan(MCP_APP_JSON_MAX_BYTES);
    expect(readBoundedMcpAppJson(outer).ok).toBe(false);
    const read = readBoundedMcpAppTransportJson(outer);
    expect(read).toEqual({ ok: true, value: { json: inner } });
    expect(readBoundedMcpAppJson(inner).ok).toBe(true);
    const excess = JSON.stringify({ json: "x".repeat(MCP_APP_JSON_MAX_TRANSPORT_BYTES) });
    const parse = vi.spyOn(JSON, "parse");
    expect(readBoundedMcpAppTransportJson(excess).ok).toBe(false);
    expect(parse).not.toHaveBeenCalled();
    expect(
      encodeBoundedMcpAppTransportJson({ json: "x".repeat(MCP_APP_JSON_MAX_TRANSPORT_BYTES) }),
    ).toBeUndefined();
    expect(readBoundedMcpAppTransportJson("{}", NaN).ok).toBe(false);
  });
  it("uses exact UTF-8 bytes rather than a conservative character multiplier", () => {
    expect(MCP_APP_JSON_MAX_BYTES).toBe(MCP_APP_MAX_MESSAGE_BYTES);
    const value = { text: "x".repeat(50_000) };
    expect(encodeBoundedMcpAppJson(value)).toBe(JSON.stringify(value));
    expect(readBoundedMcpAppJson(JSON.stringify(value)).ok).toBe(true);
    expect(encodeBoundedMcpAppJson({ text: "あ".repeat(50_000) })).toBeUndefined();
    expect(readBoundedMcpAppJson(JSON.stringify({ text: "あ".repeat(50_000) })).ok).toBe(false);
  });

  it("refuses excess lexical depth and token work before JSON parsing", () => {
    const parse = vi.spyOn(JSON, "parse");
    const dense = Object.fromEntries(
      Array.from({ length: 1366 }, (_, index) => [String(index), 0]),
    );
    for (const text of [
      JSON.stringify(nested(17)),
      JSON.stringify(dense),
      JSON.stringify(Array(2100).fill("x")),
    ]) {
      expect(readBoundedMcpAppJson(text).ok).toBe(false);
    }
    expect(parse).not.toHaveBeenCalled();
    expect(encodeBoundedMcpAppJson(dense)).toBeUndefined();
    expect(encodeBoundedMcpAppJson(nested(17))).toBeUndefined();
    expect(parse).not.toHaveBeenCalled();
  });

  it("admits the exact existing native lexical boundary", () => {
    const dense = Object.fromEntries(
      Array.from({ length: 1365 }, (_, index) => [String(index), 0]),
    );
    for (const value of [dense, nested(16), Array(2047).fill("x"), { text: '[{]}\\"' }]) {
      const encoded = encodeBoundedMcpAppJson(value);
      expect(encoded).toBe(JSON.stringify(value));
      expect(readBoundedMcpAppJson(encoded).ok).toBe(true);
    }
  });

  it("rejects invalid byte policies instead of allowing NaN to disable admission", () => {
    for (const maxBytes of [NaN, Infinity, 0, -1, 0.5, MCP_APP_JSON_MAX_BYTES + 1]) {
      expect(readBoundedMcpAppJson("{}", maxBytes).ok).toBe(false);
      expect(encodeBoundedMcpAppJson({}, maxBytes)).toBeUndefined();
    }
  });

  it("does not invoke accessors or serialization hooks, or accept cycles", () => {
    const accessor = vi.fn(() => "private");
    const value = Object.defineProperty({}, "private", { enumerable: true, get: accessor });
    expect(encodeBoundedMcpAppJson(value)).toBeUndefined();
    expect(accessor).not.toHaveBeenCalled();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(encodeBoundedMcpAppJson(cycle)).toBeUndefined();
    const toJSON = vi.fn(() => "private");
    expect(encodeBoundedMcpAppJson(Object.create({ toJSON }))).toBeUndefined();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("checks wrapped replay messages before admitting the App session", () => {
    const tooDeep = JSON.stringify(nested(16));
    expect(readBoundedMcpAppJson(tooDeep).ok).toBe(true);
    expect(encodeMcpAppReplay(tooDeep, "{}")).toBeUndefined();
    const session = new McpAppProtocolSession({}, tooDeep, "{}");
    const outcome = session.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "ui/initialize",
        params: { protocolVersion: "2026-01-26", appInfo: {}, appCapabilities: {} },
      }),
    );
    expect(outcome).toEqual({
      kind: "messages",
      messages: [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32000, message: "Operation unavailable" },
        }),
      ],
    });
    const accepted = encodeMcpAppReplay(JSON.stringify(nested(14)), "{}");
    expect(accepted).toBeDefined();
    for (const message of accepted!) expect(readBoundedMcpAppJson(message).ok).toBe(true);
  });
});
