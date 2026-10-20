import * as DateTime from "effect/DateTime";
// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import { MCP_APP_MAX_MESSAGE_BYTES, MCP_APP_RESOURCE_MIME } from "@cafecode/contracts/mcpApps";
import { GeneratedVisualizationNativeWitness } from "@cafecode/contracts/visualizationApi";
import {
  encodeBoundedMcpAppJson,
  encodeMcpAppReplay,
  ownRecord,
  readBoundedMcpAppJson,
} from "@cafecode/shared/mcpAppProtocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CodexSessionRuntimeShape } from "../provider/Layers/CodexSessionRuntime.ts";
import type { VisualizationSessionBinding } from "../visualizations/sessionRuntime.ts";
import { readVisualizationArtifactService } from "../visualizations/service.ts";

export const MCP_APP_OWNER_PATH = "/visualizations/apps/owner";
const strict = { parseOptions: { onExcessProperty: "error" as const } };
const identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const nativeWitnessFields = GeneratedVisualizationNativeWitness.fields;
const CaptureWitness = Schema.Struct({
  provider: Schema.Literal("codex"),
  threadId: nativeWitnessFields.threadId,
  providerInstanceId: identifier,
  nativeThreadId: nativeWitnessFields.nativeThreadId,
  nativeTurnId: nativeWitnessFields.nativeTurnId,
  nativeItemId: nativeWitnessFields.nativeItemId,
  actor: nativeWitnessFields.actor,
  messageId: nativeWitnessFields.messageId,
  turnId: nativeWitnessFields.turnId,
  occurredAt: nativeWitnessFields.occurredAt,
}).annotate(strict);
type CaptureWitness = Omit<
  GeneratedVisualizationNativeWitness,
  "serverName" | "toolName" | "inputSha256" | "sessionGeneration"
>;
const isCaptureWitness = Schema.is(CaptureWitness);
const data = (object: object, field: string) => {
  const descriptor = Object.getOwnPropertyDescriptor(object, field);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

/** Retain only admitted own scalar fields across asynchronous capture. A typed
 * native adapter normally supplies JSON data; injected peers must not enlarge
 * that retained envelope with arbitrary properties or accessor execution. */
const snapshotCaptureWitness = (witness: CaptureWitness): CaptureWitness | undefined => {
  const actor = data(witness, "actor");
  if (!actor || typeof actor !== "object") return undefined;
  const actorType = data(actor, "type");
  const label = data(actor, "label");
  const snapshot = {
    provider: data(witness, "provider"),
    threadId: data(witness, "threadId"),
    providerInstanceId: data(witness, "providerInstanceId"),
    nativeThreadId: data(witness, "nativeThreadId"),
    nativeTurnId: data(witness, "nativeTurnId"),
    nativeItemId: data(witness, "nativeItemId"),
    actor:
      actorType === "root"
        ? { type: "root" }
        : { type: actorType, id: data(actor, "id"), ...(label === undefined ? {} : { label }) },
    messageId: data(witness, "messageId"),
    turnId: data(witness, "turnId"),
    occurredAt: data(witness, "occurredAt"),
  };
  return isCaptureWitness(snapshot) ? (snapshot as CaptureWitness) : undefined;
};
export const McpAppOwnerOperation = Schema.Struct({
  threadId: identifier,
  providerInstanceId: identifier,
  sessionGeneration: Schema.String.check(Schema.isUUID()),
  nativeThreadId: identifier,
  serverName: identifier,
  originCallId: identifier,
  method: Schema.Literals(["catalog", "resource", "tool", "context"]),
  requestJson: Schema.String.check(Schema.isMaxLength(MCP_APP_MAX_MESSAGE_BYTES)),
  // Resource/tool calls spend a server-minted one-use consent. Its original
  // absolute deadline crosses daemon I/O unchanged; owner admission must never
  // restart or renew that allowance. Catalogue/context calls spend no consent.
  consentExpiresAtMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  ),
}).annotate(strict);
export type McpAppOwnerOperation = typeof McpAppOwnerOperation.Type;
const unavailable = () => new Error("MCP App owner is unavailable.");
interface Owner {
  readonly binding: VisualizationSessionBinding;
  readonly runtime: CodexSessionRuntimeShape;
  readonly run: <A, E>(work: Effect.Effect<A, E>) => Promise<A>;
  closed: boolean;
  pending: number;
  readonly modelContexts: Map<string, string>;
}
const owners = new Map<string, Owner>();
// At most128 exact native-thread contexts globally (≤2MiB encoded data), with
// no eviction that might transfer a child's state to a replacement/root owner.
let modelContextCount = 0;
// Independent from provider event ingestion: at most eight captures across this
// process and two operations per exact owner. There is no unbounded job queue.
let captureCount = 0;
let refusedCaptures = 0;
const refuseCapture = () => {
  refusedCaptures = Math.min(Number.MAX_SAFE_INTEGER, refusedCaptures + 1);
};
export const readMcpAppOwnerDiagnostics = () => ({
  localOwners: owners.size,
  localCaptures: captureCount,
  localModelContexts: modelContextCount,
  refusedCaptures,
});
const key = (input: { threadId: string; providerInstanceId: string; sessionGeneration: string }) =>
  JSON.stringify([input.threadId, input.providerInstanceId, input.sessionGeneration]);
const current = async (owner: Owner) => {
  const service = readVisualizationArtifactService();
  if (owner.closed || !service) throw unavailable();
  await service.run(service.service.requireActiveSession(owner.binding.authority));
  if (owner.closed) throw unavailable();
};
export async function readMcpAppModelContext(
  threadId: string,
  serverName: string,
  nativeThreadId: string,
): Promise<string | undefined> {
  for (const owner of owners.values())
    if (
      !owner.closed &&
      owner.binding.authority.threadId === threadId &&
      owner.binding.name === serverName
    ) {
      try {
        await current(owner);
        return owner.modelContexts.get(nativeThreadId);
      } catch {
        return undefined;
      }
    }
  return undefined;
}

/** Register only the actual adapter-owned transport; retirement is identity
 * fenced, so closing an old session cannot revoke its replacement. */
export function registerMcpAppOwner(
  binding: VisualizationSessionBinding,
  runtime: CodexSessionRuntimeShape,
  run: Owner["run"],
) {
  const owner: Owner = {
    binding,
    runtime,
    run,
    closed: false,
    pending: 0,
    modelContexts: new Map(),
  };
  const identity = key(binding.authority);
  if (!runtime.mcpApps || owners.size >= 128 || owners.has(identity)) return undefined;
  owners.set(identity, owner);
  const performCapture = async ({
    inputJson,
    resultJson,
    serverName,
    toolName,
    uri,
    exactWitness,
  }: {
    inputJson: string;
    resultJson: string;
    serverName: string;
    toolName: string;
    uri: string;
    exactWitness: CaptureWitness;
  }) => {
    try {
      await current(owner);
      const catalogue = ownRecord(
        await owner.run(
          runtime
            .mcpApps!.catalog(exactWitness.nativeThreadId, serverName)
            .pipe(Effect.timeout("10 seconds")),
        ),
      );
      const rows = Array.isArray(catalogue?.data) ? catalogue.data : undefined;
      const server = rows?.length === 1 ? ownRecord(rows[0]) : undefined;
      const tool = ownRecord(ownRecord(server?.tools)?.[toolName]);
      const metadata = ownRecord(ownRecord(tool?._meta)?.ui);
      if (
        owner.closed ||
        catalogue?.nextCursor != null ||
        server?.name !== serverName ||
        metadata?.resourceUri !== uri ||
        !tool
      ) {
        refuseCapture();
        return;
      }
      await current(owner);
      const fetched = ownRecord(
        await owner.run(
          runtime
            .mcpApps!.resource(
              exactWitness.nativeThreadId,
              serverName,
              exactWitness.nativeItemId,
              uri,
            )
            .pipe(Effect.timeout("10 seconds")),
        ),
      );
      const contents = Array.isArray(fetched?.contents) ? fetched.contents : undefined;
      const resource = contents?.length === 1 ? ownRecord(contents[0]) : undefined;
      if (
        owner.closed ||
        (fetched?.originCallId != null && fetched.originCallId !== exactWitness.nativeItemId) ||
        resource?.uri !== uri ||
        resource.mimeType !== MCP_APP_RESOURCE_MIME ||
        typeof resource.text !== "string"
      ) {
        refuseCapture();
        return;
      }
      await current(owner);
      const service = readVisualizationArtifactService();
      if (!service) {
        refuseCapture();
        return;
      }
      const resourceMetaJson = encodeBoundedMcpAppJson(resource._meta ?? {});
      if (!resourceMetaJson) {
        refuseCapture();
        return;
      }
      await service.run(
        service.service.publishMcpApp(
          binding.authority,
          {
            source: resource.text,
            title: "MCP App",
            originalInputJson: inputJson,
            originalResultJson: resultJson,
            serverName,
            originCallId: exactWitness.nativeItemId,
            resourceUri: uri,
            resourceMetaJson,
          },
          {
            ...exactWitness,
            sessionGeneration: binding.authority.sessionGeneration,
            serverName,
            toolName,
            inputSha256: createHash("sha256").update(inputJson).digest("hex"),
          },
        ),
      );
    } catch {
      refuseCapture(); /* Private provider errors never enter logs. */
    } finally {
      owner.pending -= 1;
      captureCount -= 1;
    }
  };
  const capture = (item: unknown, witness: CaptureWitness): Promise<void> => {
    try {
      const call = ownRecord(item);
      const ui = ownRecord(call?.mcpAppUi);
      const uri = typeof ui?.resourceUri === "string" ? ui.resourceUri : call?.mcpAppResourceUri;
      if (uri === undefined) return Promise.resolve(); // Ordinary non-App tool.
      const exactWitness = snapshotCaptureWitness(witness);
      if (
        !exactWitness ||
        owner.closed ||
        owner.pending >= 2 ||
        captureCount >= 8 ||
        exactWitness.threadId !== binding.authority.threadId ||
        exactWitness.providerInstanceId !== binding.authority.providerInstanceId ||
        call?.type !== "mcpToolCall" ||
        call.status !== "completed" ||
        call.error != null ||
        call.id !== exactWitness.nativeItemId ||
        typeof call.server !== "string" ||
        call.server.length === 0 ||
        call.server.length > 200 ||
        typeof call.tool !== "string" ||
        call.tool.length === 0 ||
        call.tool.length > 200 ||
        typeof uri !== "string" ||
        uri.length > 2048 ||
        call.appContext != null
      ) {
        refuseCapture();
        return Promise.resolve();
      }
      // Hosted-account targets require a separately qualified native transport;
      // never silently fall back from a captured account to a global server.
      const inputJson = encodeBoundedMcpAppJson(call.arguments, MCP_APP_MAX_MESSAGE_BYTES - 1024);
      const resultJson = encodeBoundedMcpAppJson(call.result, MCP_APP_MAX_MESSAGE_BYTES - 1024);
      if (!inputJson || !resultJson || !encodeMcpAppReplay(inputJson, resultJson)) {
        refuseCapture();
        return Promise.resolve();
      }
      // Retain only these admitted scalar snapshots across asynchronous I/O,
      // never the entire incoming native event or caller-mutated raw object.
      const serverName = call.server;
      const toolName = call.tool;
      owner.pending += 1;
      captureCount += 1;
      return performCapture({ inputJson, resultJson, serverName, toolName, uri, exactWitness });
    } catch {
      refuseCapture();
      return Promise.resolve();
    }
  };
  return {
    close: () => {
      owner.closed = true;
      modelContextCount -= owner.modelContexts.size;
      owner.modelContexts.clear();
      if (owners.get(identity) === owner) owners.delete(identity);
    },
    capture,
    // All capture admission and small immutable input/result snapshots happen
    // synchronously before the first await. Native event ingestion may proceed
    // immediately; the bounded capture owns its own fixed-error finalization.
    observe: (item: unknown, witness: Parameters<typeof capture>[1]) => {
      void capture(item, witness).catch(refuseCapture);
    },
  };
}

/** Authenticated daemon-only endpoint. The browser never supplies this tuple.
 * Every call is re-observed in the exact still-owned runtime, without fallback,
 * provider restart, global server selection or automatic operation replay. */
export async function dispatchMcpAppOwnerOperation(input: McpAppOwnerOperation): Promise<string> {
  const owner = owners.get(key(input));
  if (!owner || owner.closed || !owner.runtime.mcpApps || owner.pending >= 2) throw unavailable();
  const parsed = readBoundedMcpAppJson(input.requestJson);
  const params = parsed.ok ? ownRecord(parsed.value) : undefined;
  if (!params) throw unavailable();
  // Snapshot the deadline before any await. Even an injected caller that later
  // mutates its decoded input cannot extend an already admitted operation.
  const { consentExpiresAtMs, method, nativeThreadId, serverName, originCallId } = input;
  const requiresConsent = method === "resource" || method === "tool";
  const requireUnexpiredConsent = () => {
    if (owner.closed) throw unavailable();
    if (
      requiresConsent &&
      (typeof consentExpiresAtMs !== "number" ||
        !Number.isSafeInteger(consentExpiresAtMs) ||
        consentExpiresAtMs <= 0 ||
        DateTime.toEpochMillis(DateTime.nowUnsafe()) >= consentExpiresAtMs)
    )
      throw unavailable();
  };
  requireUnexpiredConsent();
  owner.pending += 1;
  try {
    await current(owner);
    // Current-session admission itself performs asynchronous authority I/O.
    // Refuse expired consent before constructing a native transport request.
    requireUnexpiredConsent();
    if (method === "context") {
      // This is a Cafe-owned operation, not an external MCP tool with a magic
      // name. It cannot cause inference or acquire provider tool authority.
      if (typeof params.json !== "string" || !readBoundedMcpAppJson(params.json, 16 * 1024).ok)
        throw unavailable();
      await owner.run(owner.runtime.mcpApps.catalog(nativeThreadId, serverName));
      await current(owner);
      if (!owner.modelContexts.has(nativeThreadId)) {
        if (modelContextCount >= 128 || owner.modelContexts.size >= 16) throw unavailable();
        modelContextCount += 1;
      }
      owner.modelContexts.set(nativeThreadId, params.json);
      return "{}";
    }
    const transport = owner.runtime.mcpApps;
    const result =
      method === "catalog"
        ? await owner.run(transport.catalog(nativeThreadId, serverName))
        : method === "resource" && typeof params.uri === "string"
          ? await owner.run(
              Effect.suspend(() => {
                // A runner may defer effect evaluation after admission. Keep
                // the deadline check adjacent to the actual transport factory,
                // rather than checking only when an unevaluated effect is built.
                requireUnexpiredConsent();
                return transport.resource(
                  nativeThreadId,
                  serverName,
                  originCallId,
                  params.uri as string,
                );
              }),
            )
          : method === "tool" && typeof params.name === "string" && ownRecord(params.arguments)
            ? await owner.run(
                Effect.suspend(() => {
                  requireUnexpiredConsent();
                  return transport.tool(
                    nativeThreadId,
                    serverName,
                    params.name as string,
                    ownRecord(params.arguments)!,
                  );
                }),
              )
            : undefined;
    if (owner.closed || result === undefined) throw unavailable();
    await current(owner);
    const json = encodeBoundedMcpAppJson(result, MCP_APP_MAX_MESSAGE_BYTES - 1024);
    if (!json) throw unavailable();
    return json;
  } catch {
    throw unavailable();
  } finally {
    owner.pending -= 1;
  }
}
