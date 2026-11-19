// Synthetic Antigravity ACP peer. The test starts it through the ordinary
// native process boundary, with no provider profile or network access.
const { createInterface } = require("node:readline");

if (process.argv[2] === "--version") {
  console.log("Antigravity CLI 1.5.11");
  process.exit(0);
}
if (process.argv[2] !== "acp" || process.argv.length !== 3) process.exit(1);

const sessionId = "gemini-fixture-session";
let resumed = false;
let mode = "auto";
let effort = "high";
let permissionPromptId;
const options = (id, category, currentValue, values) => ({
  id,
  name: category,
  category,
  type: "select",
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});
const config = () => [
  options("native-permissions", "mode", mode, ["default", "auto"]),
  options("native-model", "model", "gemini-4-neon", ["gemini-4-neon"]),
  options("native-thinking", "thought_level", effort, ["low", "high"]),
];
const write = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const result = (id, value) => write({ id, result: value });
const update = (message, owner = sessionId) =>
  write({ method: "session/update", params: { sessionId: owner, update: message } });
const text = (value, owner) =>
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } }, owner);

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params, result: clientResult } = JSON.parse(line);
  if (id === "fixture-approval" && clientResult) {
    if (clientResult.outcome?.optionId !== "fixture-once") process.exit(1);
    text(`Using ${effort} effort and one-time approval.`);
    update({ sessionUpdate: "usage_update", used: 23, size: 1_000 });
    result(permissionPromptId, { stopReason: "end_turn" });
    return;
  }

  switch (method) {
    case "initialize":
      result(id, {
        protocolVersion: 1,
        agentInfo: { name: "antigravity-acp", version: "1.5.11" },
        agentCapabilities: { sessionCapabilities: { resume: {} } },
        authMethods: [],
      });
      break;
    case "session/new":
      result(id, { sessionId, configOptions: config() });
      break;
    case "session/resume":
      if (params.sessionId !== sessionId) process.exit(1);
      resumed = true;
      result(id, { configOptions: config() });
      break;
    case "session/set_config_option":
      if (params.sessionId !== sessionId) process.exit(1);
      if (params.configId === "native-permissions" && params.value === "default") {
        mode = "default";
      } else if (params.configId === "native-thinking" && mode === "default") {
        effort = params.value;
      } else {
        process.exit(1);
      }
      result(id, { configOptions: config() });
      break;
    case "session/prompt":
      if (params.sessionId !== sessionId || mode !== "default") process.exit(1);
      if (resumed) {
        text("Resumed foreground turn is running.");
        return;
      }
      permissionPromptId = id;
      text("Foreign conversation", "foreign-session");
      write({
        id: "fixture-approval",
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: {
            toolCallId: "fixture-tool",
            title: "List the fixture directory",
            kind: "execute",
            rawInput: { command: "ls" },
          },
          options: [
            { optionId: "fixture-once", kind: "allow_once", name: "Allow once" },
            { optionId: "fixture-always", kind: "allow_always", name: "Always allow" },
            { optionId: "fixture-reject", kind: "reject_once", name: "Reject once" },
          ],
        },
      });
      break;
    case "session/cancel":
      if (params.sessionId !== sessionId) process.exit(1);
      break;
    default:
      write({ id, error: { code: -32601, message: "Unexpected fixture method" } });
  }
});
