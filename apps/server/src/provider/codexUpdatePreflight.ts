import type { ProviderDriverKind } from "@cafecode/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { ProviderMaintenanceCommandAction } from "./providerMaintenance.ts";

const CODEX_PACKAGE_NAME = "@openai/codex";
const REGISTRY_PACKAGE_URL = `https://registry.npmjs.org/${encodeURIComponent(CODEX_PACKAGE_NAME)}`;
// This is a metadata admission check, not an install or provider probe. One
// deadline includes both requests and body reads so a partial response cannot
// indefinitely hold the existing update-command lock.
export const CODEX_UPDATE_PREFLIGHT_TIMEOUT_MS = 8_000;
export const CODEX_UPDATE_MANIFEST_MAX_BYTES = 256 * 1024;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

export type CodexUpdatePreflightReason =
  | "unsupported_platform"
  | "registry_unavailable"
  | "invalid_manifest"
  | "native_package_unavailable";

export class CodexUpdatePreflightError extends Data.TaggedError("CodexUpdatePreflightError")<{
  readonly reason: CodexUpdatePreflightReason;
}> {
  // Registry responses and HTTP errors can contain arbitrary remote content.
  // Retain only a fixed classification; never attach their bodies or causes.
  override get message(): string {
    switch (this.reason) {
      case "unsupported_platform":
        return "Cafe Code cannot verify a Codex update for this platform. Update Codex manually.";
      case "registry_unavailable":
        return "Cafe Code could not verify the Codex update with the official package registry. Try again later.";
      case "invalid_manifest":
        return "The Codex update metadata could not be verified. Try again later.";
      case "native_package_unavailable":
        return "The latest Codex release is not fully published for this platform yet. Try again later.";
    }
  }
}

export type PreparedCodexProviderUpdate = ProviderMaintenanceCommandAction & {
  /** Exact release admitted by the preflight, for the post-update runtime check. */
  readonly verifiedTargetVersion?: string;
};

const Distribution = Schema.Struct({ tarball: Schema.String, integrity: Schema.String });
const WrapperManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  optionalDependencies: Schema.Record(Schema.String, Schema.String),
  dist: Distribution,
});
const NativeManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  os: Schema.Array(Schema.String),
  cpu: Schema.Array(Schema.String),
  dist: Distribution,
});
const decodeManifestJson = Schema.decodeEffect(Schema.UnknownFromJsonString);
const decodeWrapperManifest = Schema.decodeUnknownEffect(WrapperManifest);
const decodeNativeManifest = Schema.decodeUnknownEffect(NativeManifest);

function invalidManifest(): CodexUpdatePreflightError {
  return new CodexUpdatePreflightError({ reason: "invalid_manifest" });
}

function distributionMatches(distribution: typeof Distribution.Type, version: string): boolean {
  // The official wrapper aliases its six native packages back to platform
  // versions of the same registry package. Do not follow metadata-selected
  // package names, hosts or tarball URLs. An integrity entry is required, but
  // this preflight does not download the archive or claim to verify its hash;
  // archive verification remains the existing installer's responsibility.
  return (
    distribution.tarball === `https://registry.npmjs.org/@openai/codex/-/codex-${version}.tgz` &&
    SHA512_INTEGRITY.test(distribution.integrity)
  );
}

const readManifest = Effect.fn("CodexUpdatePreflight.readManifest")(function* (
  client: HttpClient.HttpClient,
  version: string,
  native: boolean,
) {
  const response = yield* client
    .execute(
      HttpClientRequest.get(`${REGISTRY_PACKAGE_URL}/${version}`).pipe(
        HttpClientRequest.setHeader("accept", "application/json"),
      ),
    )
    .pipe(Effect.mapError(() => new CodexUpdatePreflightError({ reason: "registry_unavailable" })));
  if (response.status !== 200) {
    return yield* new CodexUpdatePreflightError({
      reason:
        native && response.status === 404 ? "native_package_unavailable" : "registry_unavailable",
    });
  }

  // Count received bytes rather than trusting Content-Length. Stop consuming
  // on overflow; unlike process output, this HTTP stream need not be drained.
  const body = yield* response.stream.pipe(
    Stream.runFoldEffect(
      () => ({ bytes: 0, chunks: [] as Uint8Array[] }),
      (state, chunk) => {
        if (chunk.byteLength > CODEX_UPDATE_MANIFEST_MAX_BYTES - state.bytes) {
          return Effect.fail(invalidManifest());
        }
        state.bytes += chunk.byteLength;
        state.chunks.push(chunk);
        return Effect.succeed(state);
      },
    ),
    Effect.mapError((error) =>
      error instanceof CodexUpdatePreflightError
        ? error
        : new CodexUpdatePreflightError({ reason: "registry_unavailable" }),
    ),
  );
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(body.chunks)),
    catch: invalidManifest,
  });
  return yield* decodeManifestJson(text).pipe(Effect.mapError(invalidManifest));
});

/**
 * Admit an existing package-managed Codex update only after its host-native
 * optional dependency is published, then freeze the wrapper version in argv.
 *
 * Codex 0.157.0's wrapper reached `latest` before its macOS ARM64 package. A
 * package manager can treat a missing optional dependency as a successful
 * install, so checking only the wrapper would allow a working CLI to break.
 * The alias contract is pinned to the official release manifest:
 * https://registry.npmjs.org/@openai/codex/0.157.0
 *
 * This helper neither selects nor executes a package manager. It only refines
 * the already-authorized structured command; native/Homebrew actions and
 * other providers pass through without network requests. The latest advisory
 * cache is intentionally bypassed because update admission needs fresh data.
 */
export function prepareCodexProviderUpdate(
  provider: ProviderDriverKind,
  update: ProviderMaintenanceCommandAction,
  options: { readonly platform?: NodeJS.Platform; readonly arch?: string } = {},
): Effect.Effect<PreparedCodexProviderUpdate, CodexUpdatePreflightError, HttpClient.HttpClient> {
  const targetIndexes = update.args.flatMap((arg, index) =>
    arg === CODEX_PACKAGE_NAME || arg === `${CODEX_PACKAGE_NAME}@latest` ? [index] : [],
  );
  if (provider !== "codex" || targetIndexes.length === 0) {
    return Effect.succeed(update);
  }

  const preflight = Effect.gen(function* () {
    if (targetIndexes.length !== 1) {
      return yield* invalidManifest();
    }
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    // These are the launcher's six official optional package aliases. Do not
    // infer support for another operating system or architecture from strings
    // returned by the registry, nor install a different platform's binary.
    if (!["darwin", "linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) {
      return yield* new CodexUpdatePreflightError({ reason: "unsupported_platform" });
    }
    const client = yield* HttpClient.HttpClient;
    const wrapper = yield* readManifest(client, "latest", false).pipe(
      Effect.flatMap(decodeWrapperManifest),
      Effect.mapError((error) =>
        error instanceof CodexUpdatePreflightError ? error : invalidManifest(),
      ),
    );
    // A short strict release version is both the immutable install target and
    // a URL component. Reject prereleases, ranges, leading zeros and oversized
    // values instead of letting registry text become command-line syntax.
    if (
      wrapper.name !== CODEX_PACKAGE_NAME ||
      wrapper.version.length > 64 ||
      !STABLE_VERSION.test(wrapper.version) ||
      !distributionMatches(wrapper.dist, wrapper.version)
    ) {
      return yield* invalidManifest();
    }
    const nativeVersion = `${wrapper.version}-${platform}-${arch}`;
    const nativeAlias = `${CODEX_PACKAGE_NAME}-${platform}-${arch}`;
    if (
      wrapper.optionalDependencies[nativeAlias] !== `npm:${CODEX_PACKAGE_NAME}@${nativeVersion}`
    ) {
      return yield* invalidManifest();
    }
    const native = yield* readManifest(client, nativeVersion, true).pipe(
      Effect.flatMap(decodeNativeManifest),
      Effect.mapError((error) =>
        error instanceof CodexUpdatePreflightError ? error : invalidManifest(),
      ),
    );
    if (
      native.name !== CODEX_PACKAGE_NAME ||
      native.version !== nativeVersion ||
      native.os.length !== 1 ||
      native.os[0] !== platform ||
      native.cpu.length !== 1 ||
      native.cpu[0] !== arch ||
      !distributionMatches(native.dist, nativeVersion)
    ) {
      return yield* invalidManifest();
    }

    // Re-resolving `latest` during install could otherwise pick a different,
    // unverified release. Preserve every other argument and the existing
    // executable/serialization/lock policy owned by maintenance capabilities.
    const args = update.args.map((arg, index) =>
      index === targetIndexes[0] ? `${CODEX_PACKAGE_NAME}@${wrapper.version}` : arg,
    );
    return {
      ...update,
      args,
      command: [update.executable, ...args].join(" "),
      verifiedTargetVersion: wrapper.version,
    } satisfies PreparedCodexProviderUpdate;
  });
  return preflight.pipe(
    Effect.timeoutOption(CODEX_UPDATE_PREFLIGHT_TIMEOUT_MS),
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          Effect.fail(new CodexUpdatePreflightError({ reason: "registry_unavailable" })),
      }),
    ),
  );
}
