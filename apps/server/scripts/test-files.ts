#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

class TestFileRunnerError extends Data.TaggedError("TestFileRunnerError")<{
  readonly message: string;
}> {}

const ignoredDirectories = new Set([".git", ".turbo", "build", "dist", "node_modules"]);
const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const testRoots = ["src", "integration"] as const;

const ServerDir = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

function collectTestFiles(
  absoluteDirectory: string,
  relativeDirectory: string,
): Effect.Effect<string[], never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs
      .readDirectory(absoluteDirectory, { recursive: false })
      .pipe(Effect.catch(() => Effect.succeed([])));
    const files: string[] = [];

    for (const entry of entries) {
      if (ignoredDirectories.has(entry)) {
        continue;
      }

      const absolutePath = path.join(absoluteDirectory, entry);
      const relativePath = relativeDirectory === "" ? entry : `${relativeDirectory}/${entry}`;
      const stat = yield* fs.stat(absolutePath).pipe(Effect.catch(() => Effect.succeed(null)));

      if (stat?.type === "Directory") {
        files.push(...(yield* collectTestFiles(absolutePath, relativePath)));
        continue;
      }

      if (stat?.type === "File" && testFilePattern.test(relativePath)) {
        files.push(relativePath);
      }
    }

    files.sort((a, b) => a.localeCompare(b));
    return files;
  });
}

function collectServerTestFiles(
  serverDir: string,
): Effect.Effect<string[], never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const files: string[] = [];

    for (const root of testRoots) {
      files.push(...(yield* collectTestFiles(path.join(serverDir, root), root)));
    }

    files.sort((a, b) => a.localeCompare(b));
    return files;
  });
}

const runVitestFile = Effect.fn("runVitestFile")(function* (input: {
  readonly file: string;
  readonly index: number;
  readonly serverDir: string;
  readonly total: number;
}) {
  yield* Effect.log(
    `[cafe-code-server] running vitest file ${input.index}/${input.total}: ${input.file}`,
  );

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("vitest", ["run", input.file], {
      cwd: input.serverDir,
      stdout: "inherit",
      stderr: "inherit",
      shell: process.platform === "win32",
    }),
  );
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new TestFileRunnerError({
      message: `Vitest file ${input.file} failed with exit code ${exitCode}`,
    });
  }
});

const program = Effect.gen(function* () {
  const serverDir = yield* ServerDir;
  const files = yield* collectServerTestFiles(serverDir);
  if (files.length === 0) {
    return yield* new TestFileRunnerError({ message: "No server test files found." });
  }

  for (const [index, file] of files.entries()) {
    yield* runVitestFile({
      file,
      index: index + 1,
      serverDir,
      total: files.length,
    });
  }
});

program.pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
);
