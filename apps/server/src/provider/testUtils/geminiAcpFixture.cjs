// Synthetic Antigravity ACP peer. The test starts it through the ordinary
// native process boundary, with no provider profile or network access.
const { createInterface } = require("node:readline");
const version = process.env.CAFE_GEMINI_FIXTURE_NATIVE_VERSION ?? "1.5.11";
const args = process.argv.slice(2);
const privateHome = args.indexOf("--gemini_dir");
if (privateHome >= 0) {
  if (!args[privateHome + 1] || process.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE !== "1") {
    process.exit(1);
  }
  args.splice(privateHome, 2);
}

if (args[0] === "--version") {
  console.log(`Antigravity CLI ${version}`);
  process.exit(0);
}
if (args.includes("--print")) {
  const output = args.indexOf("--output-format");
  if (!args.includes("/usage") || output < 0 || args[output + 1] !== "json") {
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
                  remaining_fraction: Number(process.env.CAFE_GEMINI_FIXTURE_QUOTA_FRACTION ?? 0.4),
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
if (
  args[0] !== "acp" ||
  (args.length !== 1 &&
    !(args.length === 2 && args[1] === "--dangerously-skip-permissions") &&
    !(args.length === 2 && args[1] === "--login"))
) {
  process.exit(1);
}
if (args[1] === "--login") {
  const oauthUrl =
    process.env.CAFE_GEMINI_FIXTURE_LOGIN_URL ??
    "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=fixture.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=fixture-state";
  process.stdout.write(
    `Open this link in a browser to log in with Google:\n\n  ${oauthUrl}\n\nThen paste the authorization code:\n`,
  );
  createInterface({ input: process.stdin }).once("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "verify-code") {
      process.stderr.write(
        "Verify your account to continue. https://accounts.google.com/v3/signin/challenge/verify?continue=https%3A%2F%2Fantigravity.google\n",
      );
      process.exit(1);
    }
    if (trimmed === "valid-code") {
      process.stdout.write("Logged in.\n");
      process.exit(0);
    }
    process.stderr.write("couldn't log in: invalid_grant\n");
    process.exit(1);
  });
  return;
}

const expectManagementMcp = process.env.CAFE_GEMINI_FIXTURE_EXPECT_MANAGEMENT_MCP === "true";
function validateMcpServers(servers, generation) {
  if (!Array.isArray(servers) || servers.length !== (expectManagementMcp ? 1 : 0)) process.exit(1);
  if (!expectManagementMcp) return;
  const [bridge] = servers;
  if (
    bridge.name !== `cafe-code-fixture-${generation}` ||
    bridge.command !== process.execPath ||
    bridge.args?.length !== 2 ||
    bridge.args[0] !== `fixture-bridge-${generation}` ||
    bridge.args[1] !== `fixture-connection-${generation}` ||
    bridge.env?.length !== 1 ||
    bridge.env[0].name !== "ELECTRON_RUN_AS_NODE" ||
    bridge.env[0].value !== "1" ||
    bridge.headers !== undefined
  ) {
    process.exit(1);
  }
}

const sessionId = "gemini-fixture-session";
let resumed = false;
let mode = "auto";
let effort = "high";
let permissionPromptId;
let questionPromptId;
let steeringRootId;
let steeringFollowUpId;
let steeringCompleted = false;
let clientAdvertisedFormElicitation = false;
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
        title: "ls",
        kind: "execute",
        rawInput: {
          CommandLine: "ls",
          WaitMsBeforeAsync: 5000,
          toolSummary: "List the fixture directory",
        },
      },
      options: [
        { optionId: "fixture-once", kind: "allow_once", name: "Allow once" },
        { optionId: "fixture-always", kind: "allow_always", name: "Always allow" },
        { optionId: "fixture-reject", kind: "reject_once", name: "Reject once" },
      ],
    },
  });

const requestQuestion = (id) =>
  write({
    id,
    method: "elicitation/create",
    params: {
      sessionId,
      toolCallId: id,
      mode: "form",
      message: "The agent has 2 questions.",
      requestedSchema: {
        type: "object",
        properties: {
          q1: {
            type: "string",
            title: "Color?",
            oneOf: [
              { const: "1", title: "Red" },
              { const: "2", title: "Blue" },
            ],
          },
          q1_other: {
            type: "string",
            title: "Other",
            description: "Optional free-form answer to: Color?",
          },
          q2: {
            type: "array",
            title: "Fruits?",
            items: {
              anyOf: [
                { const: "1", title: "Apple" },
                { const: "2", title: "Banana" },
                { const: "3", title: "Pear" },
              ],
            },
          },
          q2_other: {
            type: "string",
            title: "Other",
            description: "Optional free-form answer to: Fruits?",
          },
        },
      },
    },
  });

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params, result: clientResult } = JSON.parse(line);
  if (id === "fixture-question" && clientResult) {
    if (
      clientResult.action !== "accept" ||
      clientResult.content?.q1_other !== "Purple" ||
      JSON.stringify(clientResult.content?.q2) !== JSON.stringify(["1", "3"])
    ) {
      process.exit(1);
    }
    text("Received Purple and Apple, Pear.");
    result(questionPromptId, { stopReason: "end_turn", usage: initialUsage });
    return;
  }
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
      clientAdvertisedFormElicitation = Boolean(params?.clientCapabilities?.elicitation?.form);
      result(id, {
        protocolVersion: 1,
        agentInfo: { name: "antigravity-acp", version },
        agentCapabilities: { sessionCapabilities: { resume: {} } },
        authMethods: [],
      });
      break;
    case "session/new": {
      validateMcpServers(params.mcpServers, 1);
      const errorCode = process.env.CAFE_GEMINI_FIXTURE_CATALOG_ERROR_CODE;
      if (errorCode !== undefined) {
        write({
          id,
          error: {
            code: Number(errorCode),
            message:
              process.env.CAFE_GEMINI_FIXTURE_CATALOG_ERROR_MESSAGE ?? "Fixture catalog error",
          },
        });
        break;
      }
      result(id, { sessionId, configOptions: config() });
      break;
    }
    case "session/resume":
      if (params.sessionId !== sessionId) process.exit(1);
      validateMcpServers(params.mcpServers, 2);
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
      if (input === "Ask structured questions") {
        if (!clientAdvertisedFormElicitation) process.exit(1);
        questionPromptId = id;
        update({
          sessionUpdate: "tool_call",
          toolCallId: "fixture-question",
          title: "Run ask_question",
          kind: "other",
          status: "in_progress",
        });
        requestQuestion("fixture-question");
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
