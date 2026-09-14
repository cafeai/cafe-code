import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS, ThreadId } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as TestSqliteClient from "../persistence/TestSqliteClient.ts";
import { makeDesktopObservationStore } from "./observationStore.ts";
import { handleDesktopObservationRequest } from "./observationHttp.ts";

it("serves exact private PNGs only to authenticated owners of the requested environment and thread", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const stateDir = yield* Effect.promise(() =>
          fs.mkdtemp(join(tmpdir(), "cafe-observation-http-")),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => fs.rm(stateDir, { recursive: true, force: true })),
        );
        yield* runMigrations();
        const store = yield* makeDesktopObservationStore(stateDir);
        const image =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=";
        const threadId = ThreadId.make("own-thread");
        yield* Effect.promise(() => store.setRetention(50, true));
        const reference = yield* Effect.promise(() =>
          store.save(threadId, { image, width: 1, height: 1, frame: 1, humanControl: false }),
        );
        const request = (
          role: "owner" | "guest" | "anonymous",
          thread = threadId,
          limit = 50,
          id = reference.id,
        ) =>
          handleDesktopObservationRequest.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request(
                  `http://localhost/api/desktop-observations/${id}?threadId=${encodeURIComponent(thread)}`,
                ),
              ),
            ),
            Effect.provideService(ServerAuth, {
              authenticateHttpRequest: () =>
                role === "anonymous"
                  ? Effect.fail(new AuthError({ message: "Authentication required.", status: 401 }))
                  : Effect.succeed({ role }),
            } as never),
            Effect.provideService(ServerConfig, { stateDir } as never),
            Effect.provideService(ServerSettingsService, {
              getSettings: Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                desktopObservationRetention: limit,
              }),
            } as never),
          );
        expect((yield* request("anonymous")).status).toBe(401);
        expect((yield* request("guest")).status).toBe(403);
        expect((yield* request("owner", ThreadId.make("foreign-thread"))).status).toBe(404);
        expect((yield* request("owner", threadId, 0)).status).toBe(404);
        expect((yield* request("owner", threadId, 50, "invalid.png")).status).toBe(400);
        const response = yield* request("owner");
        expect(response.status).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["content-type"]).toBe("image/png");
        const bytes = yield* Effect.promise(() => HttpServerResponse.toWeb(response).arrayBuffer());
        expect(Buffer.from(bytes).toString("base64")).toBe(image);
        yield* Effect.promise(() => store.setRetention(0));
        expect((yield* request("owner")).status).toBe(404);
      }),
    ).pipe(Effect.provide(TestSqliteClient.layerMemory())),
  );
});
