import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  GitCommandError,
  SourceControlRepositoryError,
  type SourceControlProviderError,
} from "@cafecode/contracts";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "./SourceControlRepositoryService.ts";

const CLONE_URLS = {
  nameWithOwner: "octocat/t3code",
  url: "https://github.com/octocat/t3code",
  sshUrl: "git@github.com:octocat/t3code.git",
};

function makeProvider(
  overrides: Partial<SourceControlProvider.SourceControlProviderShape> = {},
): SourceControlProvider.SourceControlProviderShape {
  const unsupported = (operation: string) =>
    Effect.die(`unexpected provider operation ${operation}`) as Effect.Effect<
      never,
      SourceControlProviderError
    >;

  return {
    kind: "github",
    listChangeRequests: () => unsupported("listChangeRequests"),
    getChangeRequest: () => unsupported("getChangeRequest"),
    createChangeRequest: () => unsupported("createChangeRequest"),
    getRepositoryCloneUrls: () => Effect.succeed(CLONE_URLS),
    createRepository: () => Effect.succeed(CLONE_URLS),
    getDefaultBranch: () => Effect.succeed(null),
    checkoutChangeRequest: () => unsupported("checkoutChangeRequest"),
    ...overrides,
  };
}

function processOutput(): GitVcsDriver.ExecuteGitResult {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function makeLayer(input: {
  readonly provider?: SourceControlProvider.SourceControlProviderShape;
  readonly git?: Partial<GitVcsDriver.GitVcsDriverShape>;
}) {
  return SourceControlRepositoryService.layer.pipe(
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        get: () => Effect.succeed(input.provider ?? makeProvider()),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        execute: () => Effect.succeed(processOutput()),
        ensureRemote: () => Effect.succeed("origin"),
        pushCurrentBranch: () =>
          Effect.succeed({
            status: "pushed" as const,
            branch: "feature/remote-v1",
            upstreamBranch: "origin/feature/remote-v1",
            setUpstream: true,
          }),
        ...input.git,
      }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-control-repos-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}

it.effect("looks up repositories through the requested provider without search", () => {
  const calls: Array<{ cwd: string; repository: string }> = [];
  const provider = makeProvider({
    getRepositoryCloneUrls: (input) =>
      Effect.sync(() => {
        calls.push({ cwd: input.cwd, repository: input.repository });
        return CLONE_URLS;
      }),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.lookupRepository({
      provider: "github",
      repository: "octocat/t3code",
      cwd: "/workspace",
    });

    assert.deepStrictEqual(result, { provider: "github", ...CLONE_URLS });
    assert.deepStrictEqual(calls, [{ cwd: "/workspace", repository: "octocat/t3code" }]);
  }).pipe(Effect.provide(makeLayer({ provider })));
});

for (const { protocol, repositoryInput, remoteUrl } of [
  { protocol: undefined, repositoryInput: "octocat/t3code", remoteUrl: CLONE_URLS.url },
  { protocol: "auto", repositoryInput: "octocat/t3code", remoteUrl: CLONE_URLS.url },
  { protocol: "https", repositoryInput: CLONE_URLS.sshUrl, remoteUrl: CLONE_URLS.url },
  { protocol: "ssh", repositoryInput: "octocat/t3code", remoteUrl: CLONE_URLS.sshUrl },
  { protocol: undefined, repositoryInput: CLONE_URLS.sshUrl, remoteUrl: CLONE_URLS.sshUrl },
] as const) {
  it.effect(`clones ${repositoryInput} with ${protocol ?? "default"} protocol`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-source-control-clone-parent-",
      });
      const destinationPath = path.join(parent, "t3code");
      const cloneCalls: Array<{ cwd: string; args: ReadonlyArray<string> }> = [];

      yield* Effect.gen(function* () {
        const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
        const result = yield* service.cloneRepository({
          provider: "github",
          repository: repositoryInput,
          destinationPath,
          ...(protocol === undefined ? {} : { protocol }),
        });

        assert.deepStrictEqual(result, {
          cwd: destinationPath,
          remoteUrl,
          repository: { provider: "github", ...CLONE_URLS },
        });
        assert.deepStrictEqual(cloneCalls, [
          {
            cwd: parent,
            args: ["clone", remoteUrl, "t3code"],
          },
        ]);
      }).pipe(
        Effect.provide(
          makeLayer({
            git: {
              execute: (input) =>
                Effect.sync(() => {
                  cloneCalls.push({ cwd: input.cwd, args: input.args });
                  return processOutput();
                }),
            },
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

for (const { gitDetail, detail } of [
  {
    gitDetail:
      "git clone git@github.com:octocat/t3code.git t3code failed: Cloning into 't3code'...\nHost key verification failed.\r\nfatal: Could not read from remote repository.",
    detail:
      "SSH host key verification failed. Use an HTTPS clone URL, or verify the server's SSH host key in your terminal before retrying.",
  },
  {
    gitDetail:
      "git clone git@github.com:octocat/t3code.git t3code failed: fatal: Authentication failed",
    detail: "fatal: Authentication failed",
  },
  {
    gitDetail: "git clone git@github.com:octocat/t3code.git t3code failed with code 128.",
    detail: "git clone git@github.com:octocat/t3code.git t3code failed with code 128.",
  },
  { gitDetail: "git clone timed out.", detail: "git clone timed out." },
]) {
  it.effect(`reports clone failure: ${detail}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-clone-failure-" });
      const calls: GitVcsDriver.ExecuteGitInput[] = [];
      const gitError = new GitCommandError({
        operation: "SourceControlRepositoryService.cloneRepository",
        command: "git clone git@github.com:octocat/t3code.git t3code",
        cwd: parent,
        detail: gitDetail,
      });
      const provider = makeProvider({
        getRepositoryCloneUrls: () => Effect.die("unexpected lookup"),
      });

      yield* Effect.gen(function* () {
        const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
        const error = yield* service
          .cloneRepository({
            provider: "github",
            remoteUrl: CLONE_URLS.sshUrl,
            destinationPath: path.join(parent, "t3code"),
          })
          .pipe(Effect.flip);

        assert.instanceOf(error, SourceControlRepositoryError);
        assert.strictEqual(error.detail, detail);
        assert.strictEqual(error.provider, "github");
        assert.strictEqual(error.cause, gitError);
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(calls[0]?.args, ["clone", CLONE_URLS.sshUrl, "t3code"]);
        assert.strictEqual(calls[0]?.allowNonZeroExit, undefined);
        assert.strictEqual(calls[0]?.env, undefined);
      }).pipe(
        Effect.provide(
          makeLayer({
            provider,
            git: {
              execute: (input) =>
                Effect.gen(function* () {
                  calls.push(input);
                  return yield* gitError;
                }),
            },
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}
