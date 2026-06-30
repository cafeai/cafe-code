// @effect-diagnostics nodeBuiltinImport:off
import type { ProviderCliRuntimeSource, ProviderDriverKind } from "@cafecode/contracts";
import path from "node:path";

import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type PackageManagedProviderMaintenanceDefinition,
  type ProviderMaintenanceCapabilities,
} from "./providerMaintenance.ts";

export const CAFE_CODE_MANAGED_RUNTIME_ROOT_ENV = "CAFE_CODE_MANAGED_RUNTIME_ROOT";
export const CAFE_CODE_BUNDLED_NODE_DIR_ENV = "CAFE_CODE_BUNDLED_NODE_DIR";
export const CAFE_CODE_BUNDLED_NPM_PATH_ENV = "CAFE_CODE_BUNDLED_NPM_PATH";

export interface ManagedProviderRuntimeLayout {
  readonly providerRoot: string;
  readonly installRoot: string;
  readonly binaryDir: string;
  readonly binaryPath: string;
  readonly nodeDir: string;
  readonly npmPath: string;
  readonly npmCacheDir: string;
  readonly npmPrefixDir: string;
}

export interface ManagedProviderRuntimeResolution {
  readonly runtimeSource: ProviderCliRuntimeSource;
  readonly binaryPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly layout: ManagedProviderRuntimeLayout | null;
  readonly unavailableReason: string | null;
}

export interface ResolveManagedProviderRuntimeOptions {
  readonly provider: ProviderDriverKind;
  readonly runtimeSource: ProviderCliRuntimeSource;
  readonly systemBinaryPath: string;
  readonly packageMaintenance: PackageManagedProviderMaintenanceDefinition;
  readonly baseEnv?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

const PROVIDER_RUNTIME_METADATA = {
  codex: {
    slug: "codex",
    binaryName: "codex",
  },
  claudeAgent: {
    slug: "claude",
    binaryName: "claude",
  },
} as const;

function readEnvValue(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function windowsPathFromSegments(...segments: ReadonlyArray<string>): string {
  return path.win32.join(...segments);
}

function resolveManagedRuntimeRoot(env: NodeJS.ProcessEnv): string | null {
  const explicitRoot = readEnvValue(env, CAFE_CODE_MANAGED_RUNTIME_ROOT_ENV);
  if (explicitRoot) {
    return explicitRoot;
  }
  const localAppData = readEnvValue(env, "LOCALAPPDATA");
  return localAppData ? windowsPathFromSegments(localAppData, "CafeCode", "managed") : null;
}

function prependWindowsPathEntries(
  env: NodeJS.ProcessEnv,
  entries: ReadonlyArray<string>,
): NodeJS.ProcessEnv {
  const currentPath = env.PATH ?? env.Path ?? "";
  const nextPath = [...entries.filter((entry) => entry.trim().length > 0), currentPath]
    .filter((entry) => entry.trim().length > 0)
    .join(";");
  return {
    ...env,
    PATH: nextPath,
    Path: undefined,
  };
}

function providerRuntimeMetadata(provider: ProviderDriverKind) {
  return (
    PROVIDER_RUNTIME_METADATA[String(provider) as keyof typeof PROVIDER_RUNTIME_METADATA] ?? null
  );
}

function unavailableBundledBinaryPath(
  provider: ProviderDriverKind,
  platform: NodeJS.Platform,
): string {
  const metadata = providerRuntimeMetadata(provider);
  const binaryName = metadata?.binaryName ?? "provider";
  if (platform === "win32") {
    return windowsPathFromSegments(
      "C:\\",
      "__CafeCodeBundledRuntimeUnavailable__",
      `${binaryName}.cmd`,
    );
  }
  return path.posix.join("/", "__cafecode_bundled_runtime_unavailable__", binaryName);
}

export function resolveManagedProviderRuntimeLayout(input: {
  readonly provider: ProviderDriverKind;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): ManagedProviderRuntimeLayout | null {
  const metadata = providerRuntimeMetadata(input.provider);
  if (!metadata) {
    return null;
  }
  const env = input.env ?? process.env;
  const managedRoot = resolveManagedRuntimeRoot(env);
  if (!managedRoot) {
    return null;
  }

  const nodeDir =
    readEnvValue(env, CAFE_CODE_BUNDLED_NODE_DIR_ENV) ??
    windowsPathFromSegments(managedRoot, "node", "current");
  const npmPath =
    readEnvValue(env, CAFE_CODE_BUNDLED_NPM_PATH_ENV) ??
    windowsPathFromSegments(nodeDir, "npm.cmd");
  const providerRoot = windowsPathFromSegments(managedRoot, "providers", metadata.slug);
  const installRoot = windowsPathFromSegments(providerRoot, "current");
  const binaryDir = windowsPathFromSegments(installRoot, "node_modules", ".bin");

  return {
    providerRoot,
    installRoot,
    binaryDir,
    binaryPath: windowsPathFromSegments(binaryDir, `${metadata.binaryName}.cmd`),
    nodeDir,
    npmPath,
    npmCacheDir: windowsPathFromSegments(managedRoot, "npm-cache"),
    npmPrefixDir: installRoot,
  };
}

export function makeManagedProviderMaintenanceCapabilities(input: {
  readonly definition: PackageManagedProviderMaintenanceDefinition;
  readonly layout: ManagedProviderRuntimeLayout | null;
}): ProviderMaintenanceCapabilities {
  if (!input.layout) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: input.definition.provider,
      packageName: input.definition.npmPackageName,
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider: input.definition.provider,
    packageName: input.definition.npmPackageName,
    updateExecutable: input.layout.npmPath,
    updateArgs: [
      "install",
      "--prefix",
      input.layout.npmPrefixDir,
      "--cache",
      input.layout.npmCacheDir,
      `${input.definition.npmPackageName}@latest`,
    ],
    updateLockKey: `managed-npm:${String(input.definition.provider)}`,
  });
}

export function resolveProviderRuntimeEnvironment(
  input: ResolveManagedProviderRuntimeOptions,
): ManagedProviderRuntimeResolution {
  const env = input.baseEnv ?? process.env;
  if (input.runtimeSource === "system") {
    return {
      runtimeSource: "system",
      binaryPath: input.systemBinaryPath,
      env,
      maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
        provider: input.packageMaintenance.provider,
        packageName: input.packageMaintenance.npmPackageName,
      }),
      layout: null,
      unavailableReason: null,
    };
  }

  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      runtimeSource: "bundled",
      binaryPath: unavailableBundledBinaryPath(input.provider, platform),
      env,
      maintenanceCapabilities: makeManagedProviderMaintenanceCapabilities({
        definition: input.packageMaintenance,
        layout: null,
      }),
      layout: null,
      unavailableReason:
        "Cafe Code bundled provider runtimes are currently supported only on Windows.",
    };
  }

  const layout = resolveManagedProviderRuntimeLayout({ provider: input.provider, env });
  if (!layout) {
    return {
      runtimeSource: "bundled",
      binaryPath: unavailableBundledBinaryPath(input.provider, platform),
      env,
      maintenanceCapabilities: makeManagedProviderMaintenanceCapabilities({
        definition: input.packageMaintenance,
        layout: null,
      }),
      layout: null,
      unavailableReason:
        "Cafe Code could not resolve a managed provider runtime root. Set LOCALAPPDATA or CAFE_CODE_MANAGED_RUNTIME_ROOT.",
    };
  }

  const nextEnv = prependWindowsPathEntries(env, [layout.binaryDir, layout.nodeDir]);
  return {
    runtimeSource: "bundled",
    binaryPath: layout.binaryPath,
    env: {
      ...nextEnv,
      npm_config_prefix: layout.npmPrefixDir,
      npm_config_cache: layout.npmCacheDir,
    },
    maintenanceCapabilities: makeManagedProviderMaintenanceCapabilities({
      definition: input.packageMaintenance,
      layout,
    }),
    layout,
    unavailableReason: null,
  };
}
