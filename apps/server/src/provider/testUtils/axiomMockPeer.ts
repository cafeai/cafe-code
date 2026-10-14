// Test-only ACP peer. Desktop state stays in its fixture-owned temporary root;
// it never reads provider configuration, credentials or user files.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const frontend = process.argv[2] ?? "cli";
const desktop = frontend === "desktop-chat";
const fixtureRoot = process.argv[3];
const scenario = process.argv[4];
const runtimeInstanceId = randomUUID();
let sessionId = randomUUID();
let cwd = "";
let agent = {
  enabled: false,
  permission: "approve_commands",
  workingDirectory: "",
  defaultWorkingDirectory: "",
  usesDefaultDirectory: true,
  revision: 0,
};
const persist = () => {
  if (desktop)
    writeFileSync(join(fixtureRoot!, sessionId + ".json"), JSON.stringify({ cwd, agent }), {
      mode: 0o600,
    });
};
let sequence = 0;
let model = "test-model";
let thinking = "medium";
let mode = "confirm";
let turn = 0;
let lastNativeTurn = "";
let pending: { id: string | number; prompt: string; nativeTurn: string } | undefined;
let questionId: number | undefined;
let approvalId: number | undefined;
const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const result = (id: string | number, value: unknown) =>
  write({ jsonrpc: "2.0", id, result: value });
const reject = (id: string | number, message: string) =>
  write({ jsonrpc: "2.0", id, error: { code: -32602, message } });
const notify = (method: string, params: unknown) => write({ jsonrpc: "2.0", method, params });
const activity = (event: unknown) =>
  notify("_axiom/event", {
    runtimeInstanceId,
    sessionId,
    sequence: ++sequence,
    occurredAt: new Date().toISOString(),
    event,
  });
const configs = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: [
      { value: "test-model", name: "Test model" },
      { value: "other-model", name: "Other model" },
    ],
  },
  {
    id: "thinking",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: thinking,
    options: [
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
];
const setup = () => ({
  sessionId,
  configOptions: configs(),
  modes: {
    currentModeId: mode,
    availableModes: [
      { id: "confirm", name: "Confirm" },
      { id: "none", name: "None" },
      { id: "observe", name: "Observe" },
      { id: "full_access", name: "Full access" },
    ],
  },
});
const evidence = () => ({
  status: { state: "verified" },
  providerId: "tinfoil",
  modelId: model,
  attestationProtocol: "tinfoil-snp-sigstore-v1",
  e2eeProtocol: "tinfoil-ehbp-v1",
  e2eeEncryptionVersion: 1,
  trustPolicyVersion: "fixture-policy",
  verifiedAtUnixSeconds: Math.floor(Date.now() / 1000),
  hardExpiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 240,
  modelKeyFingerprint: "a".repeat(64),
  tlsSpkiFingerprint: "b".repeat(64),
  checks: [{ name: "SNP router", passed: true, detail: "Synthetic fixture evidence" }],
  providerClaims: [],
});
const finish = (authenticated: boolean) => {
  if (!pending) return;
  activity({
    kind: "request_usage_changed",
    usage: {
      requestId: `request-${turn}`,
      modelId: model,
      turnId: pending.nativeTurn,
      purpose: "conversation",
      state: "completed",
      responseVerified: authenticated,
    },
  });
  activity({ kind: "active_turn_changed", turnId: null });
  result(pending.id, { stopReason: "end_turn" });
  pending = undefined;
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method) {
    if (
      message.id === questionId &&
      message.result?.action === "accept" &&
      JSON.stringify(message.result.content?.choices) === JSON.stringify(["first"])
    )
      finish(true);
    if (message.id === approvalId) {
      if (message.result?.outcome?.outcome === "cancelled" && pending) {
        result(pending.id, { stopReason: "cancelled" });
        pending = undefined;
        return;
      }
      const choice = message.result?.outcome?.optionId;
      if (!["allow_once", "allow_exact_session"].includes(choice)) return;
      finish(true);
    }
    return;
  }
  const { id, method, params = {} } = message;
  switch (method) {
    case "initialize":
      result(id, {
        protocolVersion: 1,
        agentInfo: { name: "axiomcli", version: "0.1.13" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          _meta: {
            axiom: {
              protocolVersion: "0.2",
              runtimeInstanceId,
              features: {
                desktopChat: desktop ? 1 : 0,
                desktopAgent: desktop ? 1 : 0,
                webConsent: desktop ? 1 : 0,
                account: 2,
                modelCatalog: 1,
                securityEvidence: 4,
                activity: 1,
                timeline: 2,
                threadCatalog: 1,
                attachments: 2,
                steering: 1,
                compaction: 1,
              },
            },
          },
        },
      });
      break;
    case "_axiom/desktop/bootstrap":
      if (!desktop) {
        reject(id, "Desktop bootstrap requires desktop-chat");
        break;
      }
      result(id, {
        frontend,
        chatCwd: scenario === "invalid-bootstrap" ? "relative-folder" : fixtureRoot,
        permissionProfile: "web",
      });
      break;
    case "authenticate":
      write({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Axiom has no standard authenticate method" },
      });
      break;
    case "_axiom/account/status":
      result(id, {
        status: {
          revision: 1,
          state: "valid",
          account: { id: "fixture-account", displayName: "Fixture" },
        },
      });
      break;
    case "_axiom/models/list":
      result(id, {
        models: ["test-model", "other-model"].map((id) => ({
          id,
          label: id,
          shortLabel: id,
          providerId: "tinfoil",
          providerLabel: "Tinfoil",
          upstreamModel: id,
          thinkingLevels: ["medium", "high"],
          contextWindowTokens: 100000,
          maxOutputTokens: 4000,
          autoCompactThresholdTokens: 85000,
          supportsImages: true,
          fileMimeTypes: ["application/pdf"],
        })),
      });
      break;
    case "session/new":
    case "session/load":
      if (method === "session/load") {
        sessionId = params.sessionId;
        if (desktop) {
          const saved = JSON.parse(readFileSync(join(fixtureRoot!, sessionId + ".json"), "utf8"));
          if (params.cwd !== saved.cwd) {
            reject(id, "Desktop load requires saved native cwd");
            break;
          }
          cwd = saved.cwd;
          agent = saved.agent;
        } else cwd = params.cwd;
      } else if (desktop) {
        if (params.cwd !== fixtureRoot) {
          reject(id, "Desktop new requires bootstrap cwd");
          break;
        }
        mkdirSync(join(fixtureRoot!, sessionId), { mode: 0o700 });
        cwd = realpathSync(join(fixtureRoot!, sessionId));
      } else cwd = params.cwd;
      if (desktop && method === "session/new") {
        agent.workingDirectory = cwd;
        agent.defaultWorkingDirectory = cwd;
        persist();
      }
      result(id, setup());
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "help", description: "Fixture help" },
            { name: "update", description: "Native update" },
          ],
        },
      });
      break;
    case "session/set_config_option":
      if (params.configId === "model") model = params.value;
      else if (params.configId === "thinking") thinking = params.value;
      result(id, { configOptions: configs() });
      break;
    case "session/set_mode":
      if (desktop) {
        reject(id, "Use desktop Agent configuration");
        break;
      }
      mode = params.modeId;
      result(id, {});
      break;
    case "_axiom/desktop/agent/configure":
      if (
        !desktop ||
        params.threadId !== sessionId ||
        params.expectedRevision !== agent.revision ||
        pending
      ) {
        reject(id, "Unowned or stale Agent configuration");
        break;
      }
      cwd = realpathSync(params.workingDirectory);
      agent = {
        ...agent,
        enabled: params.enabled,
        permission: params.permission,
        workingDirectory: cwd,
        usesDefaultDirectory: cwd === agent.defaultWorkingDirectory,
        revision: agent.revision + 1,
      };
      persist();
      result(id, {
        thread: { threadId: scenario === "wrong-thread" ? randomUUID() : sessionId, cwd },
        agent: {
          ...agent,
          ...(scenario === "wrong-workspace" ? { workingDirectory: fixtureRoot } : {}),
          ...(scenario === "wrong-revision" ? { revision: agent.revision + 1 } : {}),
          ...(scenario === "wrong-permission" ? { permission: "full_access" } : {}),
        },
      });
      break;
    case "_axiom/security/prewarm":
    case "_axiom/security/verify":
      result(id, { status: { state: "verified" }, evidence: evidence() });
      break;
    case "session/prompt": {
      if (
        desktop &&
        (params._meta?.axiom?.agentRevision !== agent.revision ||
          params._meta?.axiom?.webEnabled !== false)
      ) {
        reject(id, "Prompt requires exact Agent revision and web consent");
        break;
      }
      const prompt =
        params.prompt?.map((block: { text?: string }) => block.text ?? "").join(" ") ?? "";
      turn++;
      const nativeTurn = randomUUID();
      lastNativeTurn = nativeTurn;
      pending = { id, prompt, nativeTurn };
      activity({ kind: "active_turn_changed", turnId: nativeTurn });
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "assistant:" + nativeTurn,
          content: {
            type: "text",
            text:
              mode === "none"
                ? JSON.stringify({
                    title: "Fixture title",
                    branch: "fixture-branch",
                    subject: "feat(fixture): add example",
                    body: "Fixture body",
                  })
                : prompt.includes("configuration fixture")
                  ? JSON.stringify({
                      frontend,
                      agent,
                      webEnabled: params._meta.axiom.webEnabled,
                      agentRevision: params._meta.axiom.agentRevision,
                    })
                  : "Fixture reply",
          },
        },
      });
      if (prompt.includes("question")) {
        questionId = 2000000 + turn;
        write({
          jsonrpc: "2.0",
          id: questionId,
          method: "elicitation/create",
          params: {
            sessionId,
            mode: "form",
            message: "Choose the fixture answer",
            requestedSchema: {
              type: "object",
              required: ["choices"],
              properties: {
                choices: {
                  type: "array",
                  title: "Choose one or more",
                  items: { type: "string", enum: ["first", "second"] },
                  minItems: 1,
                  maxItems: 2,
                },
              },
            },
          },
        });
      } else if (prompt.includes("approval")) {
        approvalId = 1000000 + turn;
        write({
          jsonrpc: "2.0",
          id: approvalId,
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: {
              toolCallId: "fixture-tool",
              title: "Run the scoped fixture operation",
              kind: "execute",
              status: "pending",
            },
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              {
                optionId: "allow_exact_session",
                name: "Allow exact session",
                kind: "allow_always",
              },
              { optionId: "reject_once", name: "Deny", kind: "reject_once" },
            ],
          },
        });
      } else if (!prompt.includes("hold")) {
        finish(!prompt.includes("unverified"));
        if (desktop && prompt.includes("change agent configuration")) {
          agent.revision++;
          persist();
        }
      }
      break;
    }
    case "session/cancel":
      if (pending) {
        activity({ kind: "active_turn_changed", turnId: null });
        result(pending.id, { stopReason: "cancelled" });
        pending = undefined;
      }
      break;
    case "_axiom/turn/steer":
      if (desktop && (params.agentRevision !== agent.revision || params.webEnabled !== false)) {
        reject(id, "Steering requires exact Agent revision and web consent");
        break;
      }
      result(id, { turnId: params.expectedTurnId, clientItemId: params.clientItemId });
      break;
    case "_axiom/thread/timeline":
      result(id, {
        thread: { threadId: sessionId, cwd, revision: turn, lastTimelineSequence: turn },
        ...(desktop ? { desktopAgent: agent } : {}),
        items: [
          {
            id: `assistant-${turn}`,
            turnId: lastNativeTurn,
            kind: "assistant_message",
            content: "Fixture reply",
          },
        ],
      });
      break;
    case "_axiom/compaction/start":
      result(id, { messagesBefore: 4 });
      break;
    default:
      if (id !== undefined)
        write({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Fixture method unavailable" },
        });
  }
});
