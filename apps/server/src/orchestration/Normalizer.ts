import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@cafecode/contracts";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
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

    const normalizedAttachments = yield* Effect.forEach(
      command.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
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
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

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
