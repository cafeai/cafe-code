import { describe, expect, it } from "vitest";
import { ApprovalRequestId, TurnId, type ProviderUserInputAnswers } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";
import type * as Codex from "effect-codex-app-server/schema";
import {
  buildCodexPermissionResponse,
  normalizeCodexPermissionRequest,
  registerCodexInteractions,
  settleCodexInteractionBoundary,
  type CodexPendingInteraction,
} from "./CodexInteractions.ts";

const request: Codex.PermissionsRequestApprovalParams = {
  cwd: "/workspace",
  itemId: "item",
  threadId: "native",
  turnId: "turn",
  startedAtMs: 1,
  permissions: {
    network: { enabled: true },
    fileSystem: { read: ["/workspace/input"], write: ["/workspace/output"] },
  },
};
describe("Codex private interactions", () => {
  it("returns only explicitly selected original grants and safe scope, never client paths", () => {
    expect(normalizeCodexPermissionRequest(request)?.grants.map((grant) => grant.id)).toEqual([
      "network",
      "read:0",
      "write:0",
    ]);
    expect(
      buildCodexPermissionResponse(request, {
        __cafeInteraction: { action: "accept", grantIds: ["read:0"], scope: "turn" },
      }),
    ).toEqual({ permissions: { fileSystem: { read: ["/workspace/input"] } }, scope: "turn" });
    expect(
      buildCodexPermissionResponse(request, {
        __cafeInteraction: { action: "accept", grantIds: ["write:99"] },
      }),
    ).toBeNull();
    expect(
      buildCodexPermissionResponse(request, { __cafeInteraction: { action: "decline" } }),
    ).toEqual({ permissions: {}, scope: "turn" });
  });
  it("retains deny restrictions even when selecting a narrower permission subset", () => {
    const withEntries: Codex.PermissionsRequestApprovalParams = {
      ...request,
      permissions: {
        fileSystem: {
          entries: [
            { path: { type: "path", path: "/workspace" }, access: "read" },
            { path: { type: "path", path: "/workspace/secrets" }, access: "deny" },
          ],
        },
      },
    };
    expect(normalizeCodexPermissionRequest(withEntries)?.grants).toHaveLength(1);
    expect(
      buildCodexPermissionResponse(withEntries, {
        __cafeInteraction: { action: "accept", grantIds: ["entry:0"], scope: "session" },
      })?.permissions.fileSystem?.entries,
    ).toEqual(withEntries.permissions.fileSystem?.entries);
  });
  it("correlates cancellation to exact native request type, thread and turn", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const answers = yield* Deferred.make<ProviderUserInputAnswers>();
        const pending = new Map<ApprovalRequestId, CodexPendingInteraction>([
          [
            ApprovalRequestId.make("request"),
            {
              requestId: ApprovalRequestId.make("request"),
              nativeRequestId: 7,
              providerThreadId: "native",
              nativeTurnId: "turn",
              interaction: normalizeCodexPermissionRequest(request)!,
              answers,
            },
          ],
        ]);
        yield* settleCodexInteractionBoundary(pending, {
          providerThreadId: "native",
          nativeRequestId: "7",
        });
        yield* settleCodexInteractionBoundary(pending, {
          providerThreadId: "sibling",
          nativeRequestId: 7,
        });
        yield* settleCodexInteractionBoundary(pending, {
          providerThreadId: "native",
          nativeTurnId: "old-turn",
        });
        expect(yield* Deferred.isDone(answers)).toBe(false);
        yield* settleCodexInteractionBoundary(pending, {
          providerThreadId: "native",
          nativeRequestId: 7,
        });
        expect(yield* Deferred.await(answers)).toEqual({ __cafeInteraction: { action: "cancel" } });
      }),
    );
  });
  it.each(["answer", "interrupt"] as const)(
    "registers native callbacks with private lifecycle cleanup on %s",
    async (outcome) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const handlers = new Map<
            string,
            (
              payload: unknown,
              context: { requestId: string | number },
            ) => Effect.Effect<unknown, unknown>
          >();
          const pending = yield* Ref.make(new Map<ApprovalRequestId, CodexPendingInteraction>());
          const requested = yield* Deferred.make<void>();
          const events: unknown[] = [];
          yield* registerCodexInteractions({
            client: {
              handleServerRequest: (method, handler) =>
                Effect.sync(() => {
                  handlers.set(
                    method,
                    handler as typeof handlers extends Map<string, infer H> ? H : never,
                  );
                }),
            },
            pending,
            resolveTurn: () => Effect.succeed(TurnId.make("cafe-turn")),
            emit: (event) =>
              Effect.sync(() => {
                events.push(event);
              }).pipe(
                Effect.andThen(
                  event.kind === "request" ? Deferred.succeed(requested, undefined) : Effect.void,
                ),
                Effect.asVoid,
              ),
          });
          expect([...handlers.keys()]).toEqual([
            "mcpServer/elicitation/request",
            "item/permissions/requestApproval",
          ]);
          const fiber = yield* handlers.get("mcpServer/elicitation/request")!(
            {
              mode: "url",
              serverName: "connector",
              threadId: "native",
              turnId: "turn",
              elicitationId: "native-elicitation",
              message: "Visit https://example.com/authorize?token=private",
              url: "https://example.com/authorize?token=private",
            },
            { requestId: "native-request" },
          ).pipe(Effect.forkChild);
          yield* Deferred.await(requested);
          const row = [...(yield* Ref.get(pending)).values()][0]!;
          expect(row.url).toContain("token=private");
          expect(row.nativeRequestId).toBe("native-request");
          expect(JSON.stringify(events)).not.toContain("token=private");
          if (outcome === "answer") {
            yield* Deferred.succeed(row.answers, {
              __cafeInteraction: { action: "accept", content: null },
            });
            expect(yield* Fiber.join(fiber)).toEqual({ action: "accept", content: null });
          } else {
            yield* Fiber.interrupt(fiber);
          }
          expect((yield* Ref.get(pending)).size).toBe(0);
          expect(JSON.stringify(events)).not.toContain("token=private");
          expect(events).toHaveLength(2);
        }).pipe(Effect.scoped),
      );
    },
  );
});
