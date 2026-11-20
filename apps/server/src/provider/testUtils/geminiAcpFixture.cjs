// Synthetic Antigravity ACP peer. The test starts it through the ordinary
// native process boundary, with no provider profile or network access.
const { createInterface } = require("node:readline");
const version = process.env.CAFE_GEMINI_FIXTURE_NATIVE_VERSION ?? "1.5.11";

if (process.argv[2] === "--version") {
  console.log(`Antigravity CLI ${version}`);
  process.exit(0);
}
if (process.argv.includes("--print")) {
  const output = process.argv.indexOf("--output-format");
  if (!process.argv.includes("/usage") || output < 0 || process.argv[output + 1] !== "json") {
    process.exit(1);
  }
  // A representative native structured slash-command reply. Never read a
  // real profile, run a model prompt or expose actual account metadata.
  console.log(
    JSON.stringify({
      status: "SUCCESS",
      conversation_id: "",
      num_turns: 0,
      usage: { total_tokens: 0 },
      command: {
        name: process.env.CAFE_GEMINI_FIXTURE_REPLY_COMMAND ?? "usage",
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                {
                  id: "gemini-5h",
                  window: "5h",
                  remaining_fraction: 0.4,
                  reset_time: "2026-11-21T07:00:00Z",
                },
                {
                  id: "gemini-weekly",
                  window: "weekly",
                  remaining_fraction: 0.75,
                  reset_time: "2026-11-24T22:16:37Z",
                },
              ],
            },
            {
              name: "Claude and GPT Models",
              buckets: [
                {
                  id: "3p-5h",
                  window: "5h",
                  remaining_fraction: 0.15,
                  reset_time: "2026-11-21T08:00:00Z",
                },
                {
                  id: "3p-weekly",
                  window: "weekly",
                  disabled: true,
                  remaining_fraction: 0,
                  reset_time: "2026-11-25T06:00:00Z",
                },
              ],
            },
          ],
        },
      },
    }),
  );
  process.exit(0);
}
if (process.argv[2] !== "acp" || process.argv.length !== 3) process.exit(1);

const sessionId = "gemini-fixture-session";
let resumed = false;
let mode = "auto";
let effort = "high";
let permissionPromptId;
let steeringRootId;
let steeringFollowUpId;
let steeringCompleted = false;
const initialUsage = {
  inputTokens: 9_230,
  outputTokens: 509,
  thoughtTokens: 393,
  cachedReadTokens: 0,
  cachedWriteTokens: 0,
  totalTokens: 9_739,
};
const continuedUsage = {
  inputTokens: 2_666,
  outputTokens: 29,
  thoughtTokens: 27,
  cachedReadTokens: 7_173,
  cachedWriteTokens: 0,
  totalTokens: 9_868,
};
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
const text = (value, owner, messageId) =>
  update(
    {
      sessionUpdate: "agent_message_chunk",
      ...(messageId ? { messageId } : {}),
      content: { type: "text", text: value },
    },
    owner,
  );
const requestPermission = (id) =>
  write({
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: {
        toolCallId: id,
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

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params, result: clientResult } = JSON.parse(line);
  if (id === "fixture-approval" && clientResult) {
    if (clientResult.outcome?.optionId !== "fixture-once") process.exit(1);
    text(`Using ${effort} effort and one-time approval.`);
    update({ sessionUpdate: "usage_update", used: 23, size: 1_000 });
    result(permissionPromptId, { stopReason: "end_turn", usage: initialUsage });
    return;
  }
  if (id === "fixture-steering-approval" && clientResult) {
    if (clientResult.outcome?.optionId !== "fixture-once") process.exit(1);
    steeringCompleted = true;
    result(steeringFollowUpId, { stopReason: "end_turn", usage: continuedUsage });
    return;
  }

  switch (method) {
    case "initialize":
      result(id, {
        protocolVersion: 1,
        agentInfo: { name: "antigravity-acp", version },
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
        // The next native config request gives the fixture a deterministic
        // idle window on the same child following the first foreground turn.
        if (steeringCompleted && effort === "high") {
          text("Background task finished.", sessionId, "fixture-detached-reply");
        }
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
      const input = params.prompt[0]?.text;
      if (input === "Start the steering fixture" && steeringRootId === undefined) {
        steeringRootId = id;
        text("Initial foreground output.");
        return;
      }
      if (
        input === "Deliver this follow-up" &&
        steeringRootId !== undefined &&
        steeringFollowUpId === undefined
      ) {
        steeringFollowUpId = id;
        // Native Antigravity may finish the original RPC before producing
        // follow-up output. The second RPC keeps the foreground turn alive.
        result(steeringRootId, { stopReason: "cancelled", usage: initialUsage });
        text("Follow-up reached the agent.");
        requestPermission("fixture-steering-approval");
        return;
      }
      if (input === "Start the next foreground" && steeringCompleted) {
        result(id, {
          stopReason: "end_turn",
          usage: { ...continuedUsage, cachedWriteTokens: 1 },
        });
        return;
      }
      if (input !== "Hello Gemini") process.exit(1);
      permissionPromptId = id;
      text("Foreign conversation", "foreign-session");
      requestPermission("fixture-approval");
      break;
    case "session/cancel":
      if (params.sessionId !== sessionId) process.exit(1);
      break;
    default:
      write({ id, error: { code: -32601, message: "Unexpected fixture method" } });
  }
});
