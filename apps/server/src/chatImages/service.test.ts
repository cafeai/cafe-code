import { mkdtemp, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { ServerConfig } from "../config.ts";
import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { makeChatImages, ChatImages } from "./service.ts";
import { handleChatImageRequest } from "./http.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
  "base64",
);
const time = "2026-10-11T00:00:00.000Z";

it.each(["codex", "claudeAgent"] as const)(
  "persists immutable %s images for authenticated viewers and fork ownership",
  async (provider) => {
    const directory = await mkdtemp(join(tmpdir(), "cafe-chat-image-db-"));
    const imagePath = join(directory, "chart with spaces.png");
    // Markdown URI identifiers encode native Windows separators as well as
    // spaces. Keep the filesystem path and the exact published identifier distinct.
    const source = imagePath.replaceAll("\\", "%5C").replaceAll(" ", "%20");
    const layer = NodeSqliteClient.layer({ filename: join(directory, "test.sqlite") });
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.runPromise(
        Effect.scoped(effect).pipe(
          Effect.provide(layer),
          Effect.provide(NodeServices.layer),
          Effect.provideService(ServerConfig, { stateDir: directory, baseDir: directory } as never),
        ) as Effect.Effect<A, E>,
      );
    try {
      await writeFile(imagePath, png);
      await run(
        Effect.gen(function* () {
          yield* runMigrations();
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA foreign_keys = ON`;
          yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('p', 'Project', ${directory}, '[]', ${time}, ${time})`;
          for (const threadId of ["chat", "fork", "grok"]) {
            yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
          VALUES (${threadId}, 'p', 'Chat', ${time}, ${time})`;
            yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, provider_name, updated_at)
          VALUES (${threadId}, 'ready', ${threadId === "grok" ? "grok" : provider}, ${time})`;
          }
          const addMessage = (
            threadId: string,
            id: string,
            text: string,
            streaming = 0,
            role = "assistant",
          ) => sql`
        INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${id}, ${threadId}, ${role}, ${text}, ${streaming}, ${time}, ${time})`;
          yield* addMessage("chat", "a", `![Chart](<${imagePath}>)`);
          yield* addMessage("chat", "streaming", `![Chart](<${imagePath}>)`, 1);
          yield* addMessage("chat", "user", `![Chart](<${imagePath}>)`, 0, "user");
          yield* addMessage("grok", "grok-a", `![Chart](<${imagePath}>)`);
          const images = yield* makeChatImages;
          yield* images.publish("chat", "a");
          expect(yield* images.manifest("chat", "a")).toMatchObject([
            { source, width: 1, height: 1 },
          ]);
          for (const [thread, message] of [
            ["chat", "streaming"],
            ["chat", "user"],
            ["grok", "grok-a"],
          ]) {
            yield* images.publish(thread!, message!);
            expect(yield* images.manifest(thread!, message!)).toEqual([]);
          }
          expect(yield* images.read("fork", "a", source)).toBeNull();
          expect(yield* images.read("chat", "a", join(directory, "unmentioned.png"))).toBeNull();
          const changed = Buffer.concat([png, Buffer.from([1])]);
          yield* Effect.promise(() => writeFile(imagePath, changed));
          yield* addMessage("chat", "b", `![Chart](<${imagePath}>)`);
          yield* images.publish("chat", "b");
          expect((yield* images.read("chat", "a", source))?.bytes).toEqual(new Uint8Array(png));
          expect((yield* images.read("chat", "b", source))?.bytes).toEqual(new Uint8Array(changed));
          yield* addMessage("fork", "copy:fork:a", `![Chart](<${imagePath}>)`);
          yield* sql`INSERT INTO chat_message_images (thread_id, message_id, source, digest)
        SELECT 'fork', 'copy:fork:a', source, digest FROM chat_message_images WHERE message_id = 'a'`;
          yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'a'`;
          expect(yield* images.read("chat", "a", source)).toBeNull();
          expect((yield* images.read("fork", "copy:fork:a", source))?.bytes).toEqual(
            new Uint8Array(png),
          );
          yield* Effect.promise(() => unlink(imagePath));
        }),
      );
      // Close/reopen a real isolated database and remove the original image.
      // Another client must still receive the same saved bytes after restart.
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA foreign_keys = ON`;
          const images = yield* makeChatImages;
          const request = (
            role: "owner" | "guest" | "anonymous",
            threadId = "fork",
            messageId = "copy:fork:a",
          ) =>
            handleChatImageRequest.pipe(
              Effect.provideService(ChatImages, images),
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(
                  new Request(
                    `http://localhost/api/chat-images?${new URLSearchParams({ threadId, messageId, source })}`,
                  ),
                ),
              ),
              Effect.provideService(ServerAuth, {
                authenticateHttpRequest: () =>
                  role === "anonymous"
                    ? Effect.fail(
                        new AuthError({ message: "Authentication required.", status: 401 }),
                      )
                    : Effect.succeed({ role }),
              } as never),
            );
          expect((yield* request("anonymous")).status).toBe(401);
          expect((yield* request("owner", "chat")).status).toBe(404);
          for (const role of ["owner", "guest"] as const) {
            const response = yield* request(role);
            expect(response.status).toBe(200);
            expect(response.headers["content-type"]).toBe("image/png");
            expect(
              new Uint8Array(
                yield* Effect.promise(() => HttpServerResponse.toWeb(response).arrayBuffer()),
              ),
            ).toEqual(new Uint8Array(png));
          }
          yield* sql`UPDATE projection_threads SET deleted_at = ${time} WHERE thread_id = 'fork'`;
          expect(yield* images.manifest("fork", "copy:fork:a")).toEqual([]);
          expect((yield* request("guest")).status).toBe(404);
          yield* sql`UPDATE projection_threads SET deleted_at = NULL WHERE thread_id = 'fork'`;
          expect((yield* request("guest")).status).toBe(200);
          yield* sql`INSERT INTO hard_deleted_threads (thread_id, deleted_at) VALUES ('fork', ${time})`;
          expect((yield* request("guest")).status).toBe(404);
          yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'b'`;
          expect(yield* sql`SELECT digest FROM chat_image_assets`).toEqual([]);
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
