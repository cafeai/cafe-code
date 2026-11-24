// Inert MCP peer: protocol and process lifetime only; no providers or OS input.
import { createInterface } from "node:readline";
import { appendFile, writeFile } from "node:fs/promises";
const input = createInterface({ input: process.stdin });
const waiting = new Map();
let sequence = 1000;
let previousCall;
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const result = (id, text, isError = false) =>
  send({ id, result: { content: [{ type: "text", text }], ...(isError ? { isError } : {}) } });
const appMetadata = (app, call) => ({
  connector_id: "computer-use",
  codex_approval_kind: "mcp_tool_call",
  tool_call_id: call,
  tool_name: "click",
  tool_params: { app },
  tool_params_display: [{ name: "app", value: "Fixture editor" }],
});
if (process.env.FIXTURE_STUBBORN === "1") {
  process.on("SIGTERM", () => {
    void writeFile(process.env.FIXTURE_RECEIPT + ".term", "term");
  });
  setInterval(() => {}, 1000);
}
input.on("close", () => {
  if (process.env.FIXTURE_STUBBORN === "1")
    void writeFile(process.env.FIXTURE_RECEIPT + ".eof", "eof");
});
input.on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "inert-openai-runtime-fixture", version: "1" },
      },
    });
  } else if (message.method === "tools/list") {
    send({
      id: message.id,
      result: {
        tools: ["js", "js_reset", "turn_ended"].map((name) => ({
          name,
          inputSchema: { type: "object", properties: {} },
        })),
      },
    });
  } else if (message.method === "tools/call" && message.params.name === "turn_ended") {
    if (process.env.FIXTURE_TURN_RECEIPT)
      await appendFile(
        process.env.FIXTURE_TURN_RECEIPT,
        JSON.stringify(message.params.arguments) + "\n",
      );
    result(message.id, "turn ended", process.env.FIXTURE_TURN_ERROR === "1");
  } else if (message.method === "tools/call" && message.params.name === "js") {
    const code = message.params.arguments.code;
    const call = message.params._meta?.["x-codex-turn-metadata"]?.call_id;
    const appCall = code === "stale-call" ? previousCall : call;
    previousCall = call;
    if (code === "hold") {
      await writeFile(process.env.FIXTURE_RECEIPT, "native request admitted");
      return;
    }
    if (
      code === "approval" ||
      code === "foreign-app" ||
      code === "user-question" ||
      code === "stale-call"
    ) {
      const id = ++sequence;
      waiting.set(id, message.id);
      send({
        id,
        method: "elicitation/create",
        params: {
          mode: "form",
          message: "Fixture app approval",
          requestedSchema: {
            type: "object",
            properties: code === "user-question" ? { answer: { type: "string" } } : {},
          },
          _meta: appMetadata(
            code === "foreign-app" ? "fixture.foreign" : "fixture.editor",
            appCall,
          ),
        },
      });
      return;
    }
    if (code === "crash") {
      process.exit(1);
    }
    if (code === "partial-error") {
      result(message.id, "native partial output", true);
      return;
    }
    result(
      message.id,
      JSON.stringify({
        code,
        metadata: message.params._meta,
        heap: process.env.NODE_OPTIONS,
        home: process.env.CODEX_HOME,
        providerKeyPresent: process.env.FIXTURE_PROVIDER_KEY !== undefined,
      }),
    );
  } else if (waiting.has(message.id)) {
    const original = waiting.get(message.id);
    waiting.delete(message.id);
    result(original, JSON.stringify(message.result));
  }
});
