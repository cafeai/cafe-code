import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";

import {
  CODEX_UPDATE_MANIFEST_MAX_BYTES,
  CODEX_UPDATE_PREFLIGHT_TIMEOUT_MS,
  prepareCodexProviderUpdate,
} from "./codexUpdatePreflight.ts";
import type { ProviderMaintenanceCommandAction } from "./providerMaintenance.ts";

const codex = ProviderDriverKind.make("codex");
const latestUrl = "https://registry.npmjs.org/%40openai%2Fcodex/latest";
const release = "0.157.0";
const host = { platform: "darwin", arch: "arm64" } as const;
const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
const action: ProviderMaintenanceCommandAction = {
  executable: "existing-package-updater",
  args: ["install", "-g", "@openai/codex@latest"],
  command: "existing-package-updater install -g @openai/codex@latest",
  lockKey: "existing-update-lock",
};

function distribution(version: string) {
  return {
    tarball: `https://registry.npmjs.org/@openai/codex/-/codex-${version}.tgz`,
    integrity,
  };
}

function manifests(platform: string = host.platform, arch: string = host.arch, version = release) {
  const nativeVersion = `${version}-${platform}-${arch}`;
  return {
    wrapper: {
      name: "@openai/codex",
      version,
      optionalDependencies: {
        [`@openai/codex-${platform}-${arch}`]: `npm:@openai/codex@${nativeVersion}`,
      },
      dist: distribution(version),
    },
    native: {
      name: "@openai/codex",
      version: nativeVersion,
      os: [platform],
      cpu: [arch],
      dist: distribution(nativeVersion),
    },
  };
}

function registryClient(resolve: (url: string) => Response, requests: string[] = []) {
  return HttpClient.make((request) => {
    requests.push(request.url);
    return Effect.succeed(HttpClientResponse.fromWeb(request, resolve(request.url)));
  });
}

function manifestClient(wrapper: unknown, native: unknown, requests: string[] = []) {
  return registryClient((url) => Response.json(url === latestUrl ? wrapper : native), requests);
}

describe("Codex update preflight", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    for (const arch of ["x64", "arm64"] as const) {
      it.effect(`pins the official ${platform}/${arch} native package before update`, () => {
        const { wrapper, native } = manifests(platform, arch);
        const requests: string[] = [];
        return Effect.gen(function* () {
          const prepared = yield* prepareCodexProviderUpdate(codex, action, { platform, arch });
          assert.deepStrictEqual(requests, [
            latestUrl,
            `https://registry.npmjs.org/%40openai%2Fcodex/${release}-${platform}-${arch}`,
          ]);
          assert.deepStrictEqual(prepared, {
            ...action,
            args: ["install", "-g", `@openai/codex@${release}`],
            command: `existing-package-updater install -g @openai/codex@${release}`,
            verifiedTargetVersion: release,
          });
          assert.strictEqual(action.args[2], "@openai/codex@latest");
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, manifestClient(wrapper, native, requests)),
        );
      });
    }
  }

  it.effect("pins an existing unversioned target without choosing a different updater", () => {
    const { wrapper, native } = manifests();
    return Effect.gen(function* () {
      const unversioned = { ...action, args: ["add", "@openai/codex", "--global"] };
      const prepared = yield* prepareCodexProviderUpdate(codex, unversioned, host);
      assert.deepStrictEqual(prepared.args, ["add", `@openai/codex@${release}`, "--global"]);
      assert.strictEqual(prepared.executable, unversioned.executable);
      assert.strictEqual(prepared.lockKey, unversioned.lockKey);
    }).pipe(Effect.provideService(HttpClient.HttpClient, manifestClient(wrapper, native)));
  });

  it.effect("does not touch other providers or native update actions", () => {
    let requests = 0;
    return Effect.gen(function* () {
      assert.strictEqual(
        yield* prepareCodexProviderUpdate(ProviderDriverKind.make("claudeAgent"), action, host),
        action,
      );
      const nativeAction = { ...action, args: ["upgrade", "codex"] };
      assert.strictEqual(
        yield* prepareCodexProviderUpdate(codex, nativeAction, host),
        nativeAction,
      );
      assert.strictEqual(requests, 0);
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        registryClient(() => {
          requests += 1;
          return Response.json({});
        }),
      ),
    );
  });

  it.effect("rejects an unsupported host before contacting the registry", () => {
    const requests: string[] = [];
    return Effect.gen(function* () {
      for (const unsupported of [
        { platform: "freebsd", arch: "x64" },
        { platform: "linux", arch: "riscv64" },
      ] as const) {
        const error = yield* prepareCodexProviderUpdate(codex, action, unsupported).pipe(
          Effect.flip,
        );
        assert.strictEqual(error.reason, "unsupported_platform");
      }
      assert.deepStrictEqual(requests, []);
    }).pipe(Effect.provideService(HttpClient.HttpClient, manifestClient({}, {}, requests)));
  });

  it.effect("fails before update when the wrapper precedes its host-native publication", () => {
    const { wrapper } = manifests();
    const requests: string[] = [];
    return Effect.gen(function* () {
      const error = yield* prepareCodexProviderUpdate(codex, action, host).pipe(Effect.flip);
      assert.strictEqual(error.reason, "native_package_unavailable");
      assert.match(error.message, /not fully published/);
      assert.strictEqual(requests.length, 2);
      assert.strictEqual("cause" in error, false);
      assert.notMatch(JSON.stringify(error), /private registry response/);
      assert.strictEqual(action.args[2], "@openai/codex@latest");
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        registryClient(
          (url) =>
            url === latestUrl
              ? Response.json(wrapper)
              : new Response("private registry response", { status: 404 }),
          requests,
        ),
      ),
    );
  });

  for (const version of ["0.157.0-alpha.1", "01.157.0", "^0.157.0", "0.157.0/other", "latest"]) {
    it.effect(`rejects unsafe or non-stable wrapper version ${JSON.stringify(version)}`, () => {
      const { wrapper, native } = manifests(host.platform, host.arch, version);
      const requests: string[] = [];
      return Effect.gen(function* () {
        const error = yield* prepareCodexProviderUpdate(codex, action, host).pipe(Effect.flip);
        assert.strictEqual(error.reason, "invalid_manifest");
        assert.deepStrictEqual(requests, [latestUrl]);
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, manifestClient(wrapper, native, requests)),
      );
    });
  }

  for (const alias of [
    undefined,
    "npm:@other/codex@0.157.0-darwin-arm64",
    "npm:@openai/codex@0.156.0-darwin-arm64",
    "npm:@openai/codex@0.157.0-linux-arm64",
    "npm:@openai/codex@latest",
  ]) {
    it.effect(`rejects an absent or mismatched host alias ${JSON.stringify(alias)}`, () => {
      const { wrapper, native } = manifests();
      const requests: string[] = [];
      const changed = {
        ...wrapper,
        optionalDependencies: alias === undefined ? {} : { "@openai/codex-darwin-arm64": alias },
      };
      return Effect.gen(function* () {
        const error = yield* prepareCodexProviderUpdate(codex, action, host).pipe(Effect.flip);
        assert.strictEqual(error.reason, "invalid_manifest");
        assert.deepStrictEqual(requests, [latestUrl]);
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, manifestClient(changed, native, requests)),
      );
    });
  }

  for (const [description, override] of [
    ["wrong package", { name: "@other/codex" }],
    ["wrong native version", { version: "0.156.0-darwin-arm64" }],
    ["wrong OS", { os: ["linux"] }],
    ["wrong CPU", { cpu: ["x64"] }],
    ["missing distribution", { dist: undefined }],
    [
      "untrusted tarball",
      {
        dist: {
          ...distribution("0.157.0-darwin-arm64"),
          tarball: "https://example.invalid/native.tgz",
        },
      },
    ],
    ["missing integrity", { dist: { tarball: distribution("0.157.0-darwin-arm64").tarball } }],
    [
      "invalid integrity",
      { dist: { ...distribution("0.157.0-darwin-arm64"), integrity: "sha512-not-a-digest" } },
    ],
  ] as const) {
    it.effect(`rejects incomplete native metadata: ${description}`, () => {
      const { wrapper, native } = manifests();
      return Effect.gen(function* () {
        const error = yield* prepareCodexProviderUpdate(codex, action, host).pipe(Effect.flip);
        assert.strictEqual(error.reason, "invalid_manifest");
        assert.strictEqual("cause" in error, false);
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          manifestClient(wrapper, { ...native, ...override }),
        ),
      );
    });
  }

  it.effect("sanitizes malformed JSON and limits actual received body bytes", () => {
    return Effect.gen(function* () {
      for (const body of [
        "private malformed body",
        " ".repeat(CODEX_UPDATE_MANIFEST_MAX_BYTES + 1),
      ]) {
        const error = yield* prepareCodexProviderUpdate(codex, action, host).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            registryClient(() => new Response(body)),
          ),
          Effect.flip,
        );
        assert.strictEqual(error.reason, "invalid_manifest");
        assert.strictEqual("cause" in error, false);
        assert.notMatch(error.message, /private malformed body/);
      }
    });
  });

  it.effect("sanitizes registry transport failures", () =>
    Effect.gen(function* () {
      const error = yield* prepareCodexProviderUpdate(codex, action, host).pipe(Effect.flip);
      assert.strictEqual(error.reason, "registry_unavailable");
      assert.strictEqual("cause" in error, false);
      assert.notMatch(JSON.stringify(error), /private-transport-detail/);
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                description: "private-transport-detail",
              }),
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("bounds a response whose headers arrive but body never completes", () =>
    Effect.gen(function* () {
      const fiber = yield* prepareCodexProviderUpdate(codex, action, host).pipe(
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust(CODEX_UPDATE_PREFLIGHT_TIMEOUT_MS + 1);
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error.reason, "registry_unavailable");
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        registryClient(() => new Response(new ReadableStream<Uint8Array>())),
      ),
    ),
  );

  it.effect("uses fresh manifests for a retry and freezes each observed latest version", () => {
    const requests: string[] = [];
    let latestReads = 0;
    const first = manifests();
    const second = manifests(host.platform, host.arch, "0.158.0");
    return Effect.gen(function* () {
      const prepared = yield* prepareCodexProviderUpdate(codex, action, host);
      const retried = yield* prepareCodexProviderUpdate(codex, action, host);
      assert.strictEqual(prepared.verifiedTargetVersion, "0.157.0");
      assert.strictEqual(retried.verifiedTargetVersion, "0.158.0");
      assert.deepStrictEqual(requests, [
        latestUrl,
        "https://registry.npmjs.org/%40openai%2Fcodex/0.157.0-darwin-arm64",
        latestUrl,
        "https://registry.npmjs.org/%40openai%2Fcodex/0.158.0-darwin-arm64",
      ]);
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        registryClient((url) => {
          if (url === latestUrl) {
            latestReads += 1;
            return Response.json(latestReads === 1 ? first.wrapper : second.wrapper);
          }
          return Response.json(url.includes("0.157.0") ? first.native : second.native);
        }, requests),
      ),
    );
  });
});
