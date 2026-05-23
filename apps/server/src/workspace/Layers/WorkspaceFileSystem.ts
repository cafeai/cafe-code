import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePathOutsideRootError } from "../Services/WorkspacePaths.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

function isInsideOrEqualRoot(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length === 0 ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isNotFoundError(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "NotFound";
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const realPathOrFileSystemError = Effect.fn("WorkspaceFileSystem.realPath")(function* (
    cwd: string,
    relativePath: string,
    absolutePath: string,
    operation: string,
  ) {
    return yield* fileSystem.realPath(absolutePath).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd,
            relativePath,
            operation,
            detail: cause.message,
            cause,
          }),
      ),
    );
  });

  const realPathIfExists = Effect.fn("WorkspaceFileSystem.realPathIfExists")(function* (
    cwd: string,
    relativePath: string,
    absolutePath: string,
  ) {
    return yield* fileSystem.realPath(absolutePath).pipe(
      Effect.map((realPath) => realPath as string | null),
      Effect.catch((cause) =>
        isNotFoundError(cause)
          ? Effect.succeed(null)
          : Effect.fail(
              new WorkspaceFileSystemError({
                cwd,
                relativePath,
                operation: "workspaceFileSystem.realPathIfExists",
                detail: cause.message,
                cause,
              }),
            ),
      ),
    );
  });

  const nearestExistingRealPath = Effect.fn("WorkspaceFileSystem.nearestExistingRealPath")(
    function* (input: {
      readonly cwd: string;
      readonly relativePath: string;
      readonly absolutePath: string;
    }) {
      let currentPath = input.absolutePath;
      while (true) {
        const realPath = yield* realPathIfExists(input.cwd, input.relativePath, currentPath);
        if (realPath !== null) {
          return realPath;
        }

        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) {
          return yield* new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.nearestExistingRealPath",
            detail: `No existing ancestor found for ${input.absolutePath}`,
          });
        }
        currentPath = parentPath;
      }
    },
  );

  const guardWriteTargetWithinRealRoot = Effect.fn(
    "WorkspaceFileSystem.guardWriteTargetWithinRealRoot",
  )(function* (input: {
    readonly cwd: string;
    readonly relativePath: string;
    readonly absolutePath: string;
  }) {
    const rootRealPath = yield* realPathOrFileSystemError(
      input.cwd,
      input.relativePath,
      input.cwd,
      "workspaceFileSystem.realPathRoot",
    );
    const ancestorRealPath = yield* nearestExistingRealPath({
      cwd: input.cwd,
      relativePath: input.relativePath,
      absolutePath: path.dirname(input.absolutePath),
    });
    if (!isInsideOrEqualRoot(path, rootRealPath, ancestorRealPath)) {
      return yield* new WorkspacePathOutsideRootError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
    }

    const targetRealPath = yield* realPathIfExists(
      input.cwd,
      input.relativePath,
      input.absolutePath,
    );
    if (targetRealPath !== null && !isInsideOrEqualRoot(path, rootRealPath, targetRealPath)) {
      return yield* new WorkspacePathOutsideRootError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
    }
  });

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* guardWriteTargetWithinRealRoot({
      cwd: input.cwd,
      relativePath: input.relativePath,
      absolutePath: target.absolutePath,
    });
    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* guardWriteTargetWithinRealRoot({
      cwd: input.cwd,
      relativePath: input.relativePath,
      absolutePath: target.absolutePath,
    });
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });
  return { writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
