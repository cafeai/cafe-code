import { Buffer } from "node:buffer";

import { CommandId, MessageId, ThreadId } from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { computeAttachmentContentSha256 } from "../attachmentContentCommitment.ts";
import { ServerConfig } from "../config.ts";
import { storeFileAttachment } from "../fileAttachmentStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../project/Layers/RepositoryIdentityResolver.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

const layer = it.layer(
  Layer.mergeAll(
    WorkspacePathsLive,
    OrchestrationProjectionSnapshotQueryLive.pipe(Layer.provide(RepositoryIdentityResolverLive)),
    ServerConfig.layerTest(process.cwd(), { prefix: "cafe-normalizer-test-" }),
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provideMerge(NodeServices.layer)),
);

layer("normalizeDispatchCommand attachment commitments", (it) => {
  it.effect("records exact upload bytes privately without adding a wire field", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-normalizer-commitment");
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at
        ) VALUES (
          'project-normalizer-commitment',
          'Normalizer commitment',
          '/tmp/project-normalizer-commitment',
          NULL,
          '[]',
          '2026-08-31T00:00:00.000Z',
          '2026-08-31T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at
        ) VALUES (
          ${threadId},
          'project-normalizer-commitment',
          'Normalizer commitment',
          NULL,
          NULL,
          NULL,
          '2026-08-31T00:00:00.000Z',
          '2026-08-31T00:00:00.000Z'
        )
      `;

      const bytes = Buffer.from("private image bytes", "utf8");
      const normalized = yield* normalizeDispatchCommand({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-normalizer-commitment"),
        threadId,
        message: {
          messageId: MessageId.make("message-normalizer-commitment"),
          role: "user",
          text: "same image",
          attachments: [
            {
              type: "image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: bytes.byteLength,
              dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
            },
          ],
        },
        createdAt: "2026-08-31T00:00:01.000Z",
      });
      assert.equal(normalized.type, "thread.turn.steer");
      if (normalized.type !== "thread.turn.steer") {
        return assert.fail("expected a normalized thread.turn.steer command");
      }
      const attachment = normalized.message.attachments[0];
      assert.isDefined(attachment);
      assert.notProperty(attachment, "contentSha256");

      const rows = yield* sql<{
        readonly attachmentId: string;
        readonly threadId: string;
        readonly contentSha256: string;
        readonly sizeBytes: number;
      }>`
        SELECT
          attachment_id AS "attachmentId",
          thread_id AS "threadId",
          content_sha256 AS "contentSha256",
          size_bytes AS "sizeBytes"
        FROM attachment_content_commitments
      `;
      assert.deepEqual(rows, [
        {
          attachmentId: attachment?.id,
          threadId,
          contentSha256: computeAttachmentContentSha256(bytes),
          sizeBytes: bytes.byteLength,
        },
      ]);

      const config = yield* ServerConfig;
      const file = yield* Effect.promise(() =>
        storeFileAttachment({
          attachmentsDir: config.attachmentsDir,
          threadId,
          name: "document.tex",
          mimeType: "text/plain",
          bytes: Buffer.from("\\section{private}"),
        }),
      );
      const fileCommand = {
        type: "thread.turn.steer" as const,
        commandId: CommandId.make("cmd-normalizer-file"),
        threadId,
        message: {
          messageId: MessageId.make("message-file"),
          role: "user" as const,
          text: "",
          attachments: [file],
        },
        createdAt: "2026-08-31T00:00:02.000Z",
      };
      const normalizedFile = yield* normalizeDispatchCommand(fileCommand);
      const repeatedFile = yield* normalizeDispatchCommand(fileCommand);
      assert.deepEqual(normalizedFile, repeatedFile);
      assert.equal(normalizedFile.type, "thread.turn.steer");
      if (normalizedFile.type === "thread.turn.steer")
        assert.deepEqual(normalizedFile.message.attachments, [file]);
      const crossThread = yield* normalizeDispatchCommand({
        ...fileCommand,
        threadId: ThreadId.make("other-thread"),
      }).pipe(Effect.result);
      assert.equal(crossThread._tag, "Failure");
      const renamed = yield* normalizeDispatchCommand({
        ...fileCommand,
        message: { ...fileCommand.message, attachments: [{ ...file, name: "forged" }] },
      }).pipe(Effect.result);
      assert.equal(renamed._tag, "Failure");
      const fileRows =
        yield* sql`SELECT attachment_id FROM attachment_content_commitments WHERE attachment_id = ${file.id}`;
      assert.equal(fileRows.length, 1);
    }),
  );
});
