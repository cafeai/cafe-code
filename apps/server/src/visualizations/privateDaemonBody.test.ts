import { EventEmitter } from "node:events";
// Synthetic emitters implement the exact native HTTP response event contract.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import type * as http from "node:http";
import { MCP_APP_JSON_MAX_TRANSPORT_BYTES } from "@cafecode/shared/mcpAppJson";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRIVATE_VISUALIZATION_DAEMON_BODY_MS,
  PRIVATE_VISUALIZATION_DAEMON_MAX_CHUNKS,
  PRIVATE_VISUALIZATION_DAEMON_RESPONSE_MS,
  privateVisualizationDaemonRequestCount,
  readPrivateVisualizationDaemonBody,
  runPrivateVisualizationDaemonRequest,
} from "./privateDaemonBody.ts";

function fixture() {
  const events = new EventEmitter();
  const pause = vi.fn();
  const request = Object.assign(events, {
    pause,
    complete: false,
    destroyed: false,
    readableEnded: false,
  }) as unknown as http.IncomingMessage;
  return { events, pause, request };
}
function responseFixture() {
  const events = new EventEmitter();
  const destroy = vi.fn(() => {
    response.destroyed = true;
    events.emit("close");
    return response;
  });
  const response = Object.assign(events, {
    destroy,
    writableFinished: false,
    destroyed: false,
    headersSent: false,
  }) as unknown as http.ServerResponse;
  return { events, destroy, response };
}
afterEach(() => vi.useRealTimers());

describe("private visualization daemon body admission", () => {
  it("preserves fragmented UTF-8 and parses only after the finite transport is complete", async () => {
    const { request, events } = fixture();
    const work = readPrivateVisualizationDaemonBody(request, 1024);
    const bytes = Buffer.from('{"source":"private 🌸"}', "utf8");
    for (const byte of bytes) events.emit("data", Buffer.from([byte]));
    events.emit("end");
    expect(await work).toEqual({ source: "private 🌸" });
    expect(events.listenerCount("data")).toBe(0);
    expect(events.listenerCount("end")).toBe(0);
  });
  it("refuses actual bytes before assembly, removes the reader and discards private error causes", async () => {
    const { request, events, pause } = fixture();
    const work = readPrivateVisualizationDaemonBody(request, 1024);
    const refused = expect(work).rejects.toThrow("Invalid private visualization request body.");
    events.emit("data", Buffer.alloc(1025, 120));
    await refused;
    expect(pause).toHaveBeenCalledOnce();
    expect(events.listenerCount("data")).toBe(0);
    expect(() => events.emit("error", new Error("PRIVATE ERROR SOURCE"))).not.toThrow();
  });
  it("bounds zero-byte chunks independently from bytes", async () => {
    const { request, events } = fixture();
    const work = readPrivateVisualizationDaemonBody(request, 1024);
    const refused = expect(work).rejects.toThrow("Invalid private visualization request body.");
    for (let index = 0; index <= PRIVATE_VISUALIZATION_DAEMON_MAX_CHUNKS; index++)
      events.emit("data", Buffer.alloc(0));
    await refused;
    expect(events.listenerCount("data")).toBe(0);
  });
  it("counts the escaped outer transport independently from bounded native JSON", async () => {
    const requestJson = JSON.stringify({ text: '"'.repeat(50_000) });
    const input = { requestJson };
    const bytes = Buffer.from(JSON.stringify(input), "utf8");
    expect(Buffer.byteLength(requestJson, "utf8")).toBeLessThan(128 * 1024);
    expect(bytes.byteLength).toBeGreaterThan(128 * 1024);
    const { request, events } = fixture();
    const work = readPrivateVisualizationDaemonBody(request, MCP_APP_JSON_MAX_TRANSPORT_BYTES);
    events.emit("data", bytes);
    events.emit("end");
    expect(await work).toEqual(input);
    const oversized = fixture();
    const refused = expect(
      readPrivateVisualizationDaemonBody(oversized.request, MCP_APP_JSON_MAX_TRANSPORT_BYTES),
    ).rejects.toThrow("Invalid private visualization request body.");
    oversized.events.emit("data", Buffer.alloc(MCP_APP_JSON_MAX_TRANSPORT_BYTES + 1));
    await refused;
    expect(oversized.events.listenerCount("data")).toBe(0);
  });
  it.each([
    Buffer.from([0xff]),
    Buffer.from('{"source":"private-marker"'),
    Buffer.from("[".repeat(25) + "0" + "]".repeat(25)),
    Buffer.from("[" + "0,".repeat(4097) + "0]"),
  ])("refuses malformed UTF-8/JSON and lexical work without private details", async (bytes) => {
    const { request, events } = fixture();
    const work = readPrivateVisualizationDaemonBody(request, 128 * 1024);
    const refused = expect(work).rejects.toThrow("Invalid private visualization request body.");
    events.emit("data", bytes);
    events.emit("end");
    await refused;
  });
  it("retains a fixed nonrenewable deadline despite incoming activity", async () => {
    vi.useFakeTimers();
    const { request, events, pause } = fixture();
    const work = readPrivateVisualizationDaemonBody(request, 1024);
    const refused = expect(work).rejects.toThrow("Invalid private visualization request body.");
    await vi.advanceTimersByTimeAsync(PRIVATE_VISUALIZATION_DAEMON_BODY_MS - 1);
    events.emit("data", Buffer.from("{"));
    await vi.advanceTimersByTimeAsync(1);
    await refused;
    expect(pause).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("releases its deadline/listeners on cancellation before the subsequent native error", async () => {
    vi.useFakeTimers();
    const { request, events } = fixture();
    const work = readPrivateVisualizationDaemonBody(request, 1024);
    const refused = expect(work).rejects.toThrow("Invalid private visualization request body.");
    events.emit("aborted");
    expect(() => events.emit("error", new Error("PRIVATE CANCELLED STREAM"))).not.toThrow();
    await refused;
    expect(vi.getTimerCount()).toBe(0);
    expect(events.listenerCount("data")).toBe(0);
  });
  it("holds the shared allowance through response completion and refuses a fifth body without queuing", async () => {
    const admitted = Array.from({ length: 4 }, () => {
      const incoming = fixture();
      const outgoing = responseFixture();
      const execute = vi.fn(async () => {});
      const deny = vi.fn();
      const work = runPrivateVisualizationDaemonRequest(
        incoming.request,
        outgoing.response,
        1024,
        execute,
        deny,
      );
      incoming.events.emit("data", Buffer.from("{}"));
      incoming.events.emit("end");
      return { ...incoming, ...outgoing, execute, deny, work };
    });
    try {
      await vi.waitFor(() =>
        expect(admitted.every((entry) => entry.execute.mock.calls.length === 1)).toBe(true),
      );
      expect(privateVisualizationDaemonRequestCount()).toBe(4);
      const fifth = fixture();
      const response = responseFixture();
      const execute = vi.fn(async () => {});
      const deny = vi.fn();
      await runPrivateVisualizationDaemonRequest(
        fifth.request,
        response.response,
        1024,
        execute,
        deny,
      );
      expect(deny).toHaveBeenCalledExactlyOnceWith("busy");
      expect(execute).not.toHaveBeenCalled();
      expect(fifth.events.listenerCount("data")).toBe(0);
      expect(privateVisualizationDaemonRequestCount()).toBe(4);
    } finally {
      for (const entry of admitted) entry.response.emit("finish");
      await Promise.all(admitted.map((entry) => entry.work));
    }
    expect(privateVisualizationDaemonRequestCount()).toBe(0);
  });
  it("retires only its own slow outgoing response after a fixed deadline and releases the allowance", async () => {
    vi.useFakeTimers();
    const { request, events } = fixture();
    const outgoing = responseFixture();
    const execute = vi.fn(async () => {});
    const deny = vi.fn();
    const work = runPrivateVisualizationDaemonRequest(
      request,
      outgoing.response,
      1024,
      execute,
      deny,
    );
    events.emit("data", Buffer.from("{}"));
    events.emit("end");
    await vi.advanceTimersByTimeAsync(0);
    expect(privateVisualizationDaemonRequestCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(PRIVATE_VISUALIZATION_DAEMON_RESPONSE_MS - 1);
    expect(outgoing.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await work;
    expect(outgoing.destroy).toHaveBeenCalledOnce();
    expect(deny).not.toHaveBeenCalled();
    expect(privateVisualizationDaemonRequestCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(outgoing.events.listenerCount("finish")).toBe(0);
    expect(() => outgoing.events.emit("error", new Error("PRIVATE RESPONSE ERROR"))).not.toThrow();
  });
});
