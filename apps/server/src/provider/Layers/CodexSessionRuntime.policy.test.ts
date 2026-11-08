import { TurnId } from "@cafecode/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";
import assert from "node:assert/strict";
import * as Toml from "toml";
import { describe, it } from "vitest";
import { GENERATED_VISUALIZATION_INSTRUCTIONS } from "../../visualizations/mcp.ts";
import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_VISUALIZATION_DISCOVERY_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import { buildCodexSteerClientCorrelationId } from "../codexSteerCorrelation.ts";
import {
  buildCodexAppServerArgs,
  buildTurnStartParams,
  buildTurnSteerParams,
  isRecoverableThreadResumeError,
  readCodexExpectedActiveTurnMismatchActualTurnId,
  readCodexSteerExpectedTurnMismatchActualTurnId,
  selectCodexActiveSnapshotTurn,
} from "./CodexSessionRuntime.ts";
describe("buildCodexAppServerArgs", () => {
  it.each(["visualizationMcp", "managementMcp", "glideMcp"] as const)(
    "adds only the admitted %s catalog without changing permissions",
    (kind) => {
      // Inspect the real structured launch builder without starting a provider or
      // reading an account profile. The private connection path is inert data.
      const launch = {
        command: process.execPath,
        args: ["synthetic-visualization-bridge.mjs", "synthetic-private-connection.json"],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      };
      const name = `cafe-visualizations-${"a".repeat(22)}`;
      const options = {
        schedulingMcp: { name: "cafe-scheduling", launch },
        maxConcurrentSubagents: 4,
      };
      const baseline = buildCodexAppServerArgs(options);
      assert.equal(
        baseline.some((argument) => argument.includes(name)),
        false,
      );
      assert.deepEqual(buildCodexAppServerArgs({ ...options, [kind]: undefined }), baseline);
      const args = buildCodexAppServerArgs({ ...options, [kind]: { name, launch } });
      const config = args.find((argument) => argument.startsWith(`mcp_servers.${name}=`));
      assert.ok(config);
      const index = args.indexOf(config);
      assert.equal(args[index - 1], "-c");
      assert.deepEqual(JSON.parse(JSON.stringify(Toml.parse(config))), {
        mcp_servers: {
          [name]: {
            ...launch,
            enabled: true,
            required: kind !== "managementMcp",
            startup_timeout_sec: 15,
            tool_timeout_sec: 60,
          },
        },
      });
      assert.deepEqual(
        args.filter((_, position) => position !== index && position !== index - 1),
        baseline,
      );
      assert.doesNotMatch(config, /approval|sandbox|bearer|token|threadId/u);
    },
  );
  it("attaches a required isolated scheduling catalog without changing permissions or other MCPs", () => {
    const schedulingMcp = {
      name: "cafe-fixture_generation",
      launch: {
        command: 'C:\\Program Files\\Cafe & Code\\Cafe "fixture".exe',
        args: ["/fixture/bridge ' spaced.mjs", "C:\\private\\connection %literal%.json"],
        env: { ELECTRON_RUN_AS_NODE: "1", FIXTURE_LITERAL: 'line\nquote"\tDEL\u007f' },
      },
    };
    const args = buildCodexAppServerArgs({
      schedulingMcp,
      maxConcurrentSubagents: 4,
    });
    const config = args.find((argument) => argument.startsWith("mcp_servers.cafe-fixture_"));
    assert.ok(config);
    assert.equal(args[args.indexOf(config) - 1], "-c");
    // Parse the emitted TOML independently rather than mirroring its quoting.
    // Shell metacharacters, spaces and host-native separators must be literal
    // values inside the single structured CLI argument.
    assert.deepEqual(JSON.parse(JSON.stringify(Toml.parse(config))), {
      mcp_servers: {
        [schedulingMcp.name]: {
          ...schedulingMcp.launch,
          enabled: true,
          required: true,
          startup_timeout_sec: 15,
          tool_timeout_sec: 60,
        },
      },
    });
    assert.equal(args.includes("agents.max_concurrent_threads_per_session=4"), true);
    assert.equal(
      args.some((argument) => argument.startsWith("mcp_servers.cafe-desktop=")),
      false,
    );
    assert.doesNotMatch(config, /approval|sandbox|bearer|token|threadId|providerInstanceId/u);
  });

  it("rejects malformed scheduling names and launch values before process creation", () => {
    const launch = { command: "/fixture/node", args: ["/fixture/bridge.mjs"], env: {} };
    for (const name of ["", "cafe.other", 'cafe"={enabled=false}', "a".repeat(129)]) {
      assert.throws(
        () => buildCodexAppServerArgs({ schedulingMcp: { name, launch } }),
        /Invalid scheduling MCP server name/u,
      );
    }
    for (const command of ["private\u0000command", "private\ud800command"]) {
      assert.throws(
        () =>
          buildCodexAppServerArgs({
            schedulingMcp: { name: "cafe-fixture", launch: { ...launch, command } },
          }),
        /^TypeError: Invalid scheduling MCP launch value\.$/u,
      );
    }
  });

  it("enables Cafe task plans while preserving Codex concurrency defaults when unset", () => {
    assert.deepStrictEqual(buildCodexAppServerArgs({}), [
      "app-server",
      "-c",
      "tools.update_plan.enabled=true",
    ]);
    assert.deepStrictEqual(
      buildCodexAppServerArgs({
        transportPolicy: { responsesWebsockets: "auto" },
      }),
      ["app-server", "-c", "tools.update_plan.enabled=true"],
    );
  });

  it("overrides both V1 and root-inclusive V2 capacity when explicitly configured", () => {
    assert.deepStrictEqual(buildCodexAppServerArgs({ maxConcurrentSubagents: 12 }), [
      "app-server",
      "-c",
      "tools.update_plan.enabled=true",
      "-c",
      "agents.max_concurrent_threads_per_session=12",
      "-c",
      "features.multi_agent_v2.max_concurrent_threads_per_session=13",
    ]);
    for (const limit of [1, 64]) {
      const args = buildCodexAppServerArgs({ maxConcurrentSubagents: limit });
      assert.equal(args.includes(`agents.max_concurrent_threads_per_session=${limit}`), true);
      assert.equal(
        args.includes(`features.multi_agent_v2.max_concurrent_threads_per_session=${limit + 1}`),
        true,
      );
    }
  });

  it("uses a Cafe-scoped OpenAI provider when Responses WebSockets are disabled", () => {
    assert.deepStrictEqual(
      buildCodexAppServerArgs({
        maxConcurrentSubagents: 24,
        transportPolicy: { responsesWebsockets: "disabled" },
      }),
      [
        "app-server",
        "-c",
        "tools.update_plan.enabled=true",
        "-c",
        "agents.max_concurrent_threads_per_session=24",
        "-c",
        "features.multi_agent_v2.max_concurrent_threads_per_session=25",
        "-c",
        'model_provider="cafecode-openai-http"',
        "-c",
        'model_providers.cafecode-openai-http.name="OpenAI"',
        "-c",
        'model_providers.cafecode-openai-http.wire_api="responses"',
        "-c",
        "model_providers.cafecode-openai-http.requires_openai_auth=true",
        "-c",
        'model_providers.cafecode-openai-http.env_http_headers.OpenAI-Organization="OPENAI_ORGANIZATION"',
        "-c",
        'model_providers.cafecode-openai-http.env_http_headers.OpenAI-Project="OPENAI_PROJECT"',
        "-c",
        "model_providers.cafecode-openai-http.supports_websockets=false",
      ],
    );
  });

  it("rejects subagent limits outside the decoded provider-setting bounds", () => {
    for (const maxConcurrentSubagents of [0, 65, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => buildCodexAppServerArgs({ maxConcurrentSubagents }),
        /maxConcurrentSubagents must be an integer between 1 and 64/,
      );
    }
  });
});
describe("buildTurnStartParams", () => {
  it.each(["default", "plan"] as const)(
    "appends conditional visualization discovery without replacing %s mode or turn authority",
    (interactionMode) => {
      const input = {
        threadId: "synthetic-visualization-native-thread",
        runtimeMode: "approval-required" as const,
        prompt: "Use colorful animated charts with a subtle frosted WebGL background.",
        attachments: [{ type: "image" as const, url: "https://example.invalid/reference.png" }],
        model: "gpt-6.1-sol",
        serviceTier: "fast" as const,
        effort: "high" as const,
        interactionMode,
      };
      const baseline = Effect.runSync(buildTurnStartParams(input));
      const modeInstructions =
        interactionMode === "plan"
          ? CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
          : CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS;
      assert.equal(baseline.collaborationMode?.settings.developer_instructions, modeInstructions);
      assert.equal(JSON.stringify(baseline).includes("preview_visualization"), false);
      // The exact optional contract admits false or an omitted property, not
      // an explicitly present undefined value. Exercise both valid requests.
      for (const nonvisualizationInput of [input, { ...input, visualizationInstructions: false }]) {
        assert.deepEqual(Effect.runSync(buildTurnStartParams(nonvisualizationInput)), baseline);
      }
      const admitted = Effect.runSync(
        buildTurnStartParams({ ...input, visualizationInstructions: true }),
      );
      assert.deepEqual(admitted, {
        ...baseline,
        collaborationMode: {
          ...baseline.collaborationMode,
          settings: {
            ...baseline.collaborationMode!.settings,
            developer_instructions: `${modeInstructions}\n\n${CODEX_VISUALIZATION_DISCOVERY_INSTRUCTIONS}`,
          },
        },
      });
      // Guidance stays in the supported developer channel, never the user's
      // prompt, model selection, native effort, approval or sandbox settings.
      assert.deepEqual(admitted.input, baseline.input);
      assert.equal(admitted.collaborationMode?.mode, interactionMode);
      assert.equal(
        admitted.collaborationMode?.settings.developer_instructions?.includes(
          GENERATED_VISUALIZATION_INSTRUCTIONS,
        ),
        false,
      );
      assert.equal(admitted.model, input.model);
      assert.equal(admitted.serviceTier, input.serviceTier);
      assert.equal(admitted.collaborationMode?.settings.reasoning_effort, input.effort);
      assert.equal(admitted.approvalPolicy, baseline.approvalPolicy);
      assert.deepEqual(admitted.sandboxPolicy, baseline.sandboxPolicy);
    },
  );
  it("does not add collaboration or user instructions when the caller omits interaction mode", () => {
    const input = {
      threadId: "synthetic-visualization-native-thread",
      runtimeMode: "full-access" as const,
      prompt: "The user's content stays exact.",
      model: "gpt-6.1-sol",
      serviceTier: "fast" as const,
      effort: "high" as const,
    };
    const baseline = Effect.runSync(buildTurnStartParams(input));
    assert.equal(baseline.collaborationMode, undefined);
    assert.deepEqual(
      Effect.runSync(buildTurnStartParams({ ...input, visualizationInstructions: true })),
      baseline,
    );
  });
  it.each(["standard", "daybreakBlue", "daybreakRed"] as const)(
    "preserves explicit %s cyber treatment through experimental request decoding",
    (cyberAccessProgram) => {
      const params = Effect.runSync(
        buildTurnStartParams({
          threadId: "provider-thread-daybreak",
          runtimeMode: "approval-required",
          prompt: "Review this patch",
          cyberAccessProgram,
        }),
      );
      assert.equal(params.cyberAccessProgram, cyberAccessProgram);
      assert.equal(params.approvalPolicy, "untrusted");
      const ordinary = Effect.runSync(
        buildTurnStartParams({
          threadId: "ordinary",
          runtimeMode: "approval-required",
          prompt: "Hello",
        }),
      );
      assert.equal(Object.hasOwn(ordinary, "cyberAccessProgram"), false);
    },
  );
  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        nativeReasoningEffort: null,
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: null,
          developer_instructions: CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("normalizes a persisted Claude auto mode when a thread switches to Codex", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Continue with Codex",
        model: "gpt-5.3-codex",
        interactionMode: "auto",
        nativeReasoningEffort: null,
      }),
    );

    assert.equal(params.collaborationMode?.mode, "default");
    assert.equal(
      params.collaborationMode?.settings.developer_instructions,
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
    );
  });

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });

  it("preserves a native selected effort when the caller omits its override", () => {
    for (const effort of ["low", "high", "ultra", "max"]) {
      const params = Effect.runSync(
        buildTurnStartParams({
          threadId: "provider-thread-1",
          runtimeMode: "full-access",
          model: "gpt-6.1-sol",
          interactionMode: "plan",
          nativeReasoningEffort: effort,
        }),
      );
      assert.equal(params.collaborationMode?.settings.reasoning_effort, effort);
      assert.equal(params.effort, undefined);
    }
  });

  it("gives explicit effort precedence over native selection and native-default delegation", () => {
    for (const nativeReasoningEffort of ["high", null, undefined]) {
      const params = Effect.runSync(
        buildTurnStartParams({
          threadId: "provider-thread-1",
          runtimeMode: "full-access",
          interactionMode: "default",
          effort: "ultra",
          ...(nativeReasoningEffort !== undefined ? { nativeReasoningEffort } : {}),
        }),
      );
      assert.equal(params.collaborationMode?.settings.reasoning_effort, "ultra");
      assert.equal(params.effort, "ultra");
    }
  });

  it("refuses an unknown native effort rather than guessing or clearing it", () => {
    const exit = Effect.runSyncExit(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    );
    assert.equal(exit._tag, "Failure");
    if (exit._tag === "Failure") {
      assert.match(String(exit.cause), /Select a reasoning effort/);
    }
  });

  it("includes additional directories as workspace-write writable roots", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        cwd: "/tmp/project",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        additionalDirectories: ["/tmp/docs", "/tmp/tools"],
      }),
    );

    assert.equal(params.cwd, "/tmp/project");
    assert.deepStrictEqual(params.environments, [
      {
        environmentId: "local",
        cwd: "/tmp/project",
        runtimeWorkspaceRoots: ["/tmp/project", "/tmp/docs", "/tmp/tools"],
      },
    ]);
    assert.deepStrictEqual(params.runtimeWorkspaceRoots, [
      "/tmp/project",
      "/tmp/docs",
      "/tmp/tools",
    ]);
    assert.deepStrictEqual(params.sandboxPolicy, {
      type: "workspaceWrite",
      writableRoots: ["/tmp/docs", "/tmp/tools"],
    });
  });
});
describe("buildTurnSteerParams", () => {
  it("keeps image-only starts and steers free of text input", () => {
    const attachments = [{ type: "image" as const, url: "data:image/png;base64,AQIDBA==" }];
    const start = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-image-only-thread",
        runtimeMode: "full-access",
        attachments,
      }),
    );
    const steer = Effect.runSync(
      buildTurnSteerParams({
        threadId: "provider-image-only-thread",
        expectedTurnId: TurnId.make("image-only-active-turn"),
        clientUserMessageId: "image-only-message",
        attachments,
      }),
    );
    assert.deepStrictEqual(start.input, attachments);
    assert.deepStrictEqual(steer.input, attachments);
  });

  it("builds the upstream Codex turn/steer shape without turn-start overrides", () => {
    const clientCorrelationId = buildCodexSteerClientCorrelationId("message-1");
    const params = Effect.runSync(
      buildTurnSteerParams({
        threadId: "provider-thread-1",
        expectedTurnId: TurnId.make("turn-active"),
        clientUserMessageId: clientCorrelationId,
        prompt: "stay on this path",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      expectedTurnId: "turn-active",
      clientUserMessageId: clientCorrelationId,
      input: [
        {
          type: "text",
          text: "stay on this path",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
    });
  });
});
describe("readCodexSteerExpectedTurnMismatchActualTurnId", () => {
  it("extracts the app-server reported active turn id from upstream mismatch errors", () => {
    const actualTurnId = readCodexSteerExpectedTurnMismatchActualTurnId(
      CodexErrors.CodexAppServerRequestError.invalidRequest(
        "expected active turn id `turn-old` but found `turn-new`",
      ),
    );

    assert.equal(actualTurnId, "turn-new");
  });

  it("extracts the app-server reported active turn id from upstream interrupt mismatches", () => {
    const actualTurnId = readCodexExpectedActiveTurnMismatchActualTurnId(
      CodexErrors.CodexAppServerRequestError.invalidRequest(
        "expected active turn id turn-old but found turn-new",
      ),
    );

    assert.equal(actualTurnId, "turn-new");
  });

  it("ignores unrelated turn/steer request errors", () => {
    const actualTurnId = readCodexSteerExpectedTurnMismatchActualTurnId(
      CodexErrors.CodexAppServerRequestError.invalidRequest("cannot steer a review turn"),
    );

    assert.equal(actualTurnId, undefined);
  });
});
describe("isRecoverableThreadResumeError", () => {
  it.each([
    {
      type: "modelProviderMismatch",
      modelProvider: "thread not found",
      currentModelProvider: "current-provider",
    },
    { type: "modelProviderNotConfigured", modelProvider: "missing thread" },
    {
      type: "modelProviderPolicyConflict",
      modelProvider: "unknown thread",
      requiredModelProvider: "required-provider",
    },
    // A known refusal with omitted provider fields is still not proof of a
    // missing conversation. Do not let a partial future/native error discard
    // history by falling back to prose.
    { type: "modelProviderMismatch" },
    { type: "modelProviderNotConfigured" },
    { type: "modelProviderPolicyConflict" },
  ])("retains history for structured native provider refusal %j", (data) => {
    assert.equal(
      isRecoverableThreadResumeError(
        CodexErrors.CodexAppServerRequestError.invalidRequest(
          "This chat uses thread not found, but its provider configuration has changed.",
          data,
        ),
      ),
      false,
    );
  });

  it("keeps unknown structured errors on the existing missing-thread policy", () => {
    for (const data of [
      undefined,
      null,
      { type: "futureNativeError" },
      { detail: "ordinary" },
      ["ordinary future metadata"],
    ]) {
      assert.equal(
        isRecoverableThreadResumeError(
          CodexErrors.CodexAppServerRequestError.invalidRequest("Thread does not exist", data),
        ),
        true,
      );
    }
    assert.equal(isRecoverableThreadResumeError(new Error("Thread not found")), true);
    assert.equal(isRecoverableThreadResumeError("Thread not found"), true);
  });

  it("does not execute received accessors, proxies or coercion to admit a blank thread", () => {
    let reads = 0;
    const refusal = Object.defineProperty({}, "type", {
      get: () => {
        reads += 1;
        return "modelProviderMismatch";
      },
    });
    const dataAccessor = Object.defineProperty({ errorMessage: "Thread not found" }, "data", {
      get: () => {
        reads += 1;
        return refusal;
      },
    });
    const messageAccessor = Object.defineProperty({}, "message", {
      get: () => {
        reads += 1;
        return "Thread not found";
      },
    });
    const coercible = {
      toString: () => {
        reads += 1;
        return "Thread not found";
      },
    };
    const proxy = new Proxy(
      { errorMessage: "Thread not found" },
      {
        get: () => {
          reads += 1;
          throw new Error("Synthetic proxy must stay unread");
        },
        getOwnPropertyDescriptor: () => {
          reads += 1;
          throw new Error("Synthetic descriptor must stay unread");
        },
        getPrototypeOf: () => {
          reads += 1;
          throw new Error("Synthetic prototype must stay unread");
        },
      },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const error of [
      CodexErrors.CodexAppServerRequestError.invalidRequest("Thread not found", refusal),
      CodexErrors.CodexAppServerRequestError.invalidRequest("Thread not found", proxy),
      dataAccessor,
      messageAccessor,
      coercible,
      proxy,
      revoked.proxy,
    ])
      assert.equal(isRecoverableThreadResumeError(error), false);
    assert.equal(reads, 0);
  });

  it("matches missing thread errors", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});
describe("selectCodexActiveSnapshotTurn", () => {
  it("restores only an in-progress Codex turn from a resumed thread snapshot", () => {
    const activeTurn = selectCodexActiveSnapshotTurn({
      id: "provider-thread-1",
      status: { type: "active", activeFlags: [] },
      turns: [
        {
          id: "turn-completed",
          status: "completed",
          items: [],
        },
        {
          id: "turn-running",
          status: "inProgress",
          items: [],
        },
      ],
    });

    assert.equal(activeTurn?.id, "turn-running");
  });

  it("does not restore stale active state when thread/read has no in-progress turn", () => {
    const activeTurn = selectCodexActiveSnapshotTurn({
      id: "provider-thread-1",
      status: { type: "active", activeFlags: [] },
      turns: [
        {
          id: "turn-completed",
          status: "completed",
          items: [],
        },
      ],
    });

    assert.equal(activeTurn, undefined);
  });

  it("does not restore active state from an idle Codex thread snapshot", () => {
    const activeTurn = selectCodexActiveSnapshotTurn({
      id: "provider-thread-1",
      status: { type: "idle" },
      turns: [
        {
          id: "turn-completed",
          status: "completed",
          items: [],
        },
      ],
    });

    assert.equal(activeTurn, undefined);
  });
});
