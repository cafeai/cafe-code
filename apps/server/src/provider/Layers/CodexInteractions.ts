import {
  ApprovalRequestId,
  ProviderItemId,
  type TurnId,
  ProviderPermissionInteraction,
  type ProviderEvent,
  type ProviderInteraction,
  type ProviderUserInputAnswers,
} from "@cafecode/contracts";
import {
  getSafeInteractionUrl,
  normalizeElicitationRequest,
  validateInteractionResponse,
} from "@cafecode/shared/providerInteraction";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import type * as Client from "effect-codex-app-server/client";
import * as Errors from "effect-codex-app-server/errors";
import type * as Codex from "effect-codex-app-server/schema";

export interface CodexPendingInteraction {
  readonly requestId: ApprovalRequestId;
  readonly nativeRequestId: string | number;
  readonly providerThreadId: string;
  readonly nativeTurnId?: string;
  readonly turnId?: TurnId;
  readonly itemId?: ProviderItemId;
  readonly interaction: ProviderInteraction;
  readonly url?: string;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}
const boundedText = (value: string) =>
  // oxlint-disable-next-line no-control-regex -- Reject unsafe provider-authored control bytes.
  value.length <= 8192 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const isPermissionInteraction = Schema.is(ProviderPermissionInteraction);

/** Grant ids refer only to this immutable provider request, never client paths. */
export function normalizeCodexPermissionRequest(payload: Codex.PermissionsRequestApprovalParams) {
  if (!boundedText(payload.cwd) || !boundedText(payload.reason ?? "")) return null;
  const filesystem = payload.permissions.fileSystem;
  const grants: Array<{ id: string; label: string }> = [];
  if (payload.permissions.network?.enabled === true)
    grants.push({ id: "network", label: "Network access" });
  for (const kind of ["read", "write"] as const) {
    const paths = filesystem?.[kind] ?? [];
    if (paths.length > 64) return null;
    for (const [index, path] of paths.entries()) {
      if (!boundedText(path)) return null;
      grants.push({
        id: `${kind}:${index}`,
        label: `${kind === "read" ? "Read" : "Write"}: ${path}`,
      });
    }
  }
  const entries = filesystem?.entries ?? [];
  if (entries.length > 64) return null;
  for (const [index, entry] of entries.entries()) {
    const target =
      entry.path.type === "path"
        ? entry.path.path
        : entry.path.type === "glob_pattern"
          ? `Pattern ${entry.path.pattern}`
          : JSON.stringify(entry.path.value);
    if (!boundedText(target)) return null;
    // Deny entries are mandatory restrictions, not grants users can remove.
    if (entry.access !== "deny")
      grants.push({ id: `entry:${index}`, label: `${entry.access}: ${target}` });
  }
  if (grants.length > 64) return null;
  const interaction = {
    kind: "permissions" as const,
    message: payload.reason ?? "Codex requests additional permissions.",
    cwd: payload.cwd,
    ...(payload.environmentId ? { environment: payload.environmentId } : {}),
    grants,
  } satisfies ProviderPermissionInteraction;
  return isPermissionInteraction(interaction) ? interaction : null;
}

/** JSON-RPC string and numeric ids are distinct; late sibling events cannot cancel this request. */
export const settleCodexInteractionBoundary = (
  pending: ReadonlyMap<ApprovalRequestId, CodexPendingInteraction>,
  boundary: {
    providerThreadId: string;
    nativeRequestId?: string | number;
    nativeTurnId?: string;
  },
) =>
  Effect.forEach(
    pending.values(),
    (request) => {
      const matches =
        request.providerThreadId === boundary.providerThreadId &&
        (boundary.nativeRequestId !== undefined
          ? request.nativeRequestId === boundary.nativeRequestId
          : boundary.nativeTurnId !== undefined && request.nativeTurnId === boundary.nativeTurnId);
      return matches
        ? Deferred.succeed(request.answers, { __cafeInteraction: { action: "cancel" } }).pipe(
            Effect.asVoid,
          )
        : Effect.void;
    },
    { discard: true },
  );

export function buildCodexPermissionResponse(
  payload: Codex.PermissionsRequestApprovalParams,
  answers: ProviderUserInputAnswers,
): Codex.PermissionsRequestApprovalResponse | null {
  const interaction = normalizeCodexPermissionRequest(payload);
  const response = interaction ? validateInteractionResponse(interaction, answers) : null;
  if (!response) return null;
  if (response.action !== "accept") return { permissions: {}, scope: "turn" };
  const ids = new Set(response.grantIds);
  const source = payload.permissions.fileSystem;
  const read = (source?.read ?? []).filter((_, index) => ids.has(`read:${index}`));
  const write = (source?.write ?? []).filter((_, index) => ids.has(`write:${index}`));
  const entries = (source?.entries ?? []).filter(
    (entry, index) => entry.access === "deny" || ids.has(`entry:${index}`),
  );
  return {
    permissions: {
      ...(ids.has("network") ? { network: { enabled: true } } : {}),
      ...(read.length || write.length || entries.length
        ? {
            fileSystem: {
              ...(read.length ? { read } : {}),
              ...(write.length ? { write } : {}),
              ...(entries.length ? { entries } : {}),
              ...(source?.globScanMaxDepth != null
                ? { globScanMaxDepth: source.globScanMaxDepth }
                : {}),
            },
          }
        : {}),
    },
    scope: response.scope ?? "turn",
  };
}

/**
 * Keep interactive request ownership outside the turn-stream machinery. This
 * state is process-local and bounded; full authorization URLs never enter an
 * event, command ledger, native log, or diagnostic payload.
 * Protocol: https://learn.chatgpt.com/docs/app-server (MCP elicitation and
 * item/permissions/requestApproval), pinned generated 0.153.4 request schemas.
 * Turn correlation is optional for MCP: its JSON-RPC request identity remains
 * authoritative even when a server asks outside an active Codex turn.
 */
export const registerCodexInteractions = Effect.fn("registerCodexInteractions")(function* (input: {
  client: Pick<Client.CodexAppServerClientShape, "handleServerRequest">;
  pending: Ref.Ref<Map<ApprovalRequestId, CodexPendingInteraction>>;
  resolveTurn: (
    providerThreadId: string,
    turnId?: string | null,
  ) => Effect.Effect<TurnId | undefined, Errors.CodexAppServerError>;
  emit: (
    event: Omit<ProviderEvent, "id" | "createdAt" | "provider" | "threadId">,
  ) => Effect.Effect<void>;
}) {
  const wait = (
    interaction: ProviderInteraction,
    metadata: {
      providerThreadId: string;
      turnId?: string | null;
      itemId?: string;
      nativeRequestId: string | number;
      url?: string;
    },
  ) =>
    Effect.gen(function* () {
      const turnId = yield* input.resolveTurn(metadata.providerThreadId, metadata.turnId);
      const requestId = ApprovalRequestId.make(yield* Random.nextUUIDv4);
      const answers = yield* Deferred.make<ProviderUserInputAnswers>();
      const pending: CodexPendingInteraction = {
        requestId,
        nativeRequestId: metadata.nativeRequestId,
        providerThreadId: metadata.providerThreadId,
        ...(metadata.turnId ? { nativeTurnId: metadata.turnId } : {}),
        ...(turnId ? { turnId } : {}),
        ...(metadata.itemId ? { itemId: ProviderItemId.make(metadata.itemId) } : {}),
        interaction,
        ...(metadata.url ? { url: metadata.url } : {}),
        answers,
      };
      const admitted = yield* Ref.modify(input.pending, (current) => {
        if (current.size >= 64) return [false, current] as const;
        const next = new Map(current);
        next.set(requestId, pending);
        return [true, next] as const;
      });
      if (!admitted)
        return yield* Errors.CodexAppServerRequestError.internalError(
          "Too many pending interactive requests",
        );
      return yield* input
        .emit({
          kind: "request",
          method: "cafecode/interaction/request",
          requestId,
          ...(turnId ? { turnId } : {}),
          payload: { interaction },
        })
        .pipe(
          Effect.andThen(Deferred.await(answers)),
          // Cancellation and runtime shutdown must resolve the displayed card
          // too. This uninterruptible finalizer runs before event-queue teardown;
          // it contains lifecycle metadata only, never private response values.
          Effect.ensuring(
            Ref.update(input.pending, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }).pipe(
              Effect.andThen(
                input.emit({
                  kind: "notification",
                  method: "cafecode/interaction/resolved",
                  requestId,
                  ...(turnId ? { turnId } : {}),
                  payload: {},
                }),
              ),
            ),
          ),
        );
    });
  yield* input.client.handleServerRequest("mcpServer/elicitation/request", (payload, context) =>
    Effect.gen(function* () {
      const interaction = normalizeElicitationRequest(payload);
      if (!interaction || !context) {
        yield* input.emit({
          kind: "notification",
          method: "cafecode/interaction/unsupported",
          payload: {},
        });
        return { action: "decline" as const, content: null };
      }
      const url = payload.mode === "url" ? getSafeInteractionUrl(payload.url) : null;
      const answers = yield* wait(interaction, {
        providerThreadId: payload.threadId,
        ...(payload.turnId ? { turnId: payload.turnId } : {}),
        nativeRequestId: context.requestId,
        ...(url ? { url } : {}),
      });
      const response = validateInteractionResponse(interaction, answers);
      return response
        ? { action: response.action, content: response.content ?? null }
        : { action: "cancel" as const, content: null };
    }),
  );
  yield* input.client.handleServerRequest("item/permissions/requestApproval", (payload, context) =>
    Effect.gen(function* () {
      const interaction = normalizeCodexPermissionRequest(payload);
      if (!interaction || !context) {
        yield* input.emit({
          kind: "notification",
          method: "cafecode/interaction/unsupported",
          payload: {},
        });
        return { permissions: {}, scope: "turn" as const };
      }
      const answers = yield* wait(interaction, {
        providerThreadId: payload.threadId,
        turnId: payload.turnId,
        itemId: payload.itemId,
        nativeRequestId: context.requestId,
      });
      return (
        buildCodexPermissionResponse(payload, answers) ?? {
          permissions: {},
          scope: "turn" as const,
        }
      );
    }),
  );
});
