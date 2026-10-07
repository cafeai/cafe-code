import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexError from "./errors.ts";
import * as CodexProtocol from "./protocol.ts";
import * as CodexSchema from "./schema.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const encoder = new TextEncoder();

const encodeJsonl = (value: unknown) => encoder.encode(`${encodeUnknownJsonString(value)}\n`);

const decodeJson = Schema.decodeEffect(Schema.UnknownFromJsonString);
const isAccountRateLimitPlanType = Schema.is(
  CodexSchema.V2AccountRateLimitsUpdatedNotification__PlanType,
);
const isThreadMetadataUpdateParams = Schema.is(CodexSchema.V2ThreadMetadataUpdateParams);
const isItemStartedNotification = Schema.is(CodexSchema.V2ItemStartedNotification);
const decodeServerNotification = Schema.decodeUnknownSync(CodexSchema.ServerNotification);
const decodeThreadShellCommandParams = Schema.decodeUnknownSync(
  CodexSchema.V2ThreadShellCommandParams,
);
const decodeTurnUserInput = Schema.decodeUnknownSync(CodexSchema.V2TurnStartParams__UserInput);
const isTurnUserInput = Schema.is(CodexSchema.V2TurnStartParams__UserInput);
const decodeResumeContent = Schema.decodeUnknownSync(CodexSchema.V2ThreadResumeParams__ContentItem);
const isResumeContent = Schema.is(CodexSchema.V2ThreadResumeParams__ContentItem);
const decodeCatalogModel = Schema.decodeUnknownSync(CodexSchema.V2ModelListResponse__Model);
const decodeAccountResponse = Schema.decodeUnknownSync(
  CodexSchema.CLIENT_REQUEST_RESPONSES["account/read"],
);
const isErrorNotification = Schema.is(CodexSchema.V2ErrorNotification);
const decodeMcpServerStatusParams = Schema.decodeUnknownSync(
  CodexSchema.CLIENT_REQUEST_PARAMS["mcpServerStatus/list"],
);
const isMcpServerStatusParams = Schema.is(
  CodexSchema.CLIENT_REQUEST_PARAMS["mcpServerStatus/list"],
);
const decodeThreadItemsListParams = Schema.decodeUnknownSync(
  CodexSchema.CLIENT_REQUEST_PARAMS["thread/items/list"],
);
const isThreadItemsListParams = Schema.is(CodexSchema.CLIENT_REQUEST_PARAMS["thread/items/list"]);

it("preserves Codex 0.158 Pro Max account and rate-limit metadata", () => {
  const account = {
    account: { type: "chatgpt", email: null, planType: "promax" },
    requiresOpenaiAuth: true,
  } as const;
  assert.deepEqual(decodeAccountResponse(account), account);

  // Account and quota notifications inline their own copies of the upstream
  // plan enum. Exercise the complete wire envelopes so adding the new plan
  // cannot accidentally leave one live account channel unable to decode it.
  const accountUpdated = {
    method: "account/updated",
    params: { authMode: "chatgpt", planType: "promax" },
  } as const;
  const rateLimitsUpdated = {
    method: "account/rateLimits/updated",
    params: { rateLimits: { planType: "promax" } },
  } as const;
  assert.deepEqual(decodeServerNotification(accountUpdated), accountUpdated);
  assert.deepEqual(decodeServerNotification(rateLimitsUpdated), rateLimitsUpdated);
  assert.equal(isAccountRateLimitPlanType("promax"), true);
  assert.equal(isAccountRateLimitPlanType("pro-max"), false);
});

it("decodes Codex 0.158 Flex capacity failures without losing terminal notifications", () => {
  const error = {
    message: "Flex capacity is unavailable.",
    codexErrorInfo: "flexUnavailable",
    additionalDetails: null,
    misalignment: null,
  } as const;
  const failed = {
    method: "error",
    params: { threadId: "thread-1", turnId: "turn-1", willRetry: false, error },
  } as const;
  const completed = {
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [],
        itemsView: "full",
        status: "failed",
        error,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      },
    },
  } as const;

  // A new error discriminator must survive both the live failure and the
  // terminal-turn envelope; rejecting either can strand an otherwise settled
  // Cafe turn. The provider's explicit willRetry/status remain authoritative.
  assert.deepEqual(decodeServerNotification(failed), failed);
  assert.deepEqual(decodeServerNotification(completed), completed);
  assert.equal(
    isErrorNotification({
      ...failed.params,
      error: { ...error, codexErrorInfo: "flex-unavailable" },
    }),
    false,
  );
});

it("decodes Codex 0.159 denial failures and preserves the provider's retry decision", () => {
  const error = {
    message: "Too many tool calls were denied.",
    codexErrorInfo: "tooManyDenials",
    additionalDetails: null,
    misalignment: null,
  } as const;

  // This classification is terminal when Codex says it is. Decode the exact
  // upstream discriminator without broadening the error enum or substituting
  // a retry policy that could repeat a denied action.
  for (const willRetry of [false, true]) {
    const failed = {
      method: "error",
      params: { threadId: "thread-1", turnId: "turn-1", willRetry, error },
    } as const;
    assert.deepEqual(decodeServerNotification(failed), failed);
  }
  // 0.159 also documents errors on interrupted turns. Preserve that terminal
  // status verbatim instead of assuming any error means `failed`.
  for (const status of ["failed", "interrupted"] as const) {
    const completed = {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          itemsView: "full",
          status,
          error,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      },
    } as const;
    assert.deepEqual(decodeServerNotification(completed), completed);
  }
  assert.equal(
    isErrorNotification({
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
      error: { ...error, codexErrorInfo: "too-many-denials" },
    }),
    false,
  );
});

it("preserves Codex 0.159 optional MCP status server filtering", () => {
  // Exercise the RPC parameter map, not only the standalone definition: a
  // generator regression must not silently strip the server-scoping request.
  // Omission still preserves the existing all-server discovery behavior.
  const legacy = { detail: "toolsAndAuthOnly", threadId: "thread-1" } as const;
  assert.deepEqual(decodeMcpServerStatusParams(legacy), legacy);
  for (const serverName of ["example-server", null]) {
    const params = { ...legacy, serverName };
    assert.deepEqual(decodeMcpServerStatusParams(params), params);
  }
  assert.equal(isMcpServerStatusParams({ ...legacy, serverName: 42 }), false);
});

it("preserves Codex 0.159 item anchors and existing thread item cursors", () => {
  const base = { threadId: "thread-1", turnId: "turn-1", sortDirection: "desc" } as const;
  for (const cursor of ["opaque-continuation", { type: "item", itemId: "item-1" }, null] as const) {
    const params = { ...base, cursor };
    assert.deepEqual(decodeThreadItemsListParams(params), params);
  }
  assert.deepEqual(decodeThreadItemsListParams({ threadId: "thread-1" }), {
    threadId: "thread-1",
  });

  // Upstream documents the non-empty turnId requirement as a server-validated
  // relationship, not a JSON-schema refinement. Keep this generated-boundary
  // test focused on the declared anchor shape; Cafe does not yet send anchors.
  for (const cursor of [
    { type: "item" },
    { type: "item", itemId: 42 },
    { type: "turn", itemId: "item-1" },
    {},
    [],
    42,
  ]) {
    assert.equal(isThreadItemsListParams({ ...base, cursor }), false);
  }
});

it("keeps Codex 0.157 gateway login capability opt-in and its responses typed", () => {
  const decodeCapabilities = Schema.decodeUnknownSync(
    CodexSchema.V1InitializeParams__InitializeCapabilities,
  );
  const legacy = { experimentalApi: true };
  assert.deepEqual(decodeCapabilities(legacy), legacy);
  for (const explicitGatewayOauth of [false, true]) {
    assert.deepEqual(decodeCapabilities({ ...legacy, explicitGatewayOauth }), {
      ...legacy,
      explicitGatewayOauth,
    });
  }
  assert.equal(
    Schema.is(CodexSchema.V1InitializeParams__InitializeCapabilities)({
      explicitGatewayOauth: null,
    }),
    false,
  );

  // The new methods deliberately omit the account namespace in their response
  // type names. Exercise the generated RPC map, not just standalone schemas,
  // so a future regeneration cannot silently bind an unrelated response type.
  const read = {
    providerId: "gateway-example",
    providerName: "Example gateway",
    required: true,
    status: "notReady",
    error: null,
  } as const;
  assert.deepEqual(
    Schema.decodeUnknownSync(CodexSchema.CLIENT_REQUEST_RESPONSES["account/gatewayOAuth/read"])(
      read,
    ),
    read,
  );
  for (const method of ["account/gatewayOAuth/login", "account/gatewayOAuth/cancel"] as const) {
    assert.equal(CodexSchema.CLIENT_REQUEST_METHODS[method], method);
    assert.equal(CodexSchema.CLIENT_REQUEST_PARAMS[method], undefined);
    assert.deepEqual(
      Schema.decodeUnknownSync(CodexSchema.CLIENT_REQUEST_RESPONSES[method])({}),
      {},
    );
  }
  const changed = {
    method: "account/gatewayOAuth/changed",
    params: {
      providerId: "gateway-example",
      status: "succeeded",
      authUrl: null,
      error: null,
    },
  } as const;
  assert.deepEqual(decodeServerNotification(changed), changed);
  assert.equal(
    Schema.is(CodexSchema.V2GatewayOAuthReadResponse)({ ...read, status: "unknown" }),
    false,
  );
});

it("preserves Codex 0.157 item lifecycle timestamps and older history entries", () => {
  const decodeEntry = Schema.decodeUnknownSync(
    CodexSchema.V2ThreadItemsListResponse__ThreadItemEntry,
  );
  const legacy = {
    turnId: "turn-1",
    item: { type: "agentMessage", id: "item-1", text: "Done." },
  } as const;
  assert.deepEqual(decodeEntry(legacy), legacy);
  for (const times of [
    { startedAtMs: null, completedAtMs: null },
    { startedAtMs: 1_721_234_567_000, completedAtMs: 1_721_234_567_890 },
  ]) {
    assert.deepEqual(decodeEntry({ ...legacy, ...times }), { ...legacy, ...times });
  }
  // Provider timestamps are optional display metadata, not a new lifecycle
  // boundary. Keep wire type validation while retaining old timestamp-free
  // entries; do not invent local timestamps during history decoding.
  assert.equal(
    Schema.is(CodexSchema.V2ThreadItemsListResponse__ThreadItemEntry)({
      ...legacy,
      completedAtMs: "1721234567890",
    }),
    false,
  );
});

it("preserves Codex 0.157 MCP origins and explicit resource targets without requiring them", () => {
  const decodeStatus = Schema.decodeUnknownSync(
    CodexSchema.V2ListMcpServerStatusResponse__McpServerStatus,
  );
  const legacyStatus = {
    name: "test-server",
    tools: {},
    resources: [],
    resourceTemplates: [],
    authStatus: "unknown",
  } as const;
  assert.deepEqual(decodeStatus(legacyStatus), legacyStatus);
  for (const httpOrigin of [null, "https://example.invalid"]) {
    assert.deepEqual(decodeStatus({ ...legacyStatus, httpOrigin }), {
      ...legacyStatus,
      httpOrigin,
    });
  }

  const decodeRead = Schema.decodeUnknownSync(CodexSchema.V2McpResourceReadParams);
  const legacyRead = { server: "test-server", uri: "ui://example/resource" };
  assert.deepEqual(decodeRead(legacyRead), legacyRead);
  // Null explicitly selects no-auth resource access under upstream policy;
  // it must remain distinguishable from a selected account's opaque link id.
  for (const linkId of [null, "account-link-1"]) {
    const targeted = { ...legacyRead, target: { connectorId: "app-example", linkId } };
    assert.deepEqual(decodeRead(targeted), targeted);
  }
  assert.equal(
    Schema.is(CodexSchema.V2McpResourceReadParams)({
      ...legacyRead,
      target: { linkId: "account-link-1" },
    }),
    false,
  );
  assert.equal(
    Schema.is(CodexSchema.V2McpResourceReadParams)({
      ...legacyRead,
      target: { connectorId: "app-example" },
    }),
    false,
  );
});

it("accepts older plugin summaries while dropping extensions retired in Codex 0.158", () => {
  const decodePlugin = Schema.decodeUnknownSync(CodexSchema.V2PluginListResponse__PluginSummary);
  const legacy = {
    id: "plugin-example",
    name: "Example plugin",
    source: { type: "remote" },
    installed: true,
    enabled: true,
    installPolicy: "AVAILABLE",
    authPolicy: "ON_USE",
  } as const;
  assert.deepEqual(decodePlugin(legacy), legacy);
  assert.deepEqual(decodePlugin({ ...legacy, extensions: null }), legacy);
  const entrypoint = {
    type: "file",
    appId: "app-example",
    toolName: "read_preview",
    title: "Preview",
    resourceUri: "ui://example/preview",
    icons: [],
    extensions: [".txt"],
  } as const;
  const extensions = {
    entrypoints: null,
    settingsEntrypoints: [],
    settings: [],
    threadEntrypoints: [],
    fileHandlers: [entrypoint],
    searchMentionProviders: [],
  };
  // Installed older runtimes may still send this now-retired field. Keep the
  // supported summary usable, but do not preserve obsolete tool arguments,
  // resource locations, or extension metadata beyond the generated boundary.
  assert.deepEqual(decodePlugin({ ...legacy, extensions }), legacy);
});

it("preserves Codex 0.156 image alternatives and their shared discriminant", () => {
  // Upstream's anyOf image locator is intersected with sibling type/detail
  // properties. Generation must not lose those siblings or require both the
  // legacy URL and new file-id locator when reading resumed native history.
  for (const locator of [{ url: "https://example.invalid/image.png" }, { fileId: "file-1" }]) {
    const input = { type: "image", detail: "high", ...locator } as const;
    assert.deepEqual(decodeTurnUserInput(input), input);
    assert.equal(isTurnUserInput(locator), false);
    assert.equal(isTurnUserInput({ ...input, type: "unknown" }), false);
  }
  for (const locator of [
    { image_url: "https://example.invalid/image.png" },
    { file_id: "file-1" },
  ]) {
    const content = { type: "input_image", detail: "high", ...locator } as const;
    assert.deepEqual(decodeResumeContent(content), content);
    assert.equal(isResumeContent(locator), false);
  }
  assert.equal(isTurnUserInput({ type: "image", detail: "high" }), false);
  assert.equal(isTurnUserInput({ type: "image", fileId: 42 }), false);
  assert.equal(isResumeContent({ type: "input_image" }), false);
});

it("accepts Codex 0.156 nullable model access metadata and older catalogs", () => {
  const legacy = {
    id: "gpt-6-astra",
    model: "gpt-6-astra",
    displayName: "GPT-6 Astra",
    description: "A coding model",
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [],
  } as const;
  assert.deepEqual(decodeCatalogModel(legacy), legacy);
  assert.deepEqual(decodeCatalogModel({ ...legacy, availableAccessPrograms: null }), {
    ...legacy,
    availableAccessPrograms: null,
  });
  // Removed upstream operations must not remain advertised by generated RPC
  // metadata. The runtime's explicit legacy rewind adapter is separate.
  assert.equal("thread/rollback" in CodexSchema.CLIENT_REQUEST_METHODS, false);
  assert.equal(CodexSchema.CLIENT_REQUEST_METHODS["thread/revert"], "thread/revert");
});

it("tracks Codex 0.146 app-server compatibility additions", () => {
  assert.equal(
    CodexSchema.CLIENT_REQUEST_METHODS["externalAgentConfig/import/recordHistory"],
    "externalAgentConfig/import/recordHistory",
  );
  assert.equal(isAccountRateLimitPlanType("ent26"), true);
  assert.equal(
    isThreadMetadataUpdateParams({
      threadId: "thread-1",
      isPinned: true,
    }),
    true,
  );
  assert.equal(
    isItemStartedNotification({
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: 1_721_234_567_890,
      item: {
        type: "commandExecution",
        id: "command-1",
        command: "node scripts/check.mjs",
        commandActions: [],
        cwd: "/workspace",
        status: "inProgress",
        pluginId: "openai/example",
        scriptPath: "scripts/check.mjs",
      },
    }),
    true,
  );
});

it("tracks Codex 0.152 auth recovery and shell-command timeout additions", () => {
  const started = {
    method: "modelProvider/authRecoveryStarted" as const,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      provider: "example-provider",
      message: "Refreshing credentials.",
    },
  };
  const completed = {
    method: "modelProvider/authRecoveryCompleted" as const,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      provider: "example-provider",
      message: "Credentials refreshed.",
    },
  };

  assert.deepEqual(decodeServerNotification(started), started);
  assert.deepEqual(decodeServerNotification(completed), completed);
  assert.deepEqual(
    decodeThreadShellCommandParams({
      threadId: "thread-1",
      command: "printf ready",
      timeoutMs: 2_500,
    }),
    {
      threadId: "thread-1",
      command: "printf ready",
      timeoutMs: 2_500,
    },
  );
});

it("keeps Codex 0.154 usage-read capabilities optional without accepting null flags", () => {
  const isUsageRead = Schema.is(CodexSchema.CLIENT_REQUEST_PARAMS["account/rateLimits/read"]);

  // The generated nullable wrapper is a schema-file convention, not the
  // public TypeScript RPC input: callers may omit the object, but must provide
  // actual booleans when explicitly declaring a supported client capability.
  assert.equal(isUsageRead(undefined), true);
  assert.equal(isUsageRead({}), true);
  assert.equal(isUsageRead({ supportsLunaReserve: false, excludeResetCreditDetails: true }), true);
  assert.equal(isUsageRead(null), false);
  assert.equal(isUsageRead({ supportsLunaReserve: "true" }), false);
  assert.equal(isUsageRead({ excludeResetCreditDetails: null }), false);
});

it("decodes Codex 0.154 reasoning controls without broadening conversation input", () => {
  const decodeHistoryItem = Schema.decodeUnknownSync(
    CodexSchema.V2ThreadResumeParams__ResponseItem,
  );
  const control = { type: "configuration_update", reasoning: { effort: "high" } } as const;
  assert.deepEqual(decodeHistoryItem(control), control);

  // Upstream defines this as a durable history control rather than ordinary
  // user input or a terminal item. Keep incomplete controls out of the history
  // schema, and never admit them to Cafe's normal turn input union.
  assert.equal(
    Schema.is(CodexSchema.V2ThreadResumeParams__ResponseItem)({ type: "configuration_update" }),
    false,
  );
  assert.equal(Schema.is(CodexSchema.V2TurnStartParams__UserInput)(control), false);
});

it("distinguishes Codex 0.154 MCP tool-discovery failure from an empty or older catalog", () => {
  const decodeStatus = Schema.decodeUnknownSync(
    CodexSchema.V2ListMcpServerStatusResponse__McpServerStatus,
  );
  const legacy = {
    name: "test-server",
    tools: {},
    resources: [],
    resourceTemplates: [],
    authStatus: "unknown" as const,
  };

  // A failed discovery and an intentionally empty inventory both have zero
  // tools. Preserve the explicit failure field, including null on a healthy
  // catalog, while accepting installed CLIs that predate the added field.
  assert.deepEqual(decodeStatus(legacy), legacy);
  assert.deepEqual(decodeStatus({ ...legacy, toolsError: null }), {
    ...legacy,
    toolsError: null,
  });
  assert.deepEqual(decodeStatus({ ...legacy, toolsError: "Tool discovery failed." }), {
    ...legacy,
    toolsError: "Tool discovery failed.",
  });
});

it("decodes Codex 0.155 stored-attachment metadata without making it conversation input", () => {
  const notification = {
    method: "thread/attachment/updated" as const,
    params: {
      threadId: "thread-1",
      attachmentId: "attachment-1",
      attachmentType: "document",
      identityKey: "document-1",
      operation: "created" as const,
    },
  };

  // These records belong to the provider's independent attachment store. A
  // decoded metadata update is neither a prompt nor proof of file delivery;
  // Cafe's attachment authorization and turn input remain separate surfaces.
  assert.deepEqual(decodeServerNotification(notification), notification);
  assert.deepEqual(
    decodeServerNotification({
      ...notification,
      params: { ...notification.params, operation: "deleted" },
    }),
    { ...notification, params: { ...notification.params, operation: "deleted" } },
  );
  assert.equal(
    Schema.is(CodexSchema.V2ThreadAttachmentUpdatedNotification)({
      ...notification.params,
      operation: "updated",
    }),
    false,
  );
  assert.equal(Schema.is(CodexSchema.V2TurnStartParams__UserInput)(notification.params), false);
  assert.equal(
    Schema.is(CodexSchema.V2ThreadAttachmentListParams)({ threadId: "thread-1", limit: -1 }),
    false,
  );
});

it("preserves optional Codex 0.155 feedback prompt hashes and older responses", () => {
  const decodeFeedback = Schema.decodeUnknownSync(CodexSchema.V2FeedbackUploadResponse);
  const legacy = { threadId: "thread-1" };
  assert.deepEqual(decodeFeedback(legacy), legacy);
  for (const promptHash of [null, "a".repeat(64)]) {
    assert.deepEqual(decodeFeedback({ ...legacy, promptHash }), { ...legacy, promptHash });
  }
});

it.layer(NodeServices.layer)("effect-codex-app-server protocol", (it) => {
  it.effect(
    "encodes requests without a jsonrpc field and routes inbound requests and notifications",
    () =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

        const notificationDeferred =
          yield* Deferred.make<ReadonlyArray<CodexProtocol.CodexAppServerIncomingNotification>>();
        const requestDeferred =
          yield* Deferred.make<ReadonlyArray<CodexProtocol.CodexAppServerIncomingRequest>>();

        yield* transport.incomingNotifications.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.flatMap((notifications) => Deferred.succeed(notificationDeferred, notifications)),
          Effect.forkScoped,
        );

        yield* transport.incomingRequests.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.flatMap((requests) => Deferred.succeed(requestDeferred, requests)),
          Effect.forkScoped,
        );

        yield* transport.notify("initialized");
        assert.equal(yield* Queue.take(output), '{"method":"initialized"}\n');

        const initializeParams = {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        };

        const pendingInitialize = yield* transport
          .request("initialize", initializeParams)
          .pipe(Effect.forkScoped);
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 1,
          method: "initialize",
          params: initializeParams,
        });

        yield* Queue.offer(
          input,
          encodeJsonl({
            emittedAtMs: 1_721_234_567_890,
            method: "item/agentMessage/delta",
            params: {
              delta: "Hello from the mock peer.",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          }),
        );
        yield* Queue.offer(
          input,
          encodeJsonl({
            id: 77,
            method: "item/tool/requestUserInput",
            params: {
              isBlocking: true,
              itemId: "item-approval-1",
              threadId: "thread-1",
              turnId: "turn-1",
              questions: [
                {
                  id: "approved",
                  header: "Approve",
                  question: "Continue?",
                },
              ],
            },
          }),
        );
        yield* Queue.offer(
          input,
          encodeJsonl({
            id: 1,
            result: {
              userAgent: "mock-codex-app-server",
              codexHome: "/tmp/codex-home",
              platformFamily: "unix",
              platformOs: "macos",
            },
          }),
        );

        assert.deepEqual(yield* Fiber.join(pendingInitialize), {
          userAgent: "mock-codex-app-server",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        });
        assert.deepEqual(yield* Deferred.await(notificationDeferred), [
          {
            emittedAtMs: 1_721_234_567_890,
            method: "item/agentMessage/delta",
            params: {
              delta: "Hello from the mock peer.",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          },
        ]);
        assert.deepEqual(yield* Deferred.await(requestDeferred), [
          {
            id: 77,
            method: "item/tool/requestUserInput",
            params: {
              isBlocking: true,
              itemId: "item-approval-1",
              threadId: "thread-1",
              turnId: "turn-1",
              questions: [
                {
                  id: "approved",
                  header: "Approve",
                  question: "Continue?",
                },
              ],
            },
          },
        ]);

        yield* transport.respond(77, {
          answers: {
            approved: {
              answers: ["yes"],
            },
          },
        });
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 77,
          result: {
            answers: {
              approved: {
                answers: ["yes"],
              },
            },
          },
        });

        yield* transport.respondError(
          78,
          CodexError.CodexAppServerRequestError.methodNotFound("x/test"),
        );
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 78,
          error: {
            code: -32601,
            message: "Method not found: x/test",
          },
        });
      }),
  );

  it.effect("keeps draining inbound messages while an onRequest handler is waiting", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onRequest: () => Effect.never,
      });

      const notificationDeferred =
        yield* Deferred.make<CodexProtocol.CodexAppServerIncomingNotification>();
      yield* transport.incomingNotifications.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.flatMap((notifications) =>
          Deferred.succeed(notificationDeferred, Array.from(notifications)[0]!),
        ),
        Effect.forkScoped,
      );

      const pendingInitialize = yield* transport.request("initialize").pipe(Effect.forkScoped);
      assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
        id: 1,
        method: "initialize",
      });

      yield* Queue.offer(
        input,
        encodeJsonl({
          id: 77,
          method: "item/tool/requestUserInput",
          params: {
            isBlocking: true,
            itemId: "item-approval-1",
            threadId: "thread-1",
            turnId: "turn-1",
            questions: [],
          },
        }),
      );
      yield* Queue.offer(
        input,
        encodeJsonl({
          method: "x/after-blocked-request",
          params: {
            ok: true,
          },
        }),
      );
      yield* Queue.offer(
        input,
        encodeJsonl({
          id: 1,
          result: {
            userAgent: "mock-codex-app-server",
          },
        }),
      );

      assert.deepEqual(yield* Deferred.await(notificationDeferred), {
        method: "x/after-blocked-request",
        params: {
          ok: true,
        },
      });
      assert.deepEqual(yield* Fiber.join(pendingInitialize), {
        userAgent: "mock-codex-app-server",
      });
    }),
  );

  it.effect("keeps draining inbound messages while an onNotification handler is waiting", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onNotification: () => Effect.never,
      });

      const pendingInitialize = yield* transport.request("initialize").pipe(Effect.forkScoped);
      assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
        id: 1,
        method: "initialize",
      });

      yield* Queue.offer(
        input,
        encodeJsonl({
          method: "x/blocked-notification",
          params: {
            ok: true,
          },
        }),
      );
      yield* Queue.offer(
        input,
        encodeJsonl({
          id: 1,
          result: {
            userAgent: "mock-codex-app-server",
          },
        }),
      );

      const result = yield* Fiber.join(pendingInitialize).pipe(Effect.timeoutOption("1 second"));
      assert.equal(Option.isSome(result), true);
      if (Option.isSome(result)) {
        assert.deepEqual(result.value, {
          userAgent: "mock-codex-app-server",
        });
      }
    }),
  );

  it.effect("surfaces JSON encoding failures as protocol parse errors", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

      const bigintError = yield* transport.notify("x/test", 1n).pipe(Effect.flip);
      assert.instanceOf(bigintError, CodexError.CodexAppServerProtocolParseError);
      assert.equal(bigintError.detail, "Failed to encode Codex App Server message");

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const circularError = yield* transport.notify("x/test", circular).pipe(Effect.flip);
      assert.instanceOf(circularError, CodexError.CodexAppServerProtocolParseError);
      assert.equal(circularError.detail, "Failed to encode Codex App Server message");
    }),
  );

  it.effect("fails pending requests when one fragmented incoming line exceeds the byte cap", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        maxIncomingLineBytes: 32,
      });

      const pending = yield* transport.request("x/read").pipe(Effect.forkScoped);
      yield* Queue.take(output);

      // Neither source chunk is individually large. The reader must account
      // for the retained prefix incrementally instead of waiting for a newline
      // and building an attacker-controlled string without a bound.
      yield* Queue.offer(input, encoder.encode('{"id":1,"result":"'));
      yield* Queue.offer(input, encoder.encode("private-wire-sentinel-that-must-not-leak"));

      const error = yield* Fiber.join(pending).pipe(Effect.flip);
      assert.instanceOf(error, CodexError.CodexAppServerIncomingMessageTooLargeError);
      if (error instanceof CodexError.CodexAppServerIncomingMessageTooLargeError) {
        assert.equal(error.maxBytes, 32);
      }
      assert.equal(String(error).includes("private-wire-sentinel"), false);
      assert.equal(JSON.stringify(error).includes("private-wire-sentinel"), false);
    }),
  );

  it.effect("counts fragmented multibyte input in UTF-8 bytes and accepts the exact cap", () =>
    Effect.gen(function* () {
      const wire = encodeJsonl({ id: 1, result: "🙂" });
      const lineBytes = wire.byteLength - 1;
      const emojiStart = wire.findIndex((byte) => byte === 0xf0);
      assert.notEqual(emojiStart, -1);

      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        maxIncomingLineBytes: lineBytes,
      });
      const pending = yield* transport.request("x/read").pipe(Effect.forkScoped);
      yield* Queue.take(output);

      // Split inside the four-byte scalar. Stream.decodeText must preserve it,
      // while the protocol cap must measure the reconstructed UTF-8 line.
      const splitAt = emojiStart + 2;
      yield* Queue.offer(input, wire.slice(0, splitAt));
      yield* Queue.offer(input, wire.slice(splitAt));

      assert.equal(yield* Fiber.join(pending), "🙂");
    }),
  );

  it.effect(
    "counts exact raw bytes across responses and fails later requests after exhaustion",
    () =>
      Effect.gen(function* () {
        const wire = encodeJsonl({ id: 1, result: "🙂" });
        const emojiStart = wire.findIndex((byte) => byte === 0xf0);
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const terminated = yield* Deferred.make<CodexError.CodexAppServerError>();
        const outgoing: unknown[] = [];
        const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
          stdio,
          maxIncomingBytes: wire.byteLength,
          logOutgoing: true,
          logger: (event) =>
            Effect.sync(() => {
              if (event.direction === "outgoing") outgoing.push(event);
            }),
          onTermination: (error) => Deferred.succeed(terminated, error).pipe(Effect.asVoid),
        });
        const first = yield* transport.request("x/read").pipe(Effect.forkScoped);
        yield* Queue.take(output);
        // Raw bytes include the newline; split inside a UTF-8 scalar to prove
        // this accounting does not depend on decoder chunk boundaries.
        yield* Queue.offer(input, wire.slice(0, emojiStart + 2));
        yield* Queue.offer(input, wire.slice(emojiStart + 2));
        assert.equal(yield* Fiber.join(first), "🙂");
        yield* Queue.offer(input, encoder.encode(" "));
        const error = yield* Deferred.await(terminated);
        assert.instanceOf(error, CodexError.CodexAppServerIncomingBudgetExceededError);
        assert.equal(error.message.includes(String(wire.byteLength)), true);
        // There was no pending request when the budget was exhausted. Registering
        // one now must replay the finite transport failure, not wait forever on
        // an outgoing queue whose false offer result was previously discarded.
        const late = yield* transport.request("x/next-page").pipe(Effect.flip);
        assert.equal(late, error);
        assert.equal(outgoing.length, 2);
        assert.equal(JSON.stringify(outgoing).includes("x/next-page"), false);
      }),
  );

  it.effect("retains a valid acknowledged response when stdout immediately closes", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const terminated = yield* Deferred.make<void>();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onTermination: () => Deferred.succeed(terminated, undefined).pipe(Effect.asVoid),
      });
      const pending = yield* transport.request("x/read").pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.offer(input, encodeJsonl({ id: 1, result: "acknowledged" }));
      yield* Queue.end(input);
      yield* Deferred.await(terminated);
      assert.equal(yield* Fiber.join(pending), "acknowledged");
    }),
  );

  it.effect("bounds blank and malformed input before decoding or logging it", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const logs: CodexProtocol.CodexAppServerProtocolLogEvent[] = [];
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        maxIncomingBytes: 9,
        logIncoming: true,
        logger: (event) => Effect.sync(() => logs.push(event)).pipe(Effect.asVoid),
      });
      const pending = yield* transport.request("x/read").pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.offer(input, encoder.encode(" \n \n \n"));
      yield* Queue.offer(input, encoder.encode("PRIVATE_INVALID_JSON"));
      const error = yield* Fiber.join(pending).pipe(Effect.flip);
      assert.instanceOf(error, CodexError.CodexAppServerIncomingBudgetExceededError);
      assert.equal(JSON.stringify([logs, error]).includes("PRIVATE_INVALID_JSON"), false);
    }),
  );

  it.effect("counts malformed UTF-8 source bytes rather than replacement text", () =>
    Effect.gen(function* () {
      const wire = Buffer.concat([
        Buffer.from('{"id":1,"result":"'),
        Buffer.from([0xff]),
        Buffer.from('"}\n'),
      ]);
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        maxIncomingBytes: wire.byteLength,
      });
      const pending = yield* transport.request("x/read").pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.offer(input, wire);
      assert.equal(yield* Fiber.join(pending), "�");
    }),
  );

  it.effect("fails closed for an invalid configured total input budget", () =>
    Effect.gen(function* () {
      for (const maxIncomingBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { stdio, input, output } = yield* makeInMemoryStdio();
            const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
              stdio,
              maxIncomingBytes,
            });
            const pending = yield* transport.request("x/read").pipe(Effect.forkScoped);
            yield* Queue.take(output);
            yield* Queue.offer(input, encodeJsonl({ id: 1, result: null }));
            const error = yield* Fiber.join(pending).pipe(Effect.flip);
            assert.instanceOf(error, CodexError.CodexAppServerIncomingBudgetExceededError);
            if (error instanceof CodexError.CodexAppServerIncomingBudgetExceededError) {
              assert.equal(error.maxBytes, 1);
            }
          }),
        );
      }
    }),
  );

  it.effect("retires a request held in outgoing logging when input is exhausted", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const held = yield* Deferred.make<void>();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        maxIncomingBytes: 1,
        logOutgoing: true,
        logger: (event) =>
          event.direction === "outgoing"
            ? Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
      });
      const pending = yield* transport.request("x/read").pipe(Effect.forkScoped);
      yield* Deferred.await(held);
      yield* Queue.offer(input, encoder.encode(" \n"));
      const error = yield* Fiber.join(pending).pipe(Effect.flip);
      assert.instanceOf(error, CodexError.CodexAppServerIncomingBudgetExceededError);
    }),
  );

  it.effect("keeps reading notifications after onNotification defects", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const protocolEvents = yield* Ref.make<Array<CodexProtocol.CodexAppServerProtocolLogEvent>>(
        [],
      );
      const goodNotification =
        yield* Deferred.make<CodexProtocol.CodexAppServerIncomingNotification>();
      const badDiagnosticLogged = yield* Deferred.make<void>();

      yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        logger: (event) =>
          Ref.update(protocolEvents, (current) => [...current, event]).pipe(
            Effect.andThen(() => {
              const payload =
                typeof event.payload === "object" && event.payload !== null
                  ? (event.payload as Record<string, unknown>)
                  : {};
              return event.stage === "decode_failed" && payload["method"] === "x/bad"
                ? Deferred.succeed(badDiagnosticLogged, undefined).pipe(Effect.asVoid)
                : Effect.void;
            }),
          ),
        onNotification: (notification) =>
          notification.method === "x/bad"
            ? Effect.die(new Error("defective notification callback"))
            : Deferred.succeed(goodNotification, notification).pipe(Effect.asVoid),
      });

      yield* Queue.offer(
        input,
        encodeJsonl({
          method: "x/bad",
          params: {
            secret: "must-not-be-logged",
          },
        }),
      );
      yield* Queue.offer(
        input,
        encodeJsonl({
          method: "x/good",
          params: {
            ok: true,
          },
        }),
      );

      assert.deepEqual(yield* Deferred.await(goodNotification), {
        method: "x/good",
        params: {
          ok: true,
        },
      });
      yield* Deferred.await(badDiagnosticLogged);

      const diagnostics = (yield* Ref.get(protocolEvents)).filter(
        (event) => event.stage === "decode_failed",
      );
      assert.equal(diagnostics.length, 1);
      const diagnosticPayload = diagnostics[0]?.payload as Record<string, unknown>;
      assert.equal(diagnosticPayload["method"], "x/bad");
      assert.equal(String(diagnosticPayload["cause"]).includes("must-not-be-logged"), false);
    }),
  );
});
