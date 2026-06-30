#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  DEVELOPMENT_ICON_OVERRIDES,
  PUBLISH_ICON_OVERRIDES,
} from "../../../scripts/lib/brand-assets.ts";
import { resolveCatalogDependencies } from "../../../scripts/lib/resolve-catalog.ts";
import { fromJsonStringPretty } from "@cafecode/shared/schemaJson";
import rootPackageJson from "../../../package.json" with { type: "json" };
import desktopPackageJson from "../../desktop/package.json" with { type: "json" };
import serverPackageJson from "../package.json" with { type: "json" };

interface PackageJson {
  name: string;
  description?: string;
  license: string;
  homepage?: string;
  bugs?: {
    url: string;
  };
  repository: {
    type: string;
    url: string;
    directory: string;
  };
  keywords?: string[];
  bin: Record<string, string>;
  type: string;
  version: string;
  engines: Record<string, string>;
  files: string[];
  publishConfig?: {
    access: string;
  };
  dependencies: Record<string, string>;
  overrides: Record<string, string>;
}

const PackageJsonPrettyJson = fromJsonStringPretty(Schema.Unknown);
const encodePackageJson = Schema.encodeEffect(PackageJsonPrettyJson);

class CliError extends Data.TaggedError("CliError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new CliError({
      message: `Command exited with non-zero exit code (${exitCode})`,
    });
  }
});

interface PublishIconBackup {
  readonly targetPath: string;
  readonly backupPath: string;
}

interface PreparedPublishPackage {
  readonly iconBackups: ReadonlyArray<PublishIconBackup>;
  readonly stagedDesktopRuntimePath: string;
  readonly packageJsonPath: string;
  readonly backupPath: string;
}

const disallowedPublishProtocols = ["catalog:", "workspace:"] as const;

function collectDisallowedPublishDependencySpecs(
  packageJson: unknown,
): ReadonlyArray<{ readonly section: string; readonly name: string; readonly spec: string }> {
  if (!packageJson || typeof packageJson !== "object") {
    return [];
  }

  const manifest = packageJson as Record<string, unknown>;
  const sections = [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
    "overrides",
  ];
  const disallowed: Array<{
    readonly section: string;
    readonly name: string;
    readonly spec: string;
  }> = [];

  for (const section of sections) {
    const dependencies = manifest[section];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      continue;
    }

    for (const [name, spec] of Object.entries(dependencies)) {
      if (
        typeof spec === "string" &&
        disallowedPublishProtocols.some((protocol) => spec.startsWith(protocol))
      ) {
        disallowed.push({ section, name, spec });
      }
    }
  }

  return disallowed;
}

const applyPublishIconOverrides = Effect.fn("applyPublishIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const backups: PublishIconBackup[] = [];
  const backupDir = yield* fs.makeTempDirectoryScoped({
    prefix: "cafecode-publish-icons-",
  });

  for (const [index, override] of PUBLISH_ICON_OVERRIDES.entries()) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);
    const backupPath = path.join(backupDir, `${index}-${path.basename(targetPath)}`);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new CliError({
        message: `Missing publish icon source: ${sourcePath}`,
      });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new CliError({
        message: `Missing publish icon target: ${targetPath}. Run the build subcommand first.`,
      });
    }

    yield* fs.copyFile(targetPath, backupPath);
    yield* fs.copyFile(sourcePath, targetPath);
    backups.push({ targetPath, backupPath });
  }

  yield* Effect.log("[cli] Applied publish icon overrides to dist/client");
  return backups as ReadonlyArray<PublishIconBackup>;
});

const restorePublishIconOverrides = Effect.fn("restorePublishIconOverrides")(function* (
  backups: ReadonlyArray<PublishIconBackup>,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const backup of backups) {
    if (!(yield* fs.exists(backup.backupPath))) {
      continue;
    }
    yield* fs.rename(backup.backupPath, backup.targetPath);
  }
});

const copyServerDistRuntimeFiles = Effect.fn("copyServerDistRuntimeFiles")(function* (
  serverDist: string,
  targetDist: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs.readDirectory(serverDist, { recursive: false });

  for (const entry of entries) {
    if (entry === "apps" || entry === "client") {
      continue;
    }

    const sourcePath = path.join(serverDist, entry);
    const sourceInfo = yield* fs.stat(sourcePath).pipe(Effect.catch(() => Effect.succeed(null)));
    if (sourceInfo?.type !== "File") {
      continue;
    }

    yield* fs.copyFile(sourcePath, path.join(targetDist, entry));
  }
});

const stagePublishedDesktopRuntime = Effect.fn("stagePublishedDesktopRuntime")(function* (
  repoRoot: string,
  serverDir: string,
  version: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const stageRoot = path.join(serverDir, "dist/apps");
  const stagedServerRoot = path.join(stageRoot, "server");
  const stagedDesktopRoot = path.join(stageRoot, "desktop");
  const serverDist = path.join(serverDir, "dist");
  const desktopDir = path.join(repoRoot, "apps/desktop");
  const requiredPaths = [
    path.join(serverDist, "bin.mjs"),
    path.join(serverDist, "client/index.html"),
    path.join(desktopDir, "dist-electron/main.cjs"),
    path.join(desktopDir, "dist-electron/preload.cjs"),
    path.join(desktopDir, "scripts/start-electron.mjs"),
    path.join(desktopDir, "scripts/electron-launcher.mjs"),
    path.join(desktopDir, "resources/icon.icns"),
  ];

  for (const requiredPath of requiredPaths) {
    if (!(yield* fs.exists(requiredPath))) {
      return yield* new CliError({
        message: `Missing desktop npm runtime asset: ${requiredPath}. Run bun run build:desktop first.`,
      });
    }
  }

  yield* fs.remove(stageRoot, { recursive: true, force: true }).pipe(Effect.ignore);
  yield* fs.makeDirectory(path.join(stagedServerRoot, "dist"), { recursive: true });
  yield* fs.makeDirectory(stagedDesktopRoot, { recursive: true });

  yield* copyServerDistRuntimeFiles(serverDist, path.join(stagedServerRoot, "dist"));
  yield* fs.copy(path.join(serverDist, "client"), path.join(stagedServerRoot, "dist/client"), {
    overwrite: true,
    preserveTimestamps: true,
  });
  yield* fs.copyFile(
    path.join(serverDir, "package.json"),
    path.join(stagedServerRoot, "package.json"),
  );

  yield* fs.copy(
    path.join(desktopDir, "dist-electron"),
    path.join(stagedDesktopRoot, "dist-electron"),
    {
      overwrite: true,
      preserveTimestamps: true,
    },
  );
  yield* fs.makeDirectory(path.join(stagedDesktopRoot, "scripts"), { recursive: true });
  for (const scriptName of ["start-electron.mjs", "electron-launcher.mjs"]) {
    yield* fs.copyFile(
      path.join(desktopDir, "scripts", scriptName),
      path.join(stagedDesktopRoot, "scripts", scriptName),
    );
  }
  yield* fs.copy(path.join(desktopDir, "resources"), path.join(stagedDesktopRoot, "resources"), {
    overwrite: true,
    preserveTimestamps: true,
  });
  yield* fs.writeFileString(
    path.join(stagedDesktopRoot, "package.json"),
    // @effect-diagnostics-next-line preferSchemaOverJson:off - Package staging writes deterministic package metadata, not untrusted input.
    `${JSON.stringify({ ...desktopPackageJson, version }, null, 2)}\n`,
  );

  yield* Effect.log("[cli] Staged Electron desktop runtime for npm");
  return stageRoot;
});

const cleanupPublishedDesktopRuntime = Effect.fn("cleanupPublishedDesktopRuntime")(function* (
  stageRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(stageRoot, { recursive: true, force: true }).pipe(Effect.ignore);
});

const assertPublishBuildAssets = Effect.fn("assertPublishBuildAssets")(function* (
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const relPath of ["dist/bin.mjs", "dist/launcher.mjs", "dist/client/index.html"]) {
    const abs = path.join(serverDir, relPath);
    if (!(yield* fs.exists(abs))) {
      return yield* new CliError({
        message: `Missing build asset: ${abs}. Run the build subcommand first.`,
      });
    }
  }
});

const assertServerRuntimeBuildAssets = Effect.fn("assertServerRuntimeBuildAssets")(function* (
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const relPath of ["dist/bin.mjs", "dist/launcher.mjs"]) {
    const abs = path.join(serverDir, relPath);
    if (!(yield* fs.exists(abs))) {
      return yield* new CliError({
        message: `Missing server runtime build asset: ${abs}. The server bundle did not finish correctly.`,
      });
    }
  }
});

const assertLocalServerBundleImportsPresent = Effect.fn("assertLocalServerBundleImportsPresent")(
  function* (serverBundlePath: string) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const bundleSource = yield* fs.readFileString(serverBundlePath);
    const importPattern = /(?:from\s*["']|import\(\s*["'])\.\/([^"']+\.mjs)["']/g;
    const importSpecs = new Set<string>();

    for (const match of bundleSource.matchAll(importPattern)) {
      const spec = match[1];
      if (spec !== undefined) {
        importSpecs.add(spec);
      }
    }

    for (const spec of importSpecs) {
      const importedPath = path.join(path.dirname(serverBundlePath), spec);
      if (!(yield* fs.exists(importedPath))) {
        return yield* new CliError({
          message: `Package is missing server bundle dependency '${path.basename(serverBundlePath)} -> ${spec}'. Run 'node scripts/cli.ts publish' or 'node scripts/cli.ts pack' instead of npm directly.`,
        });
      }
    }
  },
);

const assertPublishPrepared = Effect.fn("assertPublishPrepared")(function* (serverDir: string) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const packageJsonPath = path.join(serverDir, "package.json");
  const packageJson = yield* fs
    .readFileString(packageJsonPath)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PackageJsonPrettyJson)));
  const disallowed = collectDisallowedPublishDependencySpecs(packageJson);

  if (disallowed.length > 0) {
    const preview = disallowed
      .slice(0, 5)
      .map((entry) => `${entry.section}.${entry.name}=${entry.spec}`)
      .join(", ");
    const suffix = disallowed.length > 5 ? ` (+${disallowed.length - 5} more)` : "";
    return yield* new CliError({
      message: `Package manifest is not prepared for npm publish: ${preview}${suffix}. Run 'node scripts/cli.ts publish' or 'node scripts/cli.ts pack' instead of npm directly.`,
    });
  }

  for (const relPath of [
    "dist/bin.mjs",
    "dist/launcher.mjs",
    "dist/client/index.html",
    "dist/apps/server/dist/bin.mjs",
    "dist/apps/server/dist/client/index.html",
    "dist/apps/desktop/dist-electron/main.cjs",
    "dist/apps/desktop/scripts/start-electron.mjs",
    "dist/apps/desktop/resources/icon.icns",
  ]) {
    const abs = path.join(serverDir, relPath);
    if (!(yield* fs.exists(abs))) {
      return yield* new CliError({
        message: `Package is missing staged npm runtime asset '${relPath}'. Run 'node scripts/cli.ts publish' or 'node scripts/cli.ts pack' instead of npm directly.`,
      });
    }
  }

  yield* assertLocalServerBundleImportsPresent(
    path.join(serverDir, "dist/apps/server/dist/bin.mjs"),
  );
});

const preparePublishPackage = Effect.fn("preparePublishPackage")(function* (
  repoRoot: string,
  serverDir: string,
  version: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const packageJsonPath = path.join(serverDir, "package.json");
  const backupDir = yield* fs.makeTempDirectoryScoped({
    prefix: "cafecode-publish-package-",
  });
  const backupPath = path.join(backupDir, "package.json.original");
  const pkg: PackageJson = {
    name: serverPackageJson.name,
    description: serverPackageJson.description,
    license: serverPackageJson.license,
    homepage: serverPackageJson.homepage,
    bugs: serverPackageJson.bugs,
    repository: serverPackageJson.repository,
    keywords: serverPackageJson.keywords,
    bin: serverPackageJson.bin,
    type: serverPackageJson.type,
    version,
    engines: serverPackageJson.engines,
    files: serverPackageJson.files,
    publishConfig: serverPackageJson.publishConfig,
    dependencies: resolveCatalogDependencies(
      serverPackageJson.dependencies,
      rootPackageJson.workspaces.catalog,
      "apps/server",
    ),
    overrides: resolveCatalogDependencies(
      rootPackageJson.overrides,
      rootPackageJson.workspaces.catalog,
      "apps/server",
    ),
  };

  const original = yield* fs.readFileString(packageJsonPath);
  const packageJsonString = yield* encodePackageJson(pkg);
  yield* fs.writeFileString(backupPath, original);
  yield* fs.writeFileString(packageJsonPath, `${packageJsonString}\n`);
  yield* Effect.log("[cli] Prepared package.json for publish");

  const iconBackups = yield* applyPublishIconOverrides(repoRoot, serverDir);
  const stagedDesktopRuntimePath = yield* stagePublishedDesktopRuntime(
    repoRoot,
    serverDir,
    version,
  );
  yield* assertPublishPrepared(serverDir);

  return {
    iconBackups,
    stagedDesktopRuntimePath,
    packageJsonPath,
    backupPath,
  } satisfies PreparedPublishPackage;
});

const restorePublishPackage = Effect.fn("restorePublishPackage")(function* (
  resource: PreparedPublishPackage,
  verbose: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* cleanupPublishedDesktopRuntime(resource.stagedDesktopRuntimePath);
  yield* restorePublishIconOverrides(resource.iconBackups).pipe(
    Effect.catch((error) =>
      Effect.logError(`[cli] Failed to restore publish icon overrides: ${String(error)}`),
    ),
  );
  yield* fs.copyFile(resource.backupPath, resource.packageJsonPath);
  if (verbose) yield* Effect.log("[cli] Restored original package.json");
});

const applyDevelopmentIconOverrides = Effect.fn("applyDevelopmentIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of DEVELOPMENT_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new CliError({
        message: `Missing development icon source: ${sourcePath}`,
      });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new CliError({
        message: `Missing development icon target: ${targetPath}. Build web first.`,
      });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied development icon overrides to dist/client");
});

// ---------------------------------------------------------------------------
// build subcommand
// ---------------------------------------------------------------------------

const buildCmd = Command.make(
  "build",
  {
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Running tsdown...");
      const bundleCommand =
        process.platform === "win32"
          ? ChildProcess.make("bun", ["run", "build:bundle"], {
              cwd: serverDir,
              stdout: config.verbose ? "inherit" : "ignore",
              stderr: "inherit",
              // Windows needs shell mode to resolve .cmd shims.
              shell: true,
            })
          : ChildProcess.make(process.execPath, ["--run", "build:bundle"], {
              cwd: serverDir,
              stdout: config.verbose ? "inherit" : "ignore",
              stderr: "inherit",
            });
      yield* runCommand(bundleCommand);
      yield* assertServerRuntimeBuildAssets(serverDir);

      const webDist = path.join(repoRoot, "apps/web/dist");
      const clientTarget = path.join(serverDir, "dist/client");

      if (yield* fs.exists(webDist)) {
        yield* fs.copy(webDist, clientTarget);
        yield* applyDevelopmentIconOverrides(repoRoot, serverDir);
        yield* Effect.log("[cli] Bundled renderer assets into dist/client");
      } else {
        yield* Effect.logWarning("[cli] Renderer dist not found — skipping client bundle.");
      }

      yield* assertPublishBuildAssets(serverDir);
    }),
).pipe(Command.withDescription("Build the server package (tsdown + bundle renderer client)."));

// ---------------------------------------------------------------------------
// publish subcommand
// ---------------------------------------------------------------------------

const publishCmd = Command.make(
  "publish",
  {
    tag: Flag.string("tag").pipe(Flag.withDefault("latest")),
    access: Flag.string("access").pipe(Flag.withDefault("public")),
    appVersion: Flag.string("app-version").pipe(Flag.optional),
    provenance: Flag.boolean("provenance").pipe(Flag.withDefault(false)),
    dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* assertPublishBuildAssets(serverDir);

      yield* Effect.acquireUseRelease(
        // Acquire: backup package.json, resolve catalog dependencies, and strip devDependencies/scripts
        Effect.gen(function* () {
          const version = Option.getOrElse(config.appVersion, () => serverPackageJson.version);
          return yield* preparePublishPackage(repoRoot, serverDir, version);
        }),
        // Use: npm publish
        () =>
          Effect.gen(function* () {
            const args = ["publish", "--access", config.access, "--tag", config.tag];
            if (config.provenance) args.push("--provenance");
            if (config.dryRun) args.push("--dry-run");

            yield* Effect.log(`[cli] Running: npm ${args.join(" ")}`);
            yield* runCommand(
              ChildProcess.make("npm", [...args], {
                cwd: serverDir,
                stdout: config.verbose ? "inherit" : "ignore",
                stderr: "inherit",
                // Windows needs shell mode to resolve .cmd shims.
                shell: process.platform === "win32",
              }),
            );
          }),
        // Release: restore
        (resource) => restorePublishPackage(resource, config.verbose),
      );
    }),
).pipe(Command.withDescription("Publish the server package to npm."));

const packCmd = Command.make(
  "pack",
  {
    appVersion: Flag.string("app-version").pipe(Flag.optional),
    packDestination: Flag.string("pack-destination").pipe(Flag.optional),
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");
      const packDestination = Option.getOrElse(config.packDestination, () => serverDir);

      yield* assertPublishBuildAssets(serverDir);
      yield* fs.makeDirectory(packDestination, { recursive: true });

      yield* Effect.acquireUseRelease(
        Effect.gen(function* () {
          const version = Option.getOrElse(config.appVersion, () => serverPackageJson.version);
          return yield* preparePublishPackage(repoRoot, serverDir, version);
        }),
        () =>
          Effect.gen(function* () {
            const args = ["pack", "--pack-destination", packDestination];
            yield* Effect.log(`[cli] Running: npm ${args.join(" ")}`);
            yield* runCommand(
              ChildProcess.make("npm", args, {
                cwd: serverDir,
                stdout: "inherit",
                stderr: "inherit",
                shell: process.platform === "win32",
              }),
            );
          }),
        (resource) => restorePublishPackage(resource, config.verbose),
      );
    }),
).pipe(Command.withDescription("Prepare and pack the npm package into a local tarball."));

const assertPublishPreparedCmd = Command.make("assert-publish-prepared").pipe(
  Command.withDescription("Fail unless the server package is staged for npm packing."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");
      yield* assertPublishPrepared(serverDir);
    }),
  ),
);

// ---------------------------------------------------------------------------
// root command
// ---------------------------------------------------------------------------

const cli = Command.make("cli").pipe(
  Command.withDescription("Cafe Code server build & publish CLI."),
  Command.withSubcommands([buildCmd, publishCmd, packCmd, assertPublishPreparedCmd]),
);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
);
