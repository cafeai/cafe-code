// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import {
  CommandId,
  MessageId,
  ThreadId,
  RuntimeMode,
  ProviderInteractionMode,
  ModelSelection,
} from "@cafecode/contracts";
import {
  MCP_APP_CONSENT_LIFETIME_MS,
  MCP_APP_MAX_PENDING_CONSENTS,
  type McpAppPrepareInput,
  type McpAppPrepareResult,
  type McpAppResolveInput,
} from "@cafecode/contracts/mcpApps";
import { VisualizationHostInspection } from "@cafecode/contracts/visualizationHost";
import {
  admittedMcpAppLink,
  McpAppProtocolSession,
  mcpAppFailure,
  mcpAppSuccess,
  ownRecord,
  readBoundedMcpAppJson,
  readMcpAppContext,
  type McpAppRequest,
} from "@cafecode/shared/mcpAppProtocol";
import { requestProviderDaemonJson } from "@cafecode/shared/providerDaemonHttp";
import {
  encodeBoundedMcpAppTransportJson,
  MCP_APP_JSON_MAX_TRANSPORT_BYTES,
  readBoundedMcpAppTransportJson,
} from "@cafecode/shared/mcpAppJson";
import { validateMcpAppToolArguments } from "@cafecode/shared/mcpAppToolSchema";
import {
  readVisualizationHost,
  requestVisualizationHost,
} from "@cafecode/shared/visualizationHostClient";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { VisualizationArtifacts } from "../visualizations/service.ts";
import { visualizationDenied } from "../visualizations/sessionRuntime.ts";
import type { VisualizationApiError } from "@cafecode/contracts/visualizationApi";
import {
  dispatchMcpAppOwnerOperation,
  MCP_APP_OWNER_PATH,
  type McpAppOwnerOperation,
} from "./owner.ts";

const parse = (text: string) => {
  const value = readBoundedMcpAppJson(text);
  return value.ok ? ownRecord(value.value) : undefined;
};
const failureReply = (request: McpAppRequest) =>
  mcpAppFailure(request.id ?? null, -32000, "Operation unavailable");
const identity = (input: McpAppPrepareInput) =>
  JSON.stringify([input.threadId, input.artifactId, input.revisionId, input.leaseId]);
const isRuntimeMode = Schema.is(RuntimeMode);
const isInteractionMode = Schema.is(ProviderInteractionMode);
const decodeModelSelection = Schema.decodeUnknownResult(ModelSelection);
type Session = {
  input: McpAppPrepareInput;
  documentGeneration: string;
  protocol: McpAppProtocolSession;
  owner: Omit<McpAppOwnerOperation, "method" | "requestJson">;
  expiresAt: number;
};
type Pending = { session: Session; request: McpAppRequest; expiresAt: number };

/** No arbitrary proxy: this scoped broker uses only an immutable artifact's
 * captured native owner, the actual live Electron document and a current native
 * catalogue. All consequential operations are one-use, separately approved.
 * Refusal never returns a received provider error, HTML or decoder issue. */
export const makeMcpAppsService = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const artifacts = yield* VisualizationArtifacts;
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const sessions = new Map<string, Session>();
  const pending = new Map<string, Pending>();
  const ownerOperation = (
    session: Session,
    method: McpAppOwnerOperation["method"],
    requestJson: string,
  ) =>
    Effect.tryPromise({
      try: async (signal) => {
        const input = { ...session.owner, method, requestJson };
        const endpoint = config.providerDaemon ?? config.providerSupervisor;
        if (!endpoint) return dispatchMcpAppOwnerOperation(input);
        // The private relay wraps an already bounded App JSON string. Count
        // that escaped outer envelope independently; the larger wire allowance
        // never grants a larger native App message or parser-work budget.
        const body = encodeBoundedMcpAppTransportJson(input);
        if (!body) throw visualizationDenied();
        const reply = await requestProviderDaemonJson(endpoint, MCP_APP_OWNER_PATH, {
          method: "POST",
          body,
          timeoutMs: 10_000,
          maxResponseBytes: MCP_APP_JSON_MAX_TRANSPORT_BYTES,
          signal,
        });
        if (reply.statusCode !== 200) throw visualizationDenied();
        const envelope = readBoundedMcpAppTransportJson(reply.body);
        const json = envelope.ok ? ownRecord(envelope.value)?.json : undefined;
        if (typeof json !== "string" || !readBoundedMcpAppJson(json).ok)
          throw visualizationDenied();
        return json;
      },
      catch: () => visualizationDenied(),
    });
  const inspect = (input: McpAppPrepareInput, allowSuspended = false) =>
    Effect.gen(function* () {
      const ledger = yield* artifacts.readViewerTicket(input, input.ticket);
      const connection = yield* Effect.tryPromise({
        try: () => readVisualizationHost(config.stateDir),
        catch: () => visualizationDenied(),
      });
      if (!connection || connection.generation !== ledger.hostGeneration)
        return yield* visualizationDenied();
      const response = yield* Effect.tryPromise({
        try: () =>
          requestVisualizationHost(connection, "inspectViewer", {
            ticket: input.ticket,
            leaseId: input.leaseId,
          }),
        catch: () => visualizationDenied(),
      });
      const observed = Schema.decodeUnknownResult(VisualizationHostInspection)(response);
      if (
        Result.isFailure(observed) ||
        observed.success.leaseId !== input.leaseId ||
        // Visibility-owned generated documents never acquire external App
        // action authority through a nullable inspection lifetime.
        observed.success.expiresAtMs === null ||
        observed.success.expiresAtMs <= Date.now() ||
        (!allowSuspended && observed.success.state !== "active")
      )
        return yield* visualizationDenied();
      // Carry the positively narrowed finite App lifetime in the returned
      // value; a nullable generated inspection cannot enter Session expiry.
      return { ...observed.success, expiresAtMs: observed.success.expiresAtMs };
    });
  const alive = (session: Session, allowSuspended = false) =>
    inspect(session.input, allowSuspended).pipe(
      Effect.flatMap((observed) =>
        observed.documentGeneration === session.documentGeneration && Date.now() < session.expiresAt
          ? Effect.void
          : Effect.fail(visualizationDenied()),
      ),
    );
  const sweep = () => {
    const now = Date.now();
    for (const [key, session] of sessions)
      if (session.expiresAt <= now) {
        session.protocol.close();
        sessions.delete(key);
      }
    for (const [id, operation] of pending) if (operation.expiresAt <= now) pending.delete(id);
  };
  const catalogue = (session: Session) =>
    ownerOperation(session, "catalog", "{}").pipe(
      Effect.flatMap((json) => {
        const data = parse(json);
        const rows = Array.isArray(data?.data) ? data.data : undefined;
        const server = rows?.length === 1 ? ownRecord(rows[0]) : undefined;
        return server?.name === session.owner.serverName && data?.nextCursor == null
          ? Effect.succeed(server)
          : Effect.fail(visualizationDenied());
      }),
    );
  const prepare = (
    input: McpAppPrepareInput,
  ): Effect.Effect<McpAppPrepareResult, VisualizationApiError> =>
    Effect.gen(function* () {
      sweep();
      const observed = yield* inspect(input);
      let session = sessions.get(identity(input));
      if (session && session.documentGeneration !== observed.documentGeneration) {
        session.protocol.close();
        sessions.delete(identity(input));
        session = undefined;
      }
      if (!session) {
        if (sessions.size >= 128) return yield* visualizationDenied();
        const row = yield* artifacts.readMcpAppSnapshot(input);
        if (row.kind !== "mcp-app") return yield* visualizationDenied();
        const privateData = JSON.parse(row.privateJson) as unknown;
        const data = ownRecord(privateData);
        const snapshot = ownRecord(data?.input);
        const witness = ownRecord(data?.witness);
        if (
          !snapshot ||
          !witness ||
          witness.provider !== "codex" ||
          witness.threadId !== input.threadId ||
          typeof snapshot.originalInputJson !== "string" ||
          typeof snapshot.originalResultJson !== "string" ||
          typeof witness.providerInstanceId !== "string" ||
          typeof witness.sessionGeneration !== "string" ||
          typeof witness.nativeThreadId !== "string" ||
          typeof snapshot.serverName !== "string" ||
          typeof snapshot.originCallId !== "string"
        )
          return yield* visualizationDenied();
        session = {
          input,
          documentGeneration: observed.documentGeneration,
          expiresAt: observed.expiresAtMs,
          owner: {
            threadId: input.threadId,
            providerInstanceId: witness.providerInstanceId,
            sessionGeneration: witness.sessionGeneration,
            nativeThreadId: witness.nativeThreadId,
            serverName: snapshot.serverName,
            originCallId: snapshot.originCallId,
          },
          protocol: new McpAppProtocolSession(
            { displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] },
            snapshot.originalInputJson,
            snapshot.originalResultJson,
          ),
        };
        sessions.set(identity(input), session);
      }
      const outcome = session.protocol.receive(input.requestJson);
      if (outcome.kind === "messages")
        return {
          kind: "reply" as const,
          json: outcome.messages[0] ?? "",
          ...(outcome.messages.length > 1 ? { messages: outcome.messages.slice(1) } : {}),
        };
      if (outcome.kind === "display")
        return {
          kind: "reply" as const,
          json: mcpAppSuccess(outcome.id, { mode: outcome.mode }),
          displayMode: outcome.mode,
        };
      const request = outcome.request;
      const params = request.params;
      if (request.method === "ui/update-model-context") {
        const context = readMcpAppContext(params);
        if (context === undefined) return { kind: "reply" as const, json: failureReply(request) };
        // The owner updates a replace-only untrusted snapshot, never a system
        // instruction or an implicit turn. Native generation is checked again.
        yield* alive(session);
        yield* ownerOperation(session, "context", JSON.stringify({ json: context }));
        return { kind: "reply" as const, json: mcpAppSuccess(request.id!, {}) };
      }
      if (
        !["tools/call", "resources/read", "ui/message", "ui/open-link"].includes(request.method) ||
        pending.size >= MCP_APP_MAX_PENDING_CONSENTS
      )
        return { kind: "reply" as const, json: failureReply(request) };
      let name: string | undefined;
      if (request.method === "tools/call" || request.method === "resources/read") {
        const server = yield* catalogue(session);
        if (request.method === "tools/call") {
          const tool =
            typeof params?.name === "string"
              ? ownRecord(ownRecord(server.tools)?.[params.name])
              : undefined;
          const visibility = ownRecord(ownRecord(tool?._meta)?.ui)?.visibility;
          const args = params?.arguments;
          if (
            !tool ||
            !Array.isArray(visibility) ||
            !visibility.includes("app") ||
            !ownRecord(args) ||
            !validateMcpAppToolArguments(tool.inputSchema, args)
          )
            return { kind: "reply" as const, json: failureReply(request) };
          name = "MCP tool";
        } else {
          const uri = params?.uri;
          if (
            typeof uri !== "string" ||
            uri.length > 2048 ||
            !Array.isArray(server.resources) ||
            !server.resources.some((entry) => ownRecord(entry)?.uri === uri)
          )
            return { kind: "reply" as const, json: failureReply(request) };
          name = "MCP resource";
        }
      } else if (request.method === "ui/open-link") {
        if (!admittedMcpAppLink(params?.url))
          return { kind: "reply" as const, json: failureReply(request) };
      } else if (
        params?.role !== "user" ||
        !Array.isArray(params.content) ||
        params.content.length !== 1 ||
        ownRecord(params.content[0])?.type !== "text" ||
        typeof ownRecord(params.content[0])?.text !== "string"
      )
        return { kind: "reply" as const, json: failureReply(request) };
      yield* alive(session);
      const operationId = randomUUID();
      pending.set(operationId, {
        session,
        request,
        expiresAt: Math.min(Date.now() + MCP_APP_CONSENT_LIFETIME_MS, session.expiresAt),
      });
      return {
        kind: "consent" as const,
        operationId,
        method: request.method as "tools/call" | "resources/read" | "ui/message" | "ui/open-link",
        ...(name ? { name } : {}),
      };
    }).pipe(Effect.mapError(() => visualizationDenied()));
  const resolve = (input: McpAppResolveInput) =>
    Effect.gen(function* () {
      sweep();
      const operation = pending.get(input.operationId);
      if (!operation) return yield* visualizationDenied();
      pending.delete(input.operationId); // one-use BEFORE any async/native side effect
      const { session, request } = operation;
      if (input.decision !== "approve") return { json: failureReply(request) };
      yield* alive(session, true);
      yield* artifacts.readMcpAppSnapshot(session.input);
      const params = request.params!;
      if (request.method === "ui/open-link") {
        const openUrl = admittedMcpAppLink(params.url);
        if (!openUrl) return yield* visualizationDenied();
        yield* catalogue(session);
        yield* alive(session, true);
        return { json: mcpAppSuccess(request.id!, {}), openUrl };
      }
      if (request.method === "ui/message") {
        yield* catalogue(session);
        const rows = yield* sql<{
          runtimeMode: unknown;
          interactionMode: unknown;
          modelSelection: string;
        }>`SELECT runtime_mode AS "runtimeMode",interaction_mode AS "interactionMode",model_selection_json AS "modelSelection" FROM projection_threads WHERE thread_id = ${session.input.threadId} AND deleted_at IS NULL`;
        if (
          rows.length !== 1 ||
          !isRuntimeMode(rows[0]!.runtimeMode) ||
          !isInteractionMode(rows[0]!.interactionMode)
        )
          return yield* visualizationDenied();
        const text = ownRecord((params.content as unknown[])[0])?.text;
        if (typeof text !== "string" || !text.length || Buffer.byteLength(text, "utf8") > 16 * 1024)
          return yield* visualizationDenied();
        const selection = decodeModelSelection(parse(rows[0]!.modelSelection));
        if (
          Result.isFailure(selection) ||
          selection.success.instanceId !== session.owner.providerInstanceId
        )
          return yield* visualizationDenied();
        // Explicitly retain the observed account; the page cannot inherit a
        // different account selected while consent/catalogue I/O was pending.
        yield* alive(session, true);
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`mcp-app-${input.operationId}`),
          threadId: ThreadId.make(session.input.threadId),
          modelSelection: selection.success,
          message: {
            messageId: MessageId.make(`mcp-app-${input.operationId}`),
            role: "user",
            text,
            attachments: [],
          },
          runtimeMode: rows[0]!.runtimeMode,
          interactionMode: rows[0]!.interactionMode,
          createdAt: new Date().toISOString(),
        });
        return { json: mcpAppSuccess(request.id!, {}) };
      }
      // Revalidate the native catalogue at approval; a formerly app-visible tool
      // cannot be used after its visibility/resource membership is revoked.
      const server = yield* catalogue(session);
      if (request.method === "tools/call") {
        const tool = ownRecord(ownRecord(server.tools)?.[String(params.name)]);
        const visibility = ownRecord(ownRecord(tool?._meta)?.ui)?.visibility;
        if (
          !tool ||
          !Array.isArray(visibility) ||
          !visibility.includes("app") ||
          !validateMcpAppToolArguments(tool.inputSchema, params.arguments)
        )
          return yield* visualizationDenied();
      } else if (
        !Array.isArray(server.resources) ||
        !server.resources.some((entry) => ownRecord(entry)?.uri === params.uri)
      )
        return yield* visualizationDenied();
      // Every asynchronous catalogue/SQL read above can outlive the native
      // document. Re-observe immediately before dispatch, not only afterwards.
      yield* alive(session, true);
      const json = yield* ownerOperation(
        session,
        request.method === "tools/call" ? "tool" : "resource",
        JSON.stringify(params),
      );
      yield* alive(session, true);
      const reply = mcpAppSuccess(request.id!, JSON.parse(json));
      if (!readBoundedMcpAppJson(reply).ok) return yield* visualizationDenied();
      return { json: reply };
    }).pipe(Effect.mapError(() => visualizationDenied()));
  const details = (input: { operationId: string }) =>
    Effect.gen(function* () {
      sweep();
      const operation = pending.get(input.operationId);
      if (!operation) return yield* visualizationDenied();
      yield* alive(operation.session, true);
      return { json: JSON.stringify(operation.request) };
    }).pipe(Effect.mapError(() => visualizationDenied()));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const session of sessions.values()) session.protocol.close();
      sessions.clear();
      pending.clear();
    }),
  );
  return { prepare, resolve, details };
});
