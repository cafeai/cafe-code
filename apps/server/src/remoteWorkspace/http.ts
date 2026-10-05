import * as Stream from "effect/Stream";
import { createHash } from "node:crypto";
import { makeDesktopService } from "../virtualDesktop/service.ts";
import { desktopAction } from "../virtualDesktop/interactionSchema.ts";
import { VirtualDesktopId } from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { z } from "zod";
import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { respondToAuthError } from "../auth/http.ts";
import { browserApiCorsHeaders } from "../httpCors.ts";
import { isLoopbackRemoteAddress } from "../http.ts";

// This route admits only desktop-viewer control. File access and terminal
// sessions are deliberately absent from the remote frontend's control surface.
export const workspaceRequest = z
  .object({
    operation: z.literal("desktop-viewer"),
    id: z.string().refine(Schema.is(VirtualDesktopId)),
    command: z.enum(["take-control", "return-control", "act", "heartbeat"]),
    lease: z.string().uuid().optional(),
    action: desktopAction.optional(),
  })
  .strict();
const headers = { ...browserApiCorsHeaders, "cache-control": "no-store" };
export const handleWorkspaceRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const session = yield* (yield* ServerAuth).authenticateHttpRequest(request);
  if (
    session.role !== "owner" ||
    !Option.getOrElse(Option.map(request.remoteAddress, isLoopbackRemoteAddress), () => false)
  )
    return yield* new AuthError({
      message: "Desktop control requires an owner connection over HTTPS or loopback.",
      status: 403,
    });
  const collected = yield* request.stream.pipe(
    Stream.runFoldEffect(
      () => ({ chunks: [] as Uint8Array[], size: 0 }),
      (state, chunk) =>
        state.size + chunk.byteLength > 8 * 1024 * 1024
          ? Effect.fail(new Error("Request body exceeds the limit."))
          : Effect.sync(() => {
              state.chunks.push(chunk);
              state.size += chunk.byteLength;
              return state;
            }),
    ),
    Effect.timeout("15 seconds"),
    Effect.catch(() => Effect.succeed(null)),
  );
  if (!collected) return HttpServerResponse.empty({ status: 413, headers });
  let input: z.infer<typeof workspaceRequest>;
  try {
    input = workspaceRequest.parse(JSON.parse(Buffer.concat(collected.chunks).toString("utf8")));
  } catch {
    return HttpServerResponse.empty({ status: 400, headers });
  }
  const service = yield* makeDesktopService;
  return yield* service
    .request({
      operation: "remote-viewer",
      id: input.id,
      owner: createHash("sha256").update("cafe:viewer:").update(session.sessionId).digest("hex"),
      command: input.command,
      ...(input.lease ? { lease: input.lease } : {}),
      ...(input.action ? { action: input.action } : {}),
    })
    .pipe(
      Effect.map((result) => HttpServerResponse.jsonUnsafe(result, { headers })),
      Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 409, headers }))),
    );
}).pipe(Effect.catchTag("AuthError", respondToAuthError));

/** Viewer input is transient; no operational logging or retries. */
export const remoteWorkspaceRouteLayer = HttpRouter.add(
  "POST",
  "/api/workspace",
  handleWorkspaceRequest,
);
