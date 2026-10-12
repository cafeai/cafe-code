import { describe, expect, it } from "vitest";
import { MCP_APP_MAX_MESSAGE_BYTES, MCP_APP_PROTOCOL_VERSION } from "@cafecode/contracts/mcpApps";
import {
  admittedMcpAppLink,
  encodeBoundedMcpAppJson,
  McpAppProtocolSession,
  McpAppPreviewProtocol,
  readBoundedMcpAppJson,
  readMcpAppContext,
  readMcpAppRequest,
} from "./mcpAppProtocol.ts";

const envelope = (method: string, params?: unknown, id?: string | number) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method,
    ...(params ? { params } : {}),
    ...(id === undefined ? {} : { id }),
  });
const initialize = (session: McpAppProtocolSession, modes: string[] = ["inline", "fullscreen"]) =>
  session.receive(
    envelope(
      "ui/initialize",
      {
        protocolVersion: MCP_APP_PROTOCOL_VERSION,
        appInfo: { name: "fixture", version: "1" },
        appCapabilities: { availableDisplayModes: modes },
      },
      1,
    ),
  );
describe("bounded MCP App protocol", () => {
  it("replays exact private preview data but grants no operation or native display authority", () => {
    const preview = new McpAppPreviewProtocol({
      originalInputJson: '{"exact":"input"}',
      originalResultJson: '{"content":[{"type":"text","text":"exact result"}]}',
    });
    const initialization = JSON.parse(
      preview.receive(
        envelope(
          "ui/initialize",
          {
            protocolVersion: MCP_APP_PROTOCOL_VERSION,
            appInfo: { name: "fixture", version: "1" },
            appCapabilities: {},
          },
          1,
        ),
      )[0]!,
    );
    expect(initialization.result.hostCapabilities).not.toHaveProperty("serverTools");
    expect(initialization.result.hostCapabilities).not.toHaveProperty("openLinks");
    expect(preview.initialized).toBe(false);
    const replay = preview
      .receive(envelope("ui/notifications/initialized"))
      .map((text) => JSON.parse(text));
    expect(replay).toEqual([
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: { exact: "input" } },
      },
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { content: [{ type: "text", text: "exact result" }] },
      },
    ]);
    expect(preview.initialized).toBe(true);
    expect(preview.receive(envelope("ui/notifications/initialized"))).toEqual([]);
    for (const method of [
      "tools/call",
      "resources/read",
      "ui/update-model-context",
      "ui/message",
      "ui/open-link",
      "ui/request-display-mode",
    ]) {
      expect(JSON.parse(preview.receive(envelope(method, {}, 2))[0]!).error.message).toBe(
        "Operation unavailable",
      );
    }
    preview.close();
    expect(preview.initialized).toBe(false);
    expect(JSON.stringify(preview.receive(envelope("ping", {}, 3)))).not.toContain("exact result");
  });
  it("bounds native encoding before whole-object serialization and never invokes received accessors", () => {
    const data = {
      text: 'Japanese あ and escaped " text',
      array: [null, true, 42, { ok: false }],
    };
    expect(encodeBoundedMcpAppJson(data)).toBe(JSON.stringify(data));
    let called = false;
    const accessor = {
      get private() {
        called = true;
        throw new Error("PRIVATE");
      },
    };
    expect(encodeBoundedMcpAppJson(accessor)).toBeUndefined();
    expect(called).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [
      cycle,
      Array(4097).fill(0),
      { private: "あ".repeat(MCP_APP_MAX_MESSAGE_BYTES) },
      Object.create({
        toJSON() {
          called = true;
          return "PRIVATE";
        },
      }),
      NaN,
    ])
      expect(encodeBoundedMcpAppJson(value)).toBeUndefined();
    expect(called).toBe(false);
    expect(encodeBoundedMcpAppJson({ x: "ok" }, 10)).toBe('{"x":"ok"}');
    expect(encodeBoundedMcpAppJson({ x: "あ" }, 10)).toBeUndefined();
  });
  it("rejects excessive bytes, nesting and malformed envelopes before dispatch", () => {
    expect(
      readBoundedMcpAppJson(JSON.stringify("あ".repeat(MCP_APP_MAX_MESSAGE_BYTES / 2))).ok,
    ).toBe(false);
    expect(readBoundedMcpAppJson("[".repeat(25) + "0" + "]".repeat(25)).ok).toBe(false);
    expect(readBoundedMcpAppJson("[" + "0,".repeat(4100) + "0]").ok).toBe(false);
    expect(readMcpAppRequest('{"jsonrpc":"2.0","method":"ping","id":null}')).toBeUndefined();
    expect(
      readMcpAppRequest('{"jsonrpc":"2.0","method":"ping","id":1,"authority":"forged"}'),
    ).toBeUndefined();
    expect(readBoundedMcpAppJson(JSON.stringify({ text: "[{]}" })).ok).toBe(true);
  });
  it("does not expose originals until initialized and replays once in order", () => {
    const session = new McpAppProtocolSession(
      { theme: "dark" },
      '{"secret":"input"}',
      '{"content":[{"type":"text","text":"result"}]}',
    );
    const initial = initialize(session);
    expect(JSON.stringify(initial)).not.toContain("secret");
    const ready = session.receive(envelope("ui/notifications/initialized"));
    expect(ready.kind).toBe("messages");
    if (ready.kind !== "messages") throw new Error("expected messages");
    expect(ready.messages.map((text) => JSON.parse(text).method)).toEqual([
      "ui/notifications/tool-input",
      "ui/notifications/tool-result",
    ]);
    expect(ready.messages[0]).toContain("secret");
    expect(session.receive(envelope("ui/notifications/initialized"))).toEqual({
      kind: "messages",
      messages: [],
    });
    expect(JSON.stringify(initialize(session))).not.toContain("secret");
  });
  it("requires readiness, explicit IDs and declared display modes", () => {
    const session = new McpAppProtocolSession({}, "{}", "{}");
    expect(JSON.stringify(session.receive(envelope("tools/call", { name: "write" }, 4)))).toContain(
      "Operation unavailable",
    );
    initialize(session, ["inline"]);
    session.receive(envelope("ui/notifications/initialized"));
    expect(
      JSON.stringify(
        session.receive(envelope("ui/request-display-mode", { mode: "fullscreen" }, 5)),
      ),
    ).toContain("Invalid parameters");
    expect(session.receive(envelope("ui/request-display-mode", { mode: "inline" }, 6))).toEqual({
      kind: "display",
      id: 6,
      mode: "inline",
    });
    expect(JSON.stringify(session.receive(envelope("tools/call", { name: "write" })))).toContain(
      "messages",
    );
    expect(session.receive(envelope("tools/call", { name: "write" }, 7)).kind).toBe("operation");
    session.close();
    expect(JSON.stringify(session.receive(envelope("ping", {}, 8)))).toContain(
      "Operation unavailable",
    );
  });
  it("does not advertise native permission or unsupported host capabilities", () => {
    const result = initialize(new McpAppProtocolSession({}, "{}", "{}"));
    if (result.kind !== "messages") throw new Error("expected messages");
    const capabilities = JSON.parse(result.messages[0]!).result.hostCapabilities;
    expect(capabilities).not.toHaveProperty("message");
    expect(capabilities).not.toHaveProperty("updateModelContext");
    expect(capabilities.sandbox.permissions).toEqual({});
    expect(capabilities.sandbox.csp.connectDomains).toEqual([]);
  });
  it("admits only credential-free explicit web links", () => {
    expect(admittedMcpAppLink("https://example.com/view?a=1")).toBe("https://example.com/view?a=1");
    for (const link of [
      "file:///tmp/private",
      "javascript:alert(1)",
      "//example.com",
      "https://user:secret@example.com",
      "https://example.com\n",
    ])
      expect(admittedMcpAppLink(link)).toBeUndefined();
  });
  it("keeps context replace-only and rejects executable or excessive content", () => {
    expect(
      readMcpAppContext({ content: [{ type: "text", text: "untrusted next-turn context" }] }),
    ).toBeDefined();
    expect(readMcpAppContext({ content: [{ type: "image", data: "private" }] })).toBeUndefined();
    expect(
      readMcpAppContext({ content: [{ type: "text", text: "x".repeat(20_000) }] }),
    ).toBeUndefined();
    expect(readMcpAppContext({ role: "system", content: [] })).toBeUndefined();
  });
});
