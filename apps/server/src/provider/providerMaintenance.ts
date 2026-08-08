import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from "@cafecode/contracts";
import { compareSemverVersions } from "@cafecode/shared/semver";
import { resolveCommandPath } from "@cafecode/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000;
const LATEST_VERSION_TIMEOUT_MS = 4_000;
const PROVIDER_UPDATE_ACTION_TOAST_MESSAGE = "Install the update now or review provider settings.";

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
  readonly approvedVersion?: string;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
}

export interface ProviderMaintenanceCapabilityResolutionOptions {
  readonly binaryPath?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly realCommandPath?: string | null;
}

export interface ProviderMaintenanceCapabilitiesResolver {
  readonly resolve: (
    options?: ProviderMaintenanceCapabilityResolutionOptions,
  ) => ProviderMaintenanceCapabilities;
}

export interface PackageManagedProviderMaintenanceDefinition {
  readonly provider: ProviderDriverKind;
  readonly npmPackageName: string;
  readonly approvedVersion?: string;
  readonly homebrewFormula: string | null;
  readonly nativeUpdate: {
    readonly executable: string;
    readonly args: ReadonlyArray<string>;
    readonly lockKey: string;
    readonly isCommandPath: (commandPath: string) => boolean;
  } | null;
}

interface LatestVersionCacheEntry {
  readonly expiresAt: number;
  readonly version: string | null;
}

const latestVersionCache = new Map<string, LatestVersionCacheEntry>();
const NpmLatestVersionResponse = Schema.Struct({
  version: Schema.optional(Schema.String),
});

export function clearLatestProviderVersionCacheForTests(): void {
  latestVersionCache.clear();
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function makeProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly updateExecutable: string | null;
  readonly updateArgs: ReadonlyArray<string>;
  readonly updateLockKey: string | null;
  readonly approvedVersion?: string;
}): ProviderMaintenanceCapabilities {
  const update =
    input.updateExecutable === null || input.updateLockKey === null
      ? null
      : {
          command: [input.updateExecutable, ...input.updateArgs].join(" "),
          executable: input.updateExecutable,
          args: input.updateArgs,
          lockKey: input.updateLockKey,
        };
  return {
    provider: input.provider,
    packageName: input.packageName,
    update,
    ...(input.approvedVersion ? { approvedVersion: input.approvedVersion } : {}),
  };
}

export function makeManualOnlyProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly approvedVersion?: string;
}): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: input.provider,
    packageName: input.packageName,
    updateExecutable: null,
    updateArgs: [],
    updateLockKey: null,
    ...(input.approvedVersion ? { approvedVersion: input.approvedVersion } : {}),
  });
}

function resolveNpmGlobalUpdateExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function makeNpmGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  options?: ProviderMaintenanceCapabilityResolutionOptions,
): ProviderMaintenanceCapabilities {
  if (definition.approvedVersion) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
      approvedVersion: definition.approvedVersion,
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: resolveNpmGlobalUpdateExecutable(options?.platform),
    updateArgs: [
      "install",
      "-g",
      `${definition.npmPackageName}@${definition.approvedVersion ?? "latest"}`,
    ],
    updateLockKey: "npm-global",
    ...(definition.approvedVersion ? { approvedVersion: definition.approvedVersion } : {}),
  });
}

function makePnpmGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  if (definition.approvedVersion) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
      approvedVersion: definition.approvedVersion,
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "pnpm",
    updateArgs: [
      "add",
      "-g",
      `${definition.npmPackageName}@${definition.approvedVersion ?? "latest"}`,
    ],
    updateLockKey: "pnpm-global",
    ...(definition.approvedVersion ? { approvedVersion: definition.approvedVersion } : {}),
  });
}

function makeVitePlusGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  if (definition.approvedVersion) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
      approvedVersion: definition.approvedVersion,
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "vp",
    updateArgs: [
      "i",
      "-g",
      definition.approvedVersion
        ? `${definition.npmPackageName}@${definition.approvedVersion}`
        : definition.npmPackageName,
    ],
    updateLockKey: "vite-plus-global",
    ...(definition.approvedVersion ? { approvedVersion: definition.approvedVersion } : {}),
  });
}

function makeHomebrewProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities {
  if (!definition.homebrewFormula) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
      ...(definition.approvedVersion ? { approvedVersion: definition.approvedVersion } : {}),
    });
  }

  // Homebrew cannot install the repository's exact npm compatibility pin.
  // Leave the action manual for compatibility-managed providers; the
  // detached conformity helper enables it only when the formula's upstream
  // release is the same version the repository has tested.
  if (definition.approvedVersion) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
      approvedVersion: definition.approvedVersion,
    });
  }

  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "brew",
    updateArgs: ["upgrade", definition.homebrewFormula],
    updateLockKey: "homebrew",
    ...(definition.approvedVersion ? { approvedVersion: definition.approvedVersion } : {}),
  });
}

function makeNativeProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilities | null {
  if (!definition.nativeUpdate) {
    return null;
  }

  // Compatibility-pinned providers must use the detached conformity workflow.
  // Replacing a live global/native CLI from the in-app maintenance runner can
  // corrupt a Windows install and lets a provider's floating updater bypass
  // the repository's tested pin.
  if (definition.approvedVersion) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
      approvedVersion: definition.approvedVersion,
    });
  }

  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: definition.nativeUpdate.executable,
    updateArgs: definition.nativeUpdate.args,
    updateLockKey: definition.nativeUpdate.lockKey,
    ...(definition.approvedVersion ? { approvedVersion: definition.approvedVersion } : {}),
  });
}

export function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

export function normalizeCommandPath(commandPath: string): string {
  return commandPath.replaceAll("\\", "/").toLowerCase();
}

function isVitePlusGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.vite-plus/bin/");
}

function isPnpmGlobalCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/.local/share/pnpm/") ||
    normalized.includes("/library/pnpm/") ||
    normalized.includes("/local/share/pnpm/") ||
    normalized.includes("/appdata/local/pnpm/") ||
    normalized.includes("/pnpm/global/")
  );
}

function isNpmGlobalCommandPath(
  commandPath: string,
  options?: ProviderMaintenanceCapabilityResolutionOptions,
): boolean {
  const normalized = normalizeCommandPath(commandPath);
  if (normalized.includes("/lib/node_modules/") || normalized.includes("/npm/node_modules/")) {
    return true;
  }

  const appData = nonEmptyString(options?.env?.APPDATA);
  return (
    options?.platform === "win32" &&
    appData !== null &&
    normalized.startsWith(`${normalizeCommandPath(appData)}/npm/`)
  );
}

function isHomebrewCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/opt/homebrew/cellar/") ||
    normalized.includes("/usr/local/cellar/") ||
    normalized.includes("/homebrew/cellar/") ||
    normalized.includes("/opt/homebrew/caskroom/") ||
    normalized.includes("/usr/local/caskroom/") ||
    normalized.includes("/homebrew/caskroom/") ||
    normalized.startsWith("/opt/homebrew/bin/") ||
    normalized.startsWith("/usr/local/bin/")
  );
}

export function resolvePackageManagedProviderMaintenance(
  definition: PackageManagedProviderMaintenanceDefinition,
  options?: ProviderMaintenanceCapabilityResolutionOptions,
): ProviderMaintenanceCapabilities {
  const binaryPath = nonEmptyString(options?.binaryPath);
  if (!binaryPath) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
      ...(definition.approvedVersion ? { approvedVersion: definition.approvedVersion } : {}),
    });
  }

  const resolvedCommandPath =
    resolveCommandPath(binaryPath, {
      ...(options?.platform ? { platform: options.platform } : {}),
      ...(options?.env ? { env: options.env } : {}),
    }) ?? (hasPathSeparator(binaryPath) ? binaryPath : null);

  if (resolvedCommandPath) {
    const commandPaths = [
      resolvedCommandPath,
      ...(options?.realCommandPath ? [options.realCommandPath] : []),
    ];

    const nativeUpdate = definition.nativeUpdate;
    if (
      nativeUpdate &&
      commandPaths.some((commandPath) => nativeUpdate.isCommandPath(commandPath))
    ) {
      return (
        makeNativeProviderMaintenanceCapabilities(definition) ??
        makeNpmGlobalProviderMaintenanceCapabilities(definition, options)
      );
    }
    if (commandPaths.some(isVitePlusGlobalCommandPath)) {
      return makeVitePlusGlobalProviderMaintenanceCapabilities(definition);
    }
    if (commandPaths.some(isPnpmGlobalCommandPath)) {
      return makePnpmGlobalProviderMaintenanceCapabilities(definition);
    }
    if (commandPaths.some((commandPath) => isNpmGlobalCommandPath(commandPath, options))) {
      return makeNpmGlobalProviderMaintenanceCapabilities(definition, options);
    }
    if (commandPaths.some(isHomebrewCommandPath)) {
      return makeHomebrewProviderMaintenanceCapabilities(definition);
    }
  }

  if (!hasPathSeparator(binaryPath)) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
      ...(definition.approvedVersion ? { approvedVersion: definition.approvedVersion } : {}),
    });
  }

  return makeManualOnlyProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    ...(definition.approvedVersion ? { approvedVersion: definition.approvedVersion } : {}),
  });
}

export function makePackageManagedProviderMaintenanceResolver(
  definition: PackageManagedProviderMaintenanceDefinition,
): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: (options) => resolvePackageManagedProviderMaintenance(definition, options),
  };
}

export function makeStaticProviderMaintenanceResolver(
  capabilities: ProviderMaintenanceCapabilities,
): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: () => capabilities,
  };
}

function makeManualProviderMaintenanceCapabilities(
  provider: ProviderDriverKind,
): ProviderMaintenanceCapabilities {
  return makeManualOnlyProviderMaintenanceCapabilities({
    provider,
    packageName: null,
  });
}

export const resolveProviderMaintenanceCapabilitiesEffect = Effect.fn(
  "resolveProviderMaintenanceCapabilitiesEffect",
)(function* (
  resolver: ProviderMaintenanceCapabilitiesResolver,
  options?: Omit<ProviderMaintenanceCapabilityResolutionOptions, "realCommandPath">,
) {
  const binaryPath = nonEmptyString(options?.binaryPath);
  if (!binaryPath) {
    return resolver.resolve(options);
  }

  const resolvedCommandPath =
    resolveCommandPath(binaryPath, {
      ...(options?.platform ? { platform: options.platform } : {}),
      ...(options?.env ? { env: options.env } : {}),
    }) ?? (hasPathSeparator(binaryPath) ? binaryPath : null);
  if (!resolvedCommandPath) {
    return resolver.resolve(options);
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const realCommandPath = yield* fileSystem
    .realPath(resolvedCommandPath)
    .pipe(Effect.catch(() => Effect.succeed(resolvedCommandPath)));
  return resolver.resolve({
    ...options,
    realCommandPath,
  });
});

function deriveVersionAdvisory(input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
}): Pick<ServerProviderVersionAdvisory, "status" | "message"> {
  if (!input.currentVersion) {
    return { status: "unknown", message: null };
  }
  if (!input.latestVersion) {
    return { status: "unknown", message: null };
  }
  if (compareSemverVersions(input.currentVersion, input.latestVersion) < 0) {
    return {
      status: "behind_latest",
      message: PROVIDER_UPDATE_ACTION_TOAST_MESSAGE,
    };
  }
  return { status: "current", message: null };
}

export function createProviderVersionAdvisory(input: {
  readonly driver: ProviderDriverKind;
  readonly currentVersion: string | null;
  readonly latestVersion?: string | null;
  readonly checkedAt?: string | null;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
}): ServerProviderVersionAdvisory {
  const capabilities =
    input.maintenanceCapabilities ?? makeManualProviderMaintenanceCapabilities(input.driver);
  const latestVersion = input.latestVersion ?? null;
  const approvedVersion = capabilities.approvedVersion;
  const currentVersionForComparison = input.currentVersion?.split("+", 1)[0] ?? null;
  const approvedVersionForComparison = approvedVersion?.split("+", 1)[0];
  const latestVersionForComparison = latestVersion?.split("+", 1)[0] ?? null;
  const advisory = deriveVersionAdvisory({
    currentVersion: currentVersionForComparison,
    latestVersion: latestVersionForComparison,
  });
  const needsApprovedVersion =
    approvedVersionForComparison !== undefined &&
    currentVersionForComparison !== null &&
    compareSemverVersions(currentVersionForComparison, approvedVersionForComparison) !== 0;
  const isAheadOfApproved =
    needsApprovedVersion &&
    approvedVersionForComparison !== undefined &&
    currentVersionForComparison !== null &&
    compareSemverVersions(currentVersionForComparison, approvedVersionForComparison) > 0;
  const approvalPending =
    approvedVersionForComparison !== undefined &&
    latestVersionForComparison !== null &&
    compareSemverVersions(latestVersionForComparison, approvedVersionForComparison) > 0 &&
    !needsApprovedVersion;
  const upstreamDiffersFromApproved =
    approvedVersionForComparison !== undefined &&
    latestVersionForComparison !== null &&
    compareSemverVersions(latestVersionForComparison, approvedVersionForComparison) > 0;

  return {
    // Keep the established wire literal so an older renderer degrades safely.
    // approvedVersion carries the finer-grained conformity state.
    status: needsApprovedVersion ? "behind_latest" : advisory.status,
    currentVersion: input.currentVersion,
    latestVersion,
    approvedVersion: approvedVersion ?? null,
    updateCommand: approvedVersion === undefined ? (capabilities.update?.command ?? null) : null,
    canUpdate: approvedVersion === undefined && capabilities.update !== null,
    checkedAt: input.checkedAt ?? null,
    message: needsApprovedVersion
      ? `Provider ${String(input.currentVersion)} differs from approved version ${approvedVersion}. Run the detached provider conformity workflow to ${isAheadOfApproved ? "revert" : "update"} safely.${upstreamDiffersFromApproved ? ` Upstream ${latestVersion} is still awaiting conformity.` : ""}`
      : approvalPending
        ? `Provider ${latestVersion} is available but has not passed Club Code conformity yet.`
        : advisory.message,
  };
}

const fetchNpmLatestVersion = Effect.fn("fetchNpmLatestVersion")(function* (packageName: string) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
  ).pipe(HttpClientRequest.setHeader("accept", "application/json"));
  const response = yield* client.execute(request).pipe(
    Effect.timeoutOption(LATEST_VERSION_TIMEOUT_MS),
    Effect.catch(() => Effect.succeed(Option.none())),
  );
  if (Option.isNone(response)) {
    return null;
  }
  const httpResponse = response.value;
  if (httpResponse.status < 200 || httpResponse.status >= 300) {
    return null;
  }
  const payload = yield* httpResponse.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(NpmLatestVersionResponse)),
    Effect.catch(() => Effect.succeed(null)),
  );
  return payload ? nonEmptyString(payload.version) : null;
});

export const resolveLatestProviderVersion = Effect.fn("resolveLatestProviderVersion")(function* (
  maintenanceCapabilities: ProviderMaintenanceCapabilities,
) {
  const packageName = maintenanceCapabilities.packageName;
  if (!packageName) {
    return null;
  }

  const cached = latestVersionCache.get(packageName);
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  if (cached && cached.expiresAt > now) {
    return cached.version;
  }

  const version = yield* fetchNpmLatestVersion(packageName);
  latestVersionCache.set(packageName, {
    expiresAt: now + LATEST_VERSION_CACHE_TTL_MS,
    version,
  });
  return version;
});

export const enrichProviderSnapshotWithVersionAdvisory = Effect.fn(
  "enrichProviderSnapshotWithVersionAdvisory",
)(function* (snapshot: ServerProvider, maintenanceCapabilities?: ProviderMaintenanceCapabilities) {
  const capabilities =
    maintenanceCapabilities ?? makeManualProviderMaintenanceCapabilities(snapshot.driver);
  if (!snapshot.enabled || !snapshot.installed || !snapshot.version) {
    return {
      ...snapshot,
      versionAdvisory: createProviderVersionAdvisory({
        driver: snapshot.driver,
        currentVersion: snapshot.version,
        checkedAt: snapshot.checkedAt,
        maintenanceCapabilities: capabilities,
      }),
    };
  }

  const latestVersion = yield* resolveLatestProviderVersion(capabilities);
  return {
    ...snapshot,
    versionAdvisory: createProviderVersionAdvisory({
      driver: snapshot.driver,
      currentVersion: snapshot.version,
      latestVersion,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      maintenanceCapabilities: capabilities,
    }),
  };
});
