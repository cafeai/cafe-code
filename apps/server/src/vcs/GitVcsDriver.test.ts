import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { assert, it } from "@effect/vitest";

import { CheckpointRef, GitCommandError } from "@cafecode/contracts";
import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "cafecode-git-vcs-contract-",
});
const GitContractLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "GitVcsDriver.contract.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

type GitContractError = GitCommandError | PlatformError.PlatformError;

runVcsDriverContractSuite<GitVcsDriver.GitVcsDriver, GitContractError>({
  name: "Git",
  kind: "git",
  layer: GitContractLayer,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* () {
        yield* runGit(cwd, ["init"]);
        yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
        yield* runGit(cwd, ["config", "user.name", "Test"]);
      }),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    trackFile: (cwd, relativePath) => runGit(cwd, ["add", relativePath]),
    commit: (cwd, message) => runGit(cwd, ["commit", "-m", message]),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

it.effect("GitVcsDriver forwards execute env to the VCS process", () => {
  let observedEnv: NodeJS.ProcessEnv | undefined;
  let observedAppendTruncationMarker: boolean | undefined;

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();

    yield* driver.execute({
      operation: "GitVcsDriver.test.env",
      cwd: "/repo",
      args: ["status"],
      env: {
        GIT_INDEX_FILE: "/tmp/t3-index",
      },
      appendTruncationMarker: true,
    });

    assert.deepStrictEqual(observedEnv, {
      GIT_INDEX_FILE: "/tmp/t3-index",
    });
    assert.strictEqual(observedAppendTruncationMarker, true);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              observedEnv = input.env;
              observedAppendTruncationMarker = input.appendTruncationMarker;
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
});

it.effect("GitVcsDriver checkpoint capture stages only changed tracked paths", () => {
  const observedInputs: VcsProcess.VcsProcessInput[] = [];

  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "cafecode-git-checkpoint-paths-",
    });
    yield* fileSystem.makeDirectory(pathService.join(cwd, ".git"));

    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    if (!driver.checkpoints) {
      throw new Error("Git VCS driver did not expose checkpoint operations.");
    }

    yield* driver.checkpoints.captureCheckpoint({
      cwd,
      checkpointRef: CheckpointRef.make("refs/cafe/checkpoints/thread/turn/1"),
    });

    assert.equal(
      observedInputs.some((input) =>
        input.args.some(
          (arg, index, args) =>
            arg === "add" &&
            args[index + 1] === "-u" &&
            args[index + 2] === "--" &&
            args[index + 3] === ".",
        ),
      ),
      false,
    );

    const diffInput = observedInputs.find((input) => input.args.includes("diff"));
    assert.deepStrictEqual(diffInput?.args.slice(2), [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--diff-filter=DMTUXB",
      "HEAD",
      "--",
    ]);
    assert.equal(diffInput?.env?.GIT_INDEX_FILE, undefined);

    const addInput = observedInputs.find((input) => input.args.includes("add"));
    assert.deepStrictEqual(addInput?.args.slice(2), [
      "add",
      "-u",
      "--",
      "README.md",
      "dir/nested file.ts",
    ]);
    assert.match(addInput?.env?.GIT_INDEX_FILE ?? "", /cafecode-checkpoint-index-/u);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              observedInputs.push(input);
              const gitArgs = input.args.slice(2);
              const stdout =
                gitArgs[0] === "rev-parse" && gitArgs[1] === "--git-common-dir"
                  ? ".git\n"
                  : gitArgs[0] === "rev-parse" && gitArgs[1] === "--verify"
                    ? "0123456789012345678901234567890123456789\n"
                    : gitArgs[0] === "diff"
                      ? "README.md\0dir/nested file.ts\0"
                      : gitArgs[0] === "write-tree"
                        ? "tree-oid\n"
                        : gitArgs[0] === "commit-tree"
                          ? "commit-oid\n"
                          : "";
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout,
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
});

it.effect("GitVcsDriver deletes checkpoint refs with bounded update-ref stdin batches", () => {
  const observedInputs: VcsProcess.VcsProcessInput[] = [];

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    if (!driver.checkpoints) {
      throw new Error("Git VCS driver did not expose checkpoint operations.");
    }

    yield* driver.checkpoints.deleteCheckpointRefs({
      cwd: "/repo",
      checkpointRefs: Array.from({ length: 260 }, (_, index) =>
        CheckpointRef.make(`refs/cafe/checkpoints/thread/turn/${index}`),
      ),
    });

    assert.strictEqual(observedInputs.length, 2);
    assert.deepStrictEqual(observedInputs[0]?.args, ["-C", "/repo", "update-ref", "--stdin"]);
    assert.strictEqual(observedInputs[0]?.allowNonZeroExit, true);
    assert.strictEqual(
      observedInputs[0]?.stdin?.split("\n").filter((line) => line.length > 0).length,
      512,
    );
    assert.ok(observedInputs[0]?.stdin?.includes("delete refs/cafe/checkpoints/thread/turn/0\n"));
    assert.ok(observedInputs[0]?.stdin?.includes("delete refs/t3/checkpoints/thread/turn/0\n"));
    assert.strictEqual(
      observedInputs[1]?.stdin?.split("\n").filter((line) => line.length > 0).length,
      8,
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              observedInputs.push(input);
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
});

it.effect("GitVcsDriver rejects unsafe checkpoint refs before update-ref stdin", () => {
  let observedProcessRuns = 0;

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    if (!driver.checkpoints) {
      throw new Error("Git VCS driver did not expose checkpoint operations.");
    }

    const error = yield* driver.checkpoints
      .deleteCheckpointRefs({
        cwd: "/repo",
        checkpointRefs: [
          CheckpointRef.make("refs/cafe/checkpoints/thread/turn/1\n delete refs/heads/main"),
        ],
      })
      .pipe(Effect.flip);

    assert.match(error.message, /unsafe checkpoint ref/u);
    assert.strictEqual(observedProcessRuns, 0);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: () =>
            Effect.sync(() => {
              observedProcessRuns += 1;
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
});
