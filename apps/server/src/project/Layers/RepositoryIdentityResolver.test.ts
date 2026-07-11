import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";

import * as ProcessRunner from "../../processRunner.ts";
import { RepositoryIdentityResolver } from "../Services/RepositoryIdentityResolver.ts";
import {
  makeRepositoryIdentityResolver,
  type RepositoryIdentityResolverOptions,
  RepositoryIdentityResolverLive,
  repositoryIdentityFromRemoteOutput,
} from "./RepositoryIdentityResolver.ts";

const normalizePathSeparators = (value: string) => value.replaceAll("\\", "/");

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, ...args],
      shell: process.platform === "win32",
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

const makeRepositoryIdentityResolverTestLayer = (options: RepositoryIdentityResolverOptions) =>
  Layer.effect(
    RepositoryIdentityResolver,
    makeRepositoryIdentityResolver({
      cacheCapacity: 16,
      ...options,
    }),
  ).pipe(Layer.provide(ProcessRunner.layer));

it.layer(NodeServices.layer)("RepositoryIdentityResolverLive", (it) => {
  it.effect("resolves a normalized identity and Git root from a nested workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-test-",
      });
      const nestedWorkspace = path.join(repoRoot, "packages", "web");

      yield* fileSystem.makeDirectory(nestedWorkspace, { recursive: true });
      yield* git(repoRoot, ["init"]);
      yield* git(repoRoot, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(nestedWorkspace);
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : yield* fileSystem.realPath(identity.rootPath);
      const resolvedRepoRoot = yield* fileSystem.realPath(repoRoot);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizePathSeparators(resolvedIdentityRoot)).toBe(
        normalizePathSeparators(resolvedRepoRoot),
      );
      expect(identity?.displayName).toBe("t3tools/t3code");
      expect(identity?.provider).toBe("github");
      expect(identity?.owner).toBe("t3tools");
      expect(identity?.name).toBe("t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it("maps remote output to repository identities without spawning Git", () => {
    const cases = [
      {
        name: "prefers upstream over origin",
        stdout: [
          "origin git@github.com:julius/t3code.git (fetch)",
          "origin git@github.com:julius/t3code.git (push)",
          "upstream git@github.com:T3Tools/t3code.git (fetch)",
        ].join("\n"),
        expected: {
          remoteName: "upstream",
          canonicalKey: "github.com/t3tools/t3code",
          displayName: "t3tools/t3code",
          owner: "t3tools",
          name: "t3code",
        },
      },
      {
        name: "uses the last path segment for nested GitLab groups",
        stdout: "origin git@gitlab.com:T3Tools/platform/t3code.git (fetch)",
        expected: {
          remoteName: "origin",
          canonicalKey: "gitlab.com/t3tools/platform/t3code",
          displayName: "t3tools/platform/t3code",
          owner: "t3tools",
          name: "t3code",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const identity = repositoryIdentityFromRemoteOutput(testCase.stdout, "/repo");
      expect(identity, testCase.name).toMatchObject({
        canonicalKey: testCase.expected.canonicalKey,
        displayName: testCase.expected.displayName,
        owner: testCase.expected.owner,
        name: testCase.expected.name,
        rootPath: "/repo",
        locator: {
          source: "git-remote",
          remoteName: testCase.expected.remoteName,
        },
      });
    }

    expect(repositoryIdentityFromRemoteOutput("", "/repo")).toBeNull();
  });

  it.effect("caches missing identities until the negative TTL expires", () => {
    let remoteOutput = "";
    let loadCount = 0;
    const layer = makeRepositoryIdentityResolverTestLayer({
      negativeCacheTtl: Duration.millis(50),
      positiveCacheTtl: Duration.seconds(1),
      resolveCacheKey: () => Effect.succeed("/repo"),
      resolveFromCacheKey: (rootPath) =>
        Effect.sync(() => {
          loadCount += 1;
          return repositoryIdentityFromRemoteOutput(remoteOutput, rootPath);
        }),
    });

    return Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver;
      expect(yield* resolver.resolve("/workspace")).toBeNull();

      remoteOutput = "origin git@github.com:T3Tools/t3code.git (fetch)";
      expect(yield* resolver.resolve("/workspace")).toBeNull();
      expect(loadCount).toBe(1);

      yield* TestClock.adjust(Duration.millis(60));

      const refreshed = yield* resolver.resolve("/workspace");
      expect(refreshed?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(loadCount).toBe(2);
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), layer)));
  });

  it.effect("refreshes identities after the positive TTL", () => {
    let remoteOutput = "origin git@github.com:T3Tools/t3code.git (fetch)";
    let loadCount = 0;
    const layer = makeRepositoryIdentityResolverTestLayer({
      negativeCacheTtl: Duration.millis(50),
      positiveCacheTtl: Duration.millis(100),
      resolveCacheKey: () => Effect.succeed("/repo"),
      resolveFromCacheKey: (rootPath) =>
        Effect.sync(() => {
          loadCount += 1;
          return repositoryIdentityFromRemoteOutput(remoteOutput, rootPath);
        }),
    });

    return Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver;
      expect((yield* resolver.resolve("/workspace"))?.canonicalKey).toBe(
        "github.com/t3tools/t3code",
      );

      remoteOutput = "origin git@github.com:T3Tools/t3code-next.git (fetch)";
      expect((yield* resolver.resolve("/workspace"))?.canonicalKey).toBe(
        "github.com/t3tools/t3code",
      );
      expect(loadCount).toBe(1);

      yield* TestClock.adjust(Duration.millis(110));

      const refreshed = yield* resolver.resolve("/workspace");
      expect(refreshed?.canonicalKey).toBe("github.com/t3tools/t3code-next");
      expect(refreshed?.name).toBe("t3code-next");
      expect(loadCount).toBe(2);
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), layer)));
  });
});
