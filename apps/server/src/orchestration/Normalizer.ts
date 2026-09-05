import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_TOTAL_ATTACHMENT_BYTES,
} from "@cafecode/contracts";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import {
  computeAttachmentContentSha256,
  insertAttachmentContentCommitment,
} from "../attachmentContentCommitment.ts";
import { ServerConfig } from "../config.ts";
import { readStoredFileAttachment } from "../fileAttachmentStore.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import { WorkspacePaths } from "../workspace/Services/WorkspacePaths.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const sql = yield* SqlClient.SqlClient;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    const isSamePath = (left: string, right: string) => {
      const relative = path.relative(left, right);
      return relative.length === 0;
    };

    const normalizeAdditionalWorkspaceRoots = (
      roots: ReadonlyArray<string> | undefined,
      primaryWorkspaceRoot: string | undefined,
    ) =>
      Effect.gen(function* () {
        if (roots === undefined) {
          return undefined;
        }

        const normalizedRoots = yield* Effect.forEach(roots, normalizeProjectWorkspaceRoot, {
          concurrency: 4,
        });
        const uniqueRoots: string[] = [];
        for (const normalizedRoot of normalizedRoots) {
          if (
            primaryWorkspaceRoot !== undefined &&
            isSamePath(normalizedRoot, primaryWorkspaceRoot)
          ) {
            continue;
          }
          if (!uniqueRoots.some((existingRoot) => isSamePath(existingRoot, normalizedRoot))) {
            uniqueRoots.push(normalizedRoot);
          }
        }
        return uniqueRoots;
      });

    if (command.type === "project.create") {
      const workspaceRoot = yield* normalizeProjectWorkspaceRootForCreate(
        command.workspaceRoot,
        command.createWorkspaceRootIfMissing,
      );
      return {
        ...command,
        workspaceRoot,
        ...(command.additionalWorkspaceRoots !== undefined
          ? {
              additionalWorkspaceRoots: yield* normalizeAdditionalWorkspaceRoots(
                command.additionalWorkspaceRoots,
                workspaceRoot,
              ),
            }
          : {}),
        createWorkspaceRootIfMissing: command.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (
      command.type === "project.meta.update" &&
      (command.workspaceRoot !== undefined || command.additionalWorkspaceRoots !== undefined)
    ) {
      const workspaceRoot =
        command.workspaceRoot !== undefined
          ? yield* normalizeProjectWorkspaceRoot(command.workspaceRoot)
          : Option.match(
              yield* projectionSnapshotQuery.getProjectShellById(command.projectId).pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationDispatchCommandError({
                      message: "Failed to load project before updating additional directories.",
                      cause,
                    }),
                ),
              ),
              {
                onNone: () => undefined,
                onSome: (project) => project.workspaceRoot,
              },
            );
      return {
        ...command,
        ...(command.workspaceRoot !== undefined && workspaceRoot !== undefined
          ? { workspaceRoot }
          : {}),
        ...(command.additionalWorkspaceRoots !== undefined
          ? {
              additionalWorkspaceRoots: yield* normalizeAdditionalWorkspaceRoots(
                command.additionalWorkspaceRoots,
                workspaceRoot,
              ),
            }
          : {}),
      } satisfies OrchestrationCommand;
    }

    if (command.type !== "thread.turn.start" && command.type !== "thread.turn.steer") {
      return command as OrchestrationCommand;
    }

    if (
      command.message.attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0) >
      PROVIDER_SEND_TURN_MAX_TOTAL_ATTACHMENT_BYTES
    ) {
      return yield* new OrchestrationDispatchCommandError({
        message: "Attachments must total 80 MiB or less.",
      });
    }
    // Image sizes come from client metadata until decoded. Recheck the actual
    // byte total while normalizing, so forged size fields cannot evade the cap.
    let actualTotalBytes = 0;
    const countBytes = (length: number) =>
      Effect.suspend(() => {
        actualTotalBytes += length;
        return actualTotalBytes > PROVIDER_SEND_TURN_MAX_TOTAL_ATTACHMENT_BYTES
          ? Effect.fail(
              new OrchestrationDispatchCommandError({
                message: "Attachments must total 80 MiB or less.",
              }),
            )
          : Effect.void;
      });
    const normalizedAttachments = yield* Effect.forEach(
      command.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          if (attachment.type === "file") {
            // Uploads can precede thread creation, but dispatch binds the exact
            // immutable bytes to the now-materialized thread. Retrying the same
            // handle is idempotent; altered metadata/content never is.
            const stored = yield* Effect.tryPromise({
              try: () =>
                readStoredFileAttachment({
                  attachmentsDir: serverConfig.attachmentsDir,
                  attachment,
                  threadId: command.threadId,
                }),
              catch: () =>
                new OrchestrationDispatchCommandError({
                  message: "A file attachment is unavailable or changed. Attach it again.",
                }),
            });
            yield* countBytes(stored.bytes.byteLength);
            const digest = computeAttachmentContentSha256(stored.bytes);
            yield* sql`INSERT INTO attachment_content_commitments (attachment_id, thread_id, content_sha256, size_bytes)
              VALUES (${attachment.id}, ${command.threadId}, ${digest}, ${attachment.sizeBytes})
              ON CONFLICT (attachment_id) DO NOTHING`;
            const commitments = yield* sql<{ threadId: string; digest: string; size: number }>`
              SELECT thread_id AS "threadId", content_sha256 AS digest, size_bytes AS size
              FROM attachment_content_commitments WHERE attachment_id = ${attachment.id}`;
            const commitment = commitments[0];
            if (
              !commitment ||
              commitment.threadId !== command.threadId ||
              commitment.digest !== digest ||
              commitment.size !== attachment.sizeBytes
            ) {
              return yield* new OrchestrationDispatchCommandError({
                message: "The file attachment does not match its original upload.",
              });
            }
            return attachment;
          }
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(command.threadId);
          yield* countBytes(bytes.byteLength);
          if (!attachmentId) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          // `wx` keeps Cafe's random storage identity immutable even under an
          // impossible-in-practice UUID collision. The private commitment is
          // inserted only after the exact bytes reach disk; if that insert
          // fails, remove this newly-created file so no uncommitted upload can
          // later be mistaken for a canonical attachment.
          yield* fileSystem.writeFile(attachmentPath, bytes, { flag: "wx", mode: 0o600 }).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );
          const commitmentResult = yield* insertAttachmentContentCommitment({
            sql,
            attachmentId,
            threadId: command.threadId,
            contentSha256: computeAttachmentContentSha256(bytes),
            sizeBytes: bytes.byteLength,
          }).pipe(Effect.result);
          if (commitmentResult._tag === "Failure") {
            yield* fileSystem.remove(attachmentPath, { force: true }).pipe(Effect.ignore);
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to secure attachment '${attachment.name}'.`,
            });
          }

          return persistedAttachment;
        }),
      { concurrency: 1 },
    );

    return {
      ...command,
      message: {
        ...command.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });
