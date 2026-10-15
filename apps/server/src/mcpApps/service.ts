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
  owner: Omit<McpAppOwnerOperation, "method" | "requestJson" | "consentExpiresAtMs">;
  expiresAt: number;
};
type Pending = { session: Session; request: McpAppRequest; expiresAt: number };

/** No arbitrary proxy: this scoped broker uses an immutable artifact's
 * configured provider owner, a current Full-access browser-frame grant and a
 * current provider catalogue. Consequential operations remain one-use and
 * separately approved. A frame grant is not native execution containment.
 * Refusal never returns a received provider error, HTML or decoder issue. */
export const makeMcpAppsService = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const artifacts = yield* VisualizationArtifacts;
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const sessions = new Map<string, Session>();
  const pending = new Map<string, Pending>();
  // The UI channel serializes SDK messages, but Full-access callers can also
  // reach RPC directly. Independently refuse overlapping frame preparations
  // before asynchronous source/catalogue reads, with no retained waiter queue.
  const preparing = new Set<string>();
  const ownerOperation = (
    session: Session,
    method: McpAppOwnerOperation["method"],
    requestJson: string,
    consentDeadline?: number,
  ) =>
    Effect.tryPromise({
      try: async (signal) => {
        if (consentDeadline !== undefined && Date.now() >= consentDeadline)
          throw visualizationDenied();
        const input = {
          ...session.owner,
          method,
          requestJson,
          ...(consentDeadline === undefined ? {} : { consentExpiresAtMs: consentDeadline }),
        };
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
  // The browser owns visible frame lifetime. This exact short-lived action
  // grant is server-owned and separately rechecks persisted Full access on
  // every operation. It neither proves an OS process nor pauses arbitrary JS.
  const inspect = (input: McpAppPrepareInput, _allowSuspended = false) =>
    artifacts.readInlineFrame(input);
  const alive = (session: Session, allowSuspended = false) =>
    inspect(session.input, allowSuspended).pipe(
      Effect.flatMap((observed) => {
        if (observed.documentGeneration !== session.documentGeneration)
          return Effect.fail(visualizationDenied());
        // Refresh only from the exact current server grant, never from page
        // timestamps or a consent request. Pending approvals retain their own
        // finite spending deadline and are not renewed by a healthy heartbeat.
        session.expiresAt = observed.expiresAtMs;
        return Effect.void;
      }),
    );
  const sweep = () => {
    const now = Date.now();
    for (const [key, session] of sessions) {
      // Heartbeat refresh is owned by the exact frame grant, not by App traffic
      // or pending consent. A healthy idle App retains its initialized protocol
      // while stale/removed frames release bounded metadata without SQL scans.
      const deadline = artifacts.inlineFrameDeadline(session.input);
      if (deadline === undefined || deadline <= now) {
        session.protocol.close();
        sessions.delete(key);
      } else session.expiresAt = deadline;
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
    requestInput: McpAppPrepareInput,
  ): Effect.Effect<McpAppPrepareResult, VisualizationApiError> =>
    Effect.suspend(() => {
      // Retain only the exact admitted wire scalars. Snapshot/catalogue awaits
      // must not let an injected caller mutate a retained frame identity or its
      // request into a replacement artifact while admission is in flight.
      const input: McpAppPrepareInput = {
        threadId: requestInput.threadId,
        artifactId: requestInput.artifactId,
        revisionId: requestInput.revisionId,
        leaseId: requestInput.leaseId,
        ticket: requestInput.ticket,
        requestJson: requestInput.requestJson,
      };
      const key = identity(input);
      if (preparing.has(key) || preparing.size >= 128) return Effect.fail(visualizationDenied());
      preparing.add(key);
      return Effect.gen(function* () {
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
          // Snapshot I/O can outlive this frame, its exact owner policy, or an
          // available session slot. Reinspect the original exact grant before
          // constructing a protocol, then check the final cap synchronously:
          // no await may separate this admission from sessions.set below.
          const currentFrame = yield* inspect(input);
          if (
            currentFrame.documentGeneration !== observed.documentGeneration ||
            Date.now() >= currentFrame.expiresAtMs ||
            sessions.size >= 128
          )
            return yield* visualizationDenied();
          session = {
            input,
            documentGeneration: currentFrame.documentGeneration,
            expiresAt: currentFrame.expiresAtMs,
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
          sessions.set(key, session);
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
          !["tools/call", "resources/read", "ui/message", "ui/open-link"].includes(
            request.method,
          ) ||
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
        // Different frames can complete asynchronous catalogue/grant admission
        // concurrently. Recheck at the synchronous mint-and-insert boundary, with
        // no await between this check and pending.set, so the eight-consent limit
        // cannot be oversubscribed by requests that observed an earlier size.
        if (pending.size >= MCP_APP_MAX_PENDING_CONSENTS)
          return { kind: "reply" as const, json: failureReply(request) };
        const operationId = randomUUID();
        const expiresAtMs = Math.min(Date.now() + MCP_APP_CONSENT_LIFETIME_MS, session.expiresAt);
        pending.set(operationId, {
          session,
          request,
          expiresAt: expiresAtMs,
        });
        return {
          kind: "consent" as const,
          operationId,
          expiresAtMs,
          method: request.method as "tools/call" | "resources/read" | "ui/message" | "ui/open-link",
          ...(name ? { name } : {}),
        };
      }).pipe(
        Effect.ensuring(Effect.sync(() => preparing.delete(key))),
        Effect.mapError(() => visualizationDenied()),
      );
    });
  const resolve = (input: McpAppResolveInput) =>
    Effect.gen(function* () {
      sweep();
      const operation = pending.get(input.operationId);
      if (!operation) return yield* visualizationDenied();
      pending.delete(input.operationId); // one-use BEFORE any async/native side effect
      const { session, request } = operation;
      const unexpired = Effect.suspend(() =>
        Date.now() < operation.expiresAt ? Effect.void : Effect.fail(visualizationDenied()),
      );
      if (input.decision !== "approve") return { json: failureReply(request) };
      yield* alive(session, true);
      yield* artifacts.readMcpAppSnapshot(session.input);
      const params = request.params!;
      if (request.method === "ui/open-link") {
        const openUrl = admittedMcpAppLink(params.url);
        if (!openUrl) return yield* visualizationDenied();
        yield* catalogue(session);
        yield* alive(session, true);
        yield* unexpired;
        return { json: mcpAppSuccess(request.id!, {}), openUrl };
      }
      if (request.method === "ui/message") {
        yield* catalogue(session);
        const rows = yield* sql<{
          runtimeMode: unknown;
          interactionMode: unknown;
          modelSelection: string;
        }>`SELECT runtime_mode AS "runtimeMode",interaction_mode AS "interactionMode",model_selection_json AS "modelSelection" FROM projection_threads WHERE thread_id = ${session.input.threadId} AND deleted_at IS NULL`;
        const row = rows[0];
        if (rows.length !== 1 || !row) return yield* visualizationDenied();
        // Snapshot and validate exact scalar policy before crossing another
        // asynchronous boundary. A row property typed as unknown must not be
        // trusted by a later dispatch closure, and a restricted observation
        // cannot spend a Full-access-only App message consent.
        const { runtimeMode, interactionMode, modelSelection } = row;
        if (
          !isRuntimeMode(runtimeMode) ||
          runtimeMode !== "full-access" ||
          !isInteractionMode(interactionMode)
        )
          return yield* visualizationDenied();
        const text = ownRecord((params.content as unknown[])[0])?.text;
        if (typeof text !== "string" || !text.length || Buffer.byteLength(text, "utf8") > 16 * 1024)
          return yield* visualizationDenied();
        const selection = decodeModelSelection(parse(modelSelection));
        if (
          Result.isFailure(selection) ||
          selection.success.instanceId !== session.owner.providerInstanceId
        )
          return yield* visualizationDenied();
        // Explicitly retain the observed account; the page cannot inherit a
        // different account selected while consent/catalogue I/O was pending.
        yield* alive(session, true);
        yield* Effect.suspend(() =>
          Date.now() >= operation.expiresAt
            ? Effect.fail(visualizationDenied())
            : engine
                .dispatch({
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
                  runtimeMode,
                  interactionMode,
                  createdAt: new Date().toISOString(),
                })
                // The broker never exposes a received persistence/dispatch
                // error through the privileged page's operation response.
                .pipe(Effect.mapError(() => visualizationDenied())),
        );
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
      yield* unexpired;
      const json = yield* ownerOperation(
        session,
        request.method === "tools/call" ? "tool" : "resource",
        JSON.stringify(params),
        operation.expiresAt,
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
      preparing.clear();
    }),
  );
  return { prepare, resolve, details };
});
