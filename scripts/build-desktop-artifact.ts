#!/usr/bin/env node

import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { getDefaultBuildArch } from "./lib/build-target-arch.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

import { createHash } from "node:crypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  cafeCodeConfigWithDefault,
  cafeCodeOptionalConfig,
  readCafeCodeEnv,
} from "@cafecode/shared/compatEnv";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const BuildPlatform = Schema.Literals(["mac", "linux", "win"]);
const BuildArch = Schema.Literals(["arm64", "x64", "universal"]);

export const MANAGED_WINDOWS_NODE_VERSION = "24.13.1";

const MANAGED_WINDOWS_NODE_ARCHIVE_HASHES = {
  x64: "fba577c4bb87df04d54dd87bbdaa5a2272f1f99a2acbf9152e1a91b8b5f0b279",
  arm64: "0cd29eeb64f3c649db2c4c868779ca277f5a4c49e26c69e5928d01fe0ae06da8",
} as const;

interface ManagedWindowsNodeArchive {
  readonly arch: "x64" | "arm64";
  readonly fileName: string;
  readonly sourceDirectoryName: string;
  readonly sha256: string;
  readonly url: string;
}

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const encodeJsonString = Schema.encodeEffect(Schema.UnknownFromJsonString);

interface DesktopBuildIconAssets {
  readonly macIconPng: string;
  readonly linuxIconPng: string;
  readonly windowsIconIco: string;
}

interface PlatformConfig {
  readonly cliFlag: "--mac" | "--linux" | "--win";
  readonly defaultTarget: string;
  readonly archChoices: ReadonlyArray<typeof BuildArch.Type>;
}

const PLATFORM_CONFIG: Record<typeof BuildPlatform.Type, PlatformConfig> = {
  mac: {
    cliFlag: "--mac",
    defaultTarget: "dmg",
    archChoices: ["arm64", "x64", "universal"],
  },
  linux: {
    cliFlag: "--linux",
    defaultTarget: "AppImage",
    archChoices: ["x64", "arm64"],
  },
  win: {
    cliFlag: "--win",
    defaultTarget: "nsis",
    archChoices: ["x64", "arm64"],
  },
};

interface BuildCliInput {
  readonly platform: Option.Option<typeof BuildPlatform.Type>;
  readonly target: Option.Option<string>;
  readonly arch: Option.Option<typeof BuildArch.Type>;
  readonly buildVersion: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly skipBuild: Option.Option<boolean>;
  readonly keepStage: Option.Option<boolean>;
  readonly signed: Option.Option<boolean>;
  readonly verbose: Option.Option<boolean>;
  readonly mockUpdates: Option.Option<boolean>;
  readonly mockUpdateServerPort: Option.Option<number>;
}

function detectHostBuildPlatform(hostPlatform: string): typeof BuildPlatform.Type | undefined {
  if (hostPlatform === "darwin") return "mac";
  if (hostPlatform === "linux") return "linux";
  if (hostPlatform === "win32") return "win";
  return undefined;
}

function getDefaultArch(platform: typeof BuildPlatform.Type): typeof BuildArch.Type {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    return "x64";
  }

  return getDefaultBuildArch(platform, process.arch, process.env, config);
}

class BuildScriptError extends Data.TaggedError("BuildScriptError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const spawnAndCollectOutput = Effect.fn("spawnAndCollectOutput")(function* (
  command: ChildProcess.Command,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  return { stdout, stderr, exitCode } as const;
});

const resolveGitCommitHash = Effect.fn("resolveGitCommitHash")(function* (repoRoot: string) {
  const result = yield* spawnAndCollectOutput(
    ChildProcess.make("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: repoRoot,
    }),
  ).pipe(
    Effect.catch(() =>
      Effect.succeed({
        stdout: "",
        stderr: "",
        exitCode: 1,
      }),
    ),
  );

  if (result.exitCode !== 0) {
    return "unknown";
  }
  const hash = result.stdout.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
    return "unknown";
  }
  return hash.toLowerCase();
});

const resolvePythonForNodeGyp = Effect.fn("resolvePythonForNodeGyp")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configured = process.env.npm_config_python ?? process.env.PYTHON;
  if (configured && (yield* fs.exists(configured))) {
    return configured;
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      for (const version of ["Python313", "Python312", "Python311", "Python310"]) {
        const candidate = path.join(localAppData, "Programs", "Python", version, "python.exe");
        if (yield* fs.exists(candidate)) {
          return candidate;
        }
      }
    }
  }

  const probe = yield* spawnAndCollectOutput(
    ChildProcess.make("python", ["-c", "import sys;print(sys.executable)"]),
  ).pipe(
    Effect.catch(() =>
      Effect.succeed({
        stdout: "",
        stderr: "",
        exitCode: 1,
      }),
    ),
  );

  if (probe.exitCode !== 0) {
    return undefined;
  }

  const executable = probe.stdout.trim();
  if (!executable || !(yield* fs.exists(executable))) {
    return undefined;
  }

  return executable;
});

interface ResolvedBuildOptions {
  readonly platform: typeof BuildPlatform.Type;
  readonly target: string;
  readonly arch: typeof BuildArch.Type;
  readonly version: string | undefined;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly signed: boolean;
  readonly verbose: boolean;
  readonly mockUpdates: boolean;
  readonly mockUpdateServerPort: number | undefined;
}

interface StagePackageJson {
  readonly name: string;
  readonly version: string;
  readonly buildVersion: string;
  readonly cafeCodeCommitHash: string;
  readonly private: true;
  readonly description: string;
  readonly author: string;
  readonly homepage: string;
  readonly license: string;
  readonly main: string;
  readonly build: Record<string, unknown>;
  readonly dependencies: Record<string, unknown>;
  readonly devDependencies: {
    readonly electron: string;
  };
  readonly overrides: Record<string, unknown>;
}

const AzureTrustedSigningOptionsConfig = Config.all({
  publisherName: Config.string("AZURE_TRUSTED_SIGNING_PUBLISHER_NAME"),
  endpoint: Config.string("AZURE_TRUSTED_SIGNING_ENDPOINT"),
  certificateProfileName: Config.string("AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME"),
  codeSigningAccountName: Config.string("AZURE_TRUSTED_SIGNING_ACCOUNT_NAME"),
  fileDigest: Config.string("AZURE_TRUSTED_SIGNING_FILE_DIGEST").pipe(Config.withDefault("SHA256")),
  timestampDigest: Config.string("AZURE_TRUSTED_SIGNING_TIMESTAMP_DIGEST").pipe(
    Config.withDefault("SHA256"),
  ),
  timestampRfc3161: Config.string("AZURE_TRUSTED_SIGNING_TIMESTAMP_RFC3161").pipe(
    Config.withDefault("http://timestamp.acs.microsoft.com"),
  ),
});

const BuildEnvConfig = Config.all({
  platform: cafeCodeOptionalConfig("CAFE_CODE_DESKTOP_PLATFORM", (name) =>
    Config.schema(BuildPlatform, name),
  ),
  target: cafeCodeOptionalConfig("CAFE_CODE_DESKTOP_TARGET", Config.string),
  arch: cafeCodeOptionalConfig("CAFE_CODE_DESKTOP_ARCH", (name) => Config.schema(BuildArch, name)),
  version: cafeCodeOptionalConfig("CAFE_CODE_DESKTOP_VERSION", Config.string),
  outputDir: cafeCodeOptionalConfig("CAFE_CODE_DESKTOP_OUTPUT_DIR", Config.string),
  skipBuild: cafeCodeConfigWithDefault("CAFE_CODE_DESKTOP_SKIP_BUILD", Config.boolean, false),
  keepStage: cafeCodeConfigWithDefault("CAFE_CODE_DESKTOP_KEEP_STAGE", Config.boolean, false),
  signed: cafeCodeConfigWithDefault("CAFE_CODE_DESKTOP_SIGNED", Config.boolean, false),
  verbose: cafeCodeConfigWithDefault("CAFE_CODE_DESKTOP_VERBOSE", Config.boolean, false),
  mockUpdates: cafeCodeConfigWithDefault("CAFE_CODE_DESKTOP_MOCK_UPDATES", Config.boolean, false),
  mockUpdateServerPort: cafeCodeOptionalConfig(
    "CAFE_CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT",
    Config.string,
  ),
});

const MockUpdateServerPortSchema = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 65535 }),
);
const decodeMockUpdateServerPort = Schema.decodeUnknownEffect(MockUpdateServerPortSchema);

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(flag, () => envValue);
const mergeOptions = <A>(a: Option.Option<A>, b: Option.Option<A>, defaultValue: A) =>
  Option.getOrElse(a, () => Option.getOrElse(b, () => defaultValue));

export const resolveMockUpdateServerPort = Effect.fn("resolveMockUpdateServerPort")(function* (
  mockUpdateServerPort: string | undefined,
) {
  const port = mockUpdateServerPort?.trim();
  if (!port) {
    return undefined;
  }

  return yield* decodeMockUpdateServerPort(port);
});

export const resolveBuildOptions = Effect.fn("resolveBuildOptions")(function* (
  input: BuildCliInput,
) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const env = yield* BuildEnvConfig.asEffect();

  const platform = mergeOptions(
    input.platform,
    env.platform,
    detectHostBuildPlatform(process.platform),
  );

  if (!platform) {
    return yield* new BuildScriptError({
      message: `Unsupported host platform '${process.platform}'.`,
    });
  }

  const target = mergeOptions(input.target, env.target, PLATFORM_CONFIG[platform].defaultTarget);
  const arch = mergeOptions(input.arch, env.arch, getDefaultArch(platform));
  const version = mergeOptions(input.buildVersion, env.version, undefined);
  const releaseDir = resolveBooleanFlag(input.mockUpdates, env.mockUpdates)
    ? "release-mock"
    : "release";
  const outputDir = path.resolve(
    repoRoot,
    mergeOptions(input.outputDir, env.outputDir, releaseDir),
  );

  const skipBuild = resolveBooleanFlag(input.skipBuild, env.skipBuild);
  const keepStage = resolveBooleanFlag(input.keepStage, env.keepStage);
  const signed = resolveBooleanFlag(input.signed, env.signed);
  const verbose = resolveBooleanFlag(input.verbose, env.verbose);

  const mockUpdates = resolveBooleanFlag(input.mockUpdates, env.mockUpdates);
  const mockUpdateServerPort =
    Option.getOrUndefined(input.mockUpdateServerPort) ??
    (yield* resolveMockUpdateServerPort(Option.getOrUndefined(env.mockUpdateServerPort)).pipe(
      Effect.mapError(
        (cause) =>
          new BuildScriptError({
            message: "Invalid mock update server port.",
            cause,
          }),
      ),
    ));

  return {
    platform,
    target,
    arch,
    version,
    outputDir,
    skipBuild,
    keepStage,
    signed,
    verbose,
    mockUpdates,
    mockUpdateServerPort,
  } satisfies ResolvedBuildOptions;
});

export function isWindowsNsisInstallerTarget(target: string): boolean {
  return target === "nsis" || target === "nsis-web";
}

export function shouldStageWindowsManagedRuntime(
  platform: typeof BuildPlatform.Type,
  target: string,
): boolean {
  return platform === "win" && isWindowsNsisInstallerTarget(target);
}

export function desktopArtifactListSatisfiesTarget(
  platform: typeof BuildPlatform.Type,
  target: string,
  artifactPaths: ReadonlyArray<string>,
): boolean {
  if (platform === "win" && isWindowsNsisInstallerTarget(target)) {
    return artifactPaths.some((artifactPath) => artifactPath.toLowerCase().endsWith(".exe"));
  }

  if (platform === "linux" && target.toLowerCase() === "deb") {
    return artifactPaths.some((artifactPath) => artifactPath.toLowerCase().endsWith(".deb"));
  }

  return artifactPaths.length > 0;
}

export function resolveManagedWindowsNodeArchive(
  arch: typeof BuildArch.Type,
): ManagedWindowsNodeArchive | null {
  if (arch !== "x64" && arch !== "arm64") {
    return null;
  }

  const sourceDirectoryName = `node-v${MANAGED_WINDOWS_NODE_VERSION}-win-${arch}`;
  const fileName = `${sourceDirectoryName}.zip`;
  return {
    arch,
    fileName,
    sourceDirectoryName,
    sha256: MANAGED_WINDOWS_NODE_ARCHIVE_HASHES[arch],
    url: `https://nodejs.org/dist/v${MANAGED_WINDOWS_NODE_VERSION}/${fileName}`,
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function quotePowerShellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const commandOutputOptions = (verbose: boolean) =>
  ({
    stdout: verbose ? "inherit" : "ignore",
    stderr: "inherit",
  }) as const;

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.Command) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* commandSpawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new BuildScriptError({
      message: `Command exited with non-zero exit code (${exitCode})`,
    });
  }
});

function generateMacIconSet(
  sourcePng: string,
  targetIcns: string,
  tmpRoot: string,
  path: Path.Path,
  verbose: boolean,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const iconsetDir = path.join(tmpRoot, "icon.iconset");
    yield* fs.makeDirectory(iconsetDir, { recursive: true });

    const iconSizes = [16, 32, 128, 256, 512] as const;
    for (const size of iconSizes) {
      yield* runCommand(
        ChildProcess.make({
          ...commandOutputOptions(verbose),
        })`sips -z ${size} ${size} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}.png`)}`,
      );

      const retinaSize = size * 2;
      yield* runCommand(
        ChildProcess.make({
          ...commandOutputOptions(verbose),
        })`sips -z ${retinaSize} ${retinaSize} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}@2x.png`)}`,
      );
    }

    yield* runCommand(
      ChildProcess.make({
        ...commandOutputOptions(verbose),
      })`iconutil -c icns ${iconsetDir} -o ${targetIcns}`,
    );
  });
}

function stageMacIcons(stageResourcesDir: string, sourcePng: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourcePng))) {
      return yield* new BuildScriptError({
        message: `Desktop macOS icon source is missing at ${sourcePng}`,
      });
    }

    const tmpRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "cafecode-icon-build-",
    });

    const iconPngPath = path.join(stageResourcesDir, "icon.png");
    const iconIcnsPath = path.join(stageResourcesDir, "icon.icns");

    yield* runCommand(
      ChildProcess.make({
        ...commandOutputOptions(verbose),
      })`sips -z 512 512 ${sourcePng} --out ${iconPngPath}`,
    );

    yield* generateMacIconSet(sourcePng, iconIcnsPath, tmpRoot, path, verbose);
  });
}

function stageLinuxIcons(stageResourcesDir: string, sourcePng: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourcePng))) {
      return yield* new BuildScriptError({
        message: `Desktop Linux icon source is missing at ${sourcePng}`,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.png");
    yield* fs.copyFile(sourcePng, iconPath);
  });
}

function stageWindowsIcons(stageResourcesDir: string, sourceIco: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourceIco))) {
      return yield* new BuildScriptError({
        message: `Desktop Windows icon source is missing at ${sourceIco}`,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.ico");
    yield* fs.copyFile(sourceIco, iconPath);
  });
}

const ensureManagedWindowsNodeArchive = Effect.fn("ensureManagedWindowsNodeArchive")(function* (
  archive: ManagedWindowsNodeArchive,
  cacheDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(cacheDir, { recursive: true });

  const archivePath = path.join(cacheDir, archive.fileName);
  if (yield* fs.exists(archivePath)) {
    const cachedBytes = yield* fs.readFile(archivePath);
    const cachedHash = sha256Hex(cachedBytes);
    if (cachedHash === archive.sha256) {
      return archivePath;
    }

    yield* Effect.logWarning(
      `[desktop-artifact] Cached managed Node archive hash mismatch; re-downloading ${archive.fileName}.`,
    ).pipe(
      Effect.annotateLogs({
        expectedSha256: archive.sha256,
        actualSha256: cachedHash,
      }),
    );
    yield* fs.remove(archivePath, { force: true }).pipe(Effect.ignore);
  }

  yield* Effect.log(`[desktop-artifact] Downloading managed Node runtime ${archive.fileName}...`);
  const response = yield* Effect.tryPromise({
    try: () => fetch(archive.url),
    catch: (cause) =>
      new BuildScriptError({
        message: `Failed to download managed Node archive from ${archive.url}`,
        cause,
      }),
  });

  if (!response.ok) {
    return yield* new BuildScriptError({
      message: `Failed to download managed Node archive from ${archive.url}: HTTP ${response.status}`,
    });
  }

  const bytes = new Uint8Array(
    yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: (cause) =>
        new BuildScriptError({
          message: `Failed to read managed Node archive response from ${archive.url}`,
          cause,
        }),
    }),
  );
  const actualHash = sha256Hex(bytes);
  if (actualHash !== archive.sha256) {
    return yield* new BuildScriptError({
      message: `Downloaded managed Node archive hash mismatch for ${archive.fileName}: expected ${archive.sha256}, got ${actualHash}`,
    });
  }

  yield* fs.writeFile(archivePath, bytes);
  return archivePath;
});

const extractManagedWindowsNodeArchive = Effect.fn("extractManagedWindowsNodeArchive")(function* (
  archive: ManagedWindowsNodeArchive,
  archivePath: string,
  cacheDir: string,
  verbose: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const extractedRoot = path.join(cacheDir, archive.sourceDirectoryName);
  const nodeExecutablePath = path.join(extractedRoot, "node.exe");
  const npmCommandPath = path.join(extractedRoot, "npm.cmd");
  if ((yield* fs.exists(nodeExecutablePath)) && (yield* fs.exists(npmCommandPath))) {
    return extractedRoot;
  }

  yield* fs.remove(extractedRoot, { recursive: true, force: true }).pipe(Effect.ignore);
  yield* fs.makeDirectory(cacheDir, { recursive: true });

  yield* Effect.log(`[desktop-artifact] Extracting managed Node runtime ${archive.fileName}...`);
  if (process.platform === "win32") {
    const expandArchiveCommand = [
      "Expand-Archive",
      "-LiteralPath",
      quotePowerShellString(archivePath),
      "-DestinationPath",
      quotePowerShellString(cacheDir),
      "-Force",
    ].join(" ");
    yield* runCommand(
      ChildProcess.make(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", expandArchiveCommand],
        {
          ...commandOutputOptions(verbose),
        },
      ),
    );
  } else {
    yield* runCommand(
      ChildProcess.make("unzip", ["-q", archivePath, "-d", cacheDir], {
        ...commandOutputOptions(verbose),
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new BuildScriptError({
            message:
              "Failed to extract managed Node archive. Install `unzip` or build the Windows NSIS artifact on Windows.",
            cause,
          }),
      ),
    );
  }

  if (!(yield* fs.exists(nodeExecutablePath)) || !(yield* fs.exists(npmCommandPath))) {
    return yield* new BuildScriptError({
      message: `Managed Node archive did not extract node.exe/npm.cmd at ${extractedRoot}`,
    });
  }

  return extractedRoot;
});

const stageWindowsManagedRuntime = Effect.fn("stageWindowsManagedRuntime")(function* (
  options: ResolvedBuildOptions,
  repoRoot: string,
  stageResourcesDir: string,
) {
  if (!shouldStageWindowsManagedRuntime(options.platform, options.target)) {
    return;
  }

  const archive = resolveManagedWindowsNodeArchive(options.arch);
  if (!archive) {
    return yield* new BuildScriptError({
      message: `Windows managed provider runtime is only available for x64 and arm64 NSIS builds, not arch '${options.arch}'.`,
    });
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cacheDir = path.join(
    repoRoot,
    "node_modules",
    ".cache",
    "cafecode-managed-node",
    `v${MANAGED_WINDOWS_NODE_VERSION}`,
    `win-${archive.arch}`,
  );
  const archivePath = yield* ensureManagedWindowsNodeArchive(archive, cacheDir);
  const extractedRoot = yield* extractManagedWindowsNodeArchive(
    archive,
    archivePath,
    cacheDir,
    options.verbose,
  );

  const targetDir = path.join(stageResourcesDir, "managed-runtime", "node", `win-${archive.arch}`);
  yield* fs.remove(targetDir, { recursive: true, force: true }).pipe(Effect.ignore);
  yield* fs.makeDirectory(path.dirname(targetDir), { recursive: true });
  yield* fs.copy(extractedRoot, targetDir);

  yield* Effect.log("[desktop-artifact] Staged Windows managed provider runtime.").pipe(
    Effect.annotateLogs({ nodeRuntime: targetDir }),
  );
});

function validateBundledClientAssets(clientDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexPath = path.join(clientDir, "index.html");
    const indexHtml = yield* fs.readFileString(indexPath);
    const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const missing: string[] = [];

    for (const ref of refs) {
      const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
      if (!normalizedRef) continue;
      if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) continue;
      if (normalizedRef.startsWith("data:") || normalizedRef.startsWith("mailto:")) continue;

      const ext = path.extname(normalizedRef);
      if (!ext) continue;

      const relativePath = normalizedRef.replace(/^\/+/, "");
      const assetPath = path.join(clientDir, relativePath);
      if (!(yield* fs.exists(assetPath))) {
        missing.push(normalizedRef);
      }
    }

    if (missing.length > 0) {
      const preview = missing.slice(0, 6).join(", ");
      const suffix = missing.length > 6 ? ` (+${missing.length - 6} more)` : "";
      return yield* new BuildScriptError({
        message: `Bundled client references missing files in ${indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`,
      });
    }
  });
}

export function resolveDesktopRuntimeDependencies(
  dependencies: Record<string, string> | undefined,
  catalog: Record<string, string>,
): Record<string, string> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return {};
  }

  const runtimeDependencies = Object.fromEntries(
    Object.entries(dependencies).filter(
      ([dependencyName, dependencySpec]) =>
        dependencyName !== "electron" && !dependencySpec.startsWith("workspace:"),
    ),
  );

  return resolveCatalogDependencies(runtimeDependencies, catalog, "apps/desktop");
}

function resolveGitHubPublishConfig(updateChannel: "latest" | "nightly"):
  | {
      readonly provider: "github";
      readonly owner: string;
      readonly repo: string;
      readonly releaseType: "release" | "prerelease";
      readonly channel?: "nightly";
    }
  | undefined {
  const rawRepo =
    readCafeCodeEnv(process.env, "CAFE_CODE_DESKTOP_UPDATE_REPOSITORY")?.trim() ||
    process.env.GITHUB_REPOSITORY?.trim() ||
    "";
  if (!rawRepo) return undefined;

  const [owner, repo, ...rest] = rawRepo.split("/");
  if (!owner || !repo || rest.length > 0) return undefined;

  return {
    provider: "github",
    owner,
    repo,
    releaseType: updateChannel === "nightly" ? "prerelease" : "release",
    ...(updateChannel === "nightly" ? { channel: "nightly" as const } : {}),
  };
}

function omitElectronDependency(dependencies: Record<string, string>): Record<string, string> {
  const { electron: _electron, ...runtimeDependencies } = dependencies;
  return runtimeDependencies;
}

export function resolveDesktopUpdateChannel(version: string): "latest" | "nightly" {
  return /-nightly\.\d{8}\.\d+$/.test(version) ? "nightly" : "latest";
}

export function resolveDesktopBuildIconAssets(version: string): DesktopBuildIconAssets {
  if (resolveDesktopUpdateChannel(version) === "nightly") {
    return {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    };
  }

  return {
    macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
    linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
    windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
  };
}

export function resolveMockUpdateServerUrl(mockUpdateServerPort: number | undefined): string {
  return `http://localhost:${mockUpdateServerPort ?? 3000}`;
}

export function resolveDesktopProductName(version: string): string {
  return resolveDesktopUpdateChannel(version) === "nightly"
    ? "Cafe Code (Nightly)"
    : (desktopPackageJson.productName ?? "Cafe Code");
}

export function resolveLinuxDesktopBuildConfig(target: string): Record<string, unknown> {
  const linux = {
    target: [target],
    executableName: "cafe-code",
    icon: "icon.png",
    category: "Development",
    synopsis: "Desktop GUI for coding agents",
    description:
      "Cafe Code is a desktop GUI for coding agents such as Codex, Claude, and OpenCode.",
    maintainer: "CafeAI <116491182+cafeai@users.noreply.github.com>",
    vendor: "CafeAI",
    desktop: {
      entry: {
        StartupWMClass: "cafe-code",
      },
    },
  };

  if (target.toLowerCase() !== "deb") {
    return { linux };
  }

  return {
    linux,
    deb: {
      packageName: "cafe-code",
      packageCategory: "devel",
      priority: "optional",
      // electron-builder's Debian defaults omit libraries that Electron links
      // directly, and Cafe's local HTTPS bootstrap invokes the OpenSSL CLI.
      // Keep the defaults explicit so a clean install with
      // --no-install-recommends provides every runtime dependency.
      depends: [
        "libgtk-3-0",
        "libnotify4",
        "libnss3",
        "libxss1",
        "libxtst6",
        "xdg-utils",
        "libatspi2.0-0",
        "libuuid1",
        "libsecret-1-0",
        "libgbm1",
        "openssl",
        // Prefer the native time64 ALSA package on current distributions;
        // retain the legacy name for Debian/Ubuntu releases from before the
        // transition. A bare virtual libasound2 dependency can select an OSS
        // compatibility shim on Ubuntu 24.04 instead of native ALSA.
        "libasound2t64 | libasound2",
      ],
      // Cafe does not currently expose a Linux tray icon, so do not inherit
      // electron-builder's libappindicator recommendation for Debian packages.
      recommends: [],
    },
  };
}

const createBuildConfig = Effect.fn("createBuildConfig")(function* (
  platform: typeof BuildPlatform.Type,
  target: string,
  version: string,
  signed: boolean,
  mockUpdates: boolean,
  mockUpdateServerPort: number | undefined,
) {
  const buildConfig: Record<string, unknown> = {
    appId: "com.cafeai.cafecode",
    productName: resolveDesktopProductName(version),
    artifactName: "Cafe-Code-${version}-${arch}.${ext}",
    directories: {
      buildResources: "apps/desktop/resources",
    },
  };
  const updateChannel = resolveDesktopUpdateChannel(version);
  const publishConfig = resolveGitHubPublishConfig(updateChannel);
  if (publishConfig) {
    buildConfig.publish = [publishConfig];
  } else if (mockUpdates) {
    buildConfig.publish = [
      {
        provider: "generic",
        url: resolveMockUpdateServerUrl(mockUpdateServerPort),
      },
    ];
  }

  if (platform === "mac") {
    buildConfig.mac = {
      target: target === "dmg" ? [target, "zip"] : [target],
      icon: "icon.icns",
      category: "public.app-category.developer-tools",
    };
  }

  if (platform === "linux") {
    Object.assign(buildConfig, resolveLinuxDesktopBuildConfig(target));
  }

  if (platform === "win") {
    buildConfig.npmRebuild = false;
    const winConfig: Record<string, unknown> = {
      target: [target],
      icon: "icon.ico",
    };
    if (signed) {
      winConfig.azureSignOptions = yield* AzureTrustedSigningOptionsConfig;
    } else {
      winConfig.signExecutable = false;
    }
    buildConfig.win = winConfig;

    if (isWindowsNsisInstallerTarget(target)) {
      buildConfig.extraResources = [
        {
          from: "apps/desktop/resources/managed-runtime",
          to: "managed-runtime",
        },
      ];
      buildConfig.nsis = {
        oneClick: false,
        perMachine: false,
        allowToChangeInstallationDirectory: true,
        runAfterFinish: true,
        include: "apps/desktop/resources/installer.nsh",
      };
    }
  }

  return buildConfig;
});

const assertPlatformBuildResources = Effect.fn("assertPlatformBuildResources")(function* (
  platform: typeof BuildPlatform.Type,
  stageResourcesDir: string,
  iconAssets: DesktopBuildIconAssets,
  verbose: boolean,
) {
  if (platform === "mac") {
    yield* stageMacIcons(stageResourcesDir, iconAssets.macIconPng, verbose);
    return;
  }

  if (platform === "linux") {
    yield* stageLinuxIcons(stageResourcesDir, iconAssets.linuxIconPng);
    return;
  }

  if (platform === "win") {
    yield* stageWindowsIcons(stageResourcesDir, iconAssets.windowsIconIco);
  }
});

const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const platformConfig = PLATFORM_CONFIG[options.platform];
  if (!platformConfig) {
    return yield* new BuildScriptError({
      message: `Unsupported platform '${options.platform}'.`,
    });
  }

  const electronVersion = desktopPackageJson.dependencies.electron;

  const serverDependencies = serverPackageJson.dependencies;
  if (!serverDependencies || Object.keys(serverDependencies).length === 0) {
    return yield* new BuildScriptError({
      message: "Could not resolve production dependencies from apps/server/package.json.",
    });
  }

  const resolvedOverrides = yield* Effect.try({
    try: () =>
      resolveCatalogDependencies(
        rootPackageJson.overrides,
        rootPackageJson.workspaces.catalog,
        "apps/desktop",
      ),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve overrides from package.json.",
        cause,
      }),
  });

  const resolvedServerDependencies = yield* Effect.try({
    try: () =>
      resolveCatalogDependencies(
        serverDependencies,
        rootPackageJson.workspaces.catalog,
        "apps/server",
      ),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve production dependencies from apps/server/package.json.",
        cause,
      }),
  });
  const resolvedDesktopRuntimeDependencies = yield* Effect.try({
    try: () =>
      resolveDesktopRuntimeDependencies(
        desktopPackageJson.dependencies,
        rootPackageJson.workspaces.catalog,
      ),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve desktop runtime dependencies from apps/desktop/package.json.",
        cause,
      }),
  });

  const appVersion = options.version ?? serverPackageJson.version;
  const iconAssets = resolveDesktopBuildIconAssets(appVersion);
  const commitHash = yield* resolveGitCommitHash(repoRoot);
  const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
  const stageRoot = yield* mkdir({
    prefix: `cafecode-desktop-${options.platform}-stage-`,
  });

  const stageAppDir = path.join(stageRoot, "app");
  const stageResourcesDir = path.join(stageAppDir, "apps/desktop/resources");
  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/desktop/dist-electron"),
    desktopResources: path.join(repoRoot, "apps/desktop/resources"),
    serverDist: path.join(repoRoot, "apps/server/dist"),
  };
  const bundledClientEntry = path.join(distDirs.serverDist, "client/index.html");

  if (!options.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building desktop/server/web artifacts...");
    yield* runCommand(
      ChildProcess.make({
        cwd: repoRoot,
        ...commandOutputOptions(options.verbose),
        // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
        shell: process.platform === "win32",
      })`bun run build:desktop`,
    );
  }

  for (const [label, dir] of Object.entries(distDirs)) {
    if (!(yield* fs.exists(dir))) {
      return yield* new BuildScriptError({
        message: `Missing ${label} at ${dir}. Run 'bun run build:desktop' first.`,
      });
    }
  }

  if (!(yield* fs.exists(bundledClientEntry))) {
    return yield* new BuildScriptError({
      message: `Missing bundled server client at ${bundledClientEntry}. Run 'bun run build:desktop' first.`,
    });
  }

  yield* validateBundledClientAssets(path.dirname(bundledClientEntry));

  yield* fs.makeDirectory(path.join(stageAppDir, "apps/desktop"), { recursive: true });
  yield* fs.makeDirectory(path.join(stageAppDir, "apps/server"), { recursive: true });

  yield* Effect.log("[desktop-artifact] Staging release app...");
  yield* fs.copy(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"));
  yield* fs.copy(distDirs.desktopResources, stageResourcesDir);
  yield* fs.copy(distDirs.serverDist, path.join(stageAppDir, "apps/server/dist"));

  yield* assertPlatformBuildResources(
    options.platform,
    stageResourcesDir,
    {
      macIconPng: path.join(repoRoot, iconAssets.macIconPng),
      linuxIconPng: path.join(repoRoot, iconAssets.linuxIconPng),
      windowsIconIco: path.join(repoRoot, iconAssets.windowsIconIco),
    },
    options.verbose,
  );

  // electron-builder is filtering out stageResourcesDir directory in the AppImage for production
  yield* fs.copy(stageResourcesDir, path.join(stageAppDir, "apps/desktop/prod-resources"));
  yield* stageWindowsManagedRuntime(options, repoRoot, stageResourcesDir);

  const stagePackageJson: StagePackageJson = {
    name: "cafe-code",
    version: appVersion,
    buildVersion: appVersion,
    cafeCodeCommitHash: commitHash,
    private: true,
    description:
      "Cafe Code is a desktop GUI for coding agents such as Codex, Claude, and OpenCode.",
    author: "CafeAI",
    homepage: "https://github.com/cafeai/cafe-code",
    license: "AGPL-3.0-or-later",
    main: "apps/desktop/dist-electron/main.cjs",
    build: yield* createBuildConfig(
      options.platform,
      options.target,
      appVersion,
      options.signed,
      options.mockUpdates,
      options.mockUpdateServerPort,
    ),
    dependencies: {
      ...omitElectronDependency(resolvedServerDependencies),
      ...resolvedDesktopRuntimeDependencies,
    },
    devDependencies: {
      electron: electronVersion,
    },
    overrides: resolvedOverrides,
  };

  const stagePackageJsonString = yield* encodeJsonString(stagePackageJson);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), `${stagePackageJsonString}\n`);

  yield* Effect.log("[desktop-artifact] Installing staged production dependencies...");
  yield* runCommand(
    ChildProcess.make({
      cwd: stageAppDir,
      ...commandOutputOptions(options.verbose),
      // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
      shell: process.platform === "win32",
    })`bun install --production --omit optional`,
  );

  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
  };
  for (const [key, value] of Object.entries(buildEnv)) {
    if (value === "") {
      delete buildEnv[key];
    }
  }
  if (!options.signed) {
    buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    delete buildEnv.CSC_LINK;
    delete buildEnv.CSC_KEY_PASSWORD;
    delete buildEnv.APPLE_API_KEY;
    delete buildEnv.APPLE_API_KEY_ID;
    delete buildEnv.APPLE_API_ISSUER;
  }

  if (process.platform === "win32") {
    const python = yield* resolvePythonForNodeGyp();
    if (python) {
      buildEnv.PYTHON = python;
      buildEnv.npm_config_python = python;
    }
    buildEnv.npm_config_msvs_version = buildEnv.npm_config_msvs_version ?? "2022";
    buildEnv.GYP_MSVS_VERSION = buildEnv.GYP_MSVS_VERSION ?? "2022";
  }

  yield* Effect.log(
    `[desktop-artifact] Building ${options.platform}/${options.target} (arch=${options.arch}, version=${appVersion})...`,
  );
  yield* runCommand(
    ChildProcess.make({
      cwd: stageAppDir,
      env: buildEnv,
      ...commandOutputOptions(options.verbose),
      // Windows needs shell mode to resolve .cmd shims.
      shell: process.platform === "win32",
    })`bun x --install=fallback electron-builder ${platformConfig.cliFlag} --${options.arch} --publish never`,
  );

  const stageDistDir = path.join(stageAppDir, "dist");
  if (!(yield* fs.exists(stageDistDir))) {
    return yield* new BuildScriptError({
      message: `Build completed but dist directory was not found at ${stageDistDir}`,
    });
  }

  const stageEntries = yield* fs.readDirectory(stageDistDir);
  yield* fs.makeDirectory(options.outputDir, { recursive: true });

  const copiedArtifacts: string[] = [];
  for (const entry of stageEntries) {
    const from = path.join(stageDistDir, entry);
    const stat = yield* fs.stat(from).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!stat || stat.type !== "File") continue;

    const to = path.join(options.outputDir, entry);
    yield* fs.copyFile(from, to);
    copiedArtifacts.push(to);
  }

  if (copiedArtifacts.length === 0) {
    return yield* new BuildScriptError({
      message: `Build completed but no files were produced in ${stageDistDir}`,
    });
  }

  if (!desktopArtifactListSatisfiesTarget(options.platform, options.target, copiedArtifacts)) {
    return yield* new BuildScriptError({
      message: `Build completed but did not produce the expected ${options.platform}/${options.target} artifact in ${stageDistDir}`,
    });
  }

  yield* Effect.log("[desktop-artifact] Done. Artifacts:").pipe(
    Effect.annotateLogs({ artifacts: copiedArtifacts }),
  );
});

const buildDesktopArtifactCli = Command.make("build-desktop-artifact", {
  platform: Flag.choice("platform", BuildPlatform.literals).pipe(
    Flag.withDescription("Build platform (env: CAFE_CODE_DESKTOP_PLATFORM)."),
    Flag.optional,
  ),
  target: Flag.string("target").pipe(
    Flag.withDescription(
      "Artifact target, for example dmg/AppImage/deb/nsis (env: CAFE_CODE_DESKTOP_TARGET).",
    ),
    Flag.optional,
  ),
  arch: Flag.choice("arch", BuildArch.literals).pipe(
    Flag.withDescription(
      "Build arch, for example arm64/x64/universal (env: CAFE_CODE_DESKTOP_ARCH).",
    ),
    Flag.optional,
  ),
  buildVersion: Flag.string("build-version").pipe(
    Flag.withDescription("Artifact version metadata (env: CAFE_CODE_DESKTOP_VERSION)."),
    Flag.optional,
  ),
  outputDir: Flag.string("output-dir").pipe(
    Flag.withDescription("Output directory for artifacts (env: CAFE_CODE_DESKTOP_OUTPUT_DIR)."),
    Flag.optional,
  ),
  skipBuild: Flag.boolean("skip-build").pipe(
    Flag.withDescription(
      "Skip `bun run build:desktop` and use existing dist artifacts (env: CAFE_CODE_DESKTOP_SKIP_BUILD).",
    ),
    Flag.optional,
  ),
  keepStage: Flag.boolean("keep-stage").pipe(
    Flag.withDescription("Keep temporary staging files (env: CAFE_CODE_DESKTOP_KEEP_STAGE)."),
    Flag.optional,
  ),
  signed: Flag.boolean("signed").pipe(
    Flag.withDescription(
      "Enable signing/notarization discovery; Windows uses Azure Trusted Signing (env: CAFE_CODE_DESKTOP_SIGNED).",
    ),
    Flag.optional,
  ),
  verbose: Flag.boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout (env: CAFE_CODE_DESKTOP_VERBOSE)."),
    Flag.optional,
  ),
  mockUpdates: Flag.boolean("mock-updates").pipe(
    Flag.withDescription("Enable mock updates (env: CAFE_CODE_DESKTOP_MOCK_UPDATES)."),
    Flag.optional,
  ),
  mockUpdateServerPort: Flag.integer("mock-update-server-port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription(
      "Mock update server port (env: CAFE_CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT).",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build a desktop artifact for Cafe Code."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildDesktopArtifact)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

if (import.meta.main) {
  Command.run(buildDesktopArtifactCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
