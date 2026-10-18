// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
  ServerProviderDataProfile,
} from "@cafecode/contracts";
import { CodexSettings, ClaudeSettings, GrokSettings } from "@cafecode/contracts";
import * as Schema from "effect/Schema";

import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import { CAFE_CODE_MANAGED_RUNTIME_ROOT_ENV } from "./managedProviderRuntime.ts";

/** Immutable startup metadata. The base directory is already profile-resolved. */
export interface ProviderDataProfile {
  readonly dataProfile?: "production" | "debug" | undefined;
  readonly baseDir: string;
}

const LOCAL_HOME_DRIVERS = new Set(["codex", "claudeAgent", "grok"]);
const LEGACY_DRIVERS = ["codex", "claudeAgent", "grok", "opencode"] as const;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Apply defaults to the raw, not yet decoded settings document. Applying them
 * after the shared codec would lose the distinction between a saved choice and
 * its Production default (including Axiom's automatically inserted envelope).
 * Explicit Debug choices survive subsequent sparse saves and reloads.
 */
export function applyDebugProviderSettingsDefaults(value: unknown): unknown {
  const settings = record(value);
  if (!settings) return value;
  const providers = { ...(record(settings.providers) ?? {}) };
  for (const driver of LEGACY_DRIVERS) {
    const config = record(providers[driver]) ?? {};
    providers[driver] = { ...config, enabled: config.enabled ?? false };
  }
  const instances = { ...(record(settings.providerInstances) ?? {}) };
  if (!("axiom" in instances)) instances.axiom = { driver: "axiom", enabled: false };
  for (const [id, value] of Object.entries(instances)) {
    const entry = record(value);
    if (!entry) continue; // The original codec retains responsibility for errors.
    const config = record(entry.config);
    instances[id] = { ...entry, enabled: entry.enabled ?? config?.enabled ?? false };
  }
  return { ...settings, providers, providerInstances: instances };
}

/**
 * Do not inherit a terminal's provider account selection into a fresh Debug
 * account. Explicit per-instance credentials remain a deliberate supported
 * choice; the ambient values are removed before applying that instance's env.
 * This does not scrub unrelated tool variables or modify the parent process.
 */
const AMBIENT_NATIVE_SELECTION_KEYS = new Set([
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
  "CODEX_CONFIG",
  "CODEX_AUTH_JSON",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_ORG_ID",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT_ID",
  "OPENAI_ACCESS_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "GROK_HOME",
  "GROK_API_KEY",
  "XAI_API_KEY",
]);
const HOME_SELECTION_KEYS = new Set([
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "APPDATA",
  "LOCALAPPDATA",
]);
const NATIVE_PATH_SELECTION_KEYS = new Set([
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
  "CODEX_CONFIG",
  "CODEX_AUTH_JSON",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "GROK_HOME",
]);
const EXTERNAL_CLAUDE_AUTH_SELECTION_KEYS = new Set([
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
]);
const NATIVE_STATE_ROOT_ENTRIES = [
  "auth.json",
  "config.toml",
  "managed_config.toml",
  "history.jsonl",
  "sessions",
  "archived_sessions",
  "sqlite",
  "state.sqlite",
  "state_5.sqlite",
  "config.json",
  "settings.json",
  ".claude",
  ".claude.json",
] as const;
const CLAUDE_STATE_ENTRIES = [
  ".credentials.json",
  "settings.json",
  "history.jsonl",
  "projects",
] as const;

export type ProviderProfileAdmission =
  | { readonly kind: "refused"; readonly reason: string }
  | {
      readonly kind: "admitted";
      readonly config: unknown;
      readonly processEnvironment: NodeJS.ProcessEnv;
      readonly nativeHome?: string | undefined;
    };

/**
 * Authenticated Settings-only presentation. This is intentionally absent from
 * native runtime events, cached provider snapshots and debug journal receipts.
 * No provider/auth probe or filesystem read is needed to describe the intended
 * storage target, including a disabled account that still needs manual login.
 */
export function describeProviderDataProfiles(
  profile: ProviderDataProfile,
  instances: ProviderInstanceConfigMap,
): Record<ProviderInstanceId, ServerProviderDataProfile> | undefined {
  if (profile.dataProfile !== "debug") return undefined;
  return Object.fromEntries(
    Object.entries(instances).map(([id, entry]) => {
      const instanceId = id as ProviderInstanceId;
      if (entry.debugStateSharing === true) return [id, { scope: "shared" }];
      const decoded =
        entry.driver === "codex"
          ? Schema.decodeUnknownExit(CodexSettings)(entry.config ?? {})
          : entry.driver === "claudeAgent"
            ? Schema.decodeUnknownExit(ClaudeSettings)(entry.config ?? {})
            : entry.driver === "grok"
              ? Schema.decodeUnknownExit(GrokSettings)(entry.config ?? {})
              : undefined;
      if (!decoded || decoded._tag === "Failure") return [id, { scope: "unconfigured" }];
      const config = decoded.value;
      const enabled =
        entry.enabled ?? (typeof config.enabled === "boolean" ? config.enabled : true);
      const proposed = resolveProviderProfileAdmission({
        profile,
        instanceId,
        entry,
        config,
        enabled: true,
        baseEnvironment: {},
      });
      return [
        id,
        proposed.kind === "admitted" && proposed.nativeHome
          ? { scope: enabled ? "profile-local" : "unconfigured", nativeHome: proposed.nativeHome }
          : { scope: "unconfigured" },
      ];
    }),
  ) as Record<ProviderInstanceId, ServerProviderDataProfile>;
}

/** Path spelling is host-native; hashing also prevents Windows case collisions. */
export function debugProviderHome(
  profile: ProviderDataProfile,
  driver: string,
  instanceId: ProviderInstanceId,
): string {
  const identity = createHash("sha256").update(`${driver}\0${instanceId}`).digest("hex");
  if (!LOCAL_HOME_DRIVERS.has(driver)) throw new Error("Driver has no Debug-local home policy.");
  return NodePath.join(profile.baseDir, "provider-homes", driver, identity);
}

/**
 * One admission policy serves ordinary sessions, metadata/history helpers and
 * the separately exposed native login command. A driver cannot obtain account
 * access merely by being present in the built-in registry.
 */
export function resolveProviderProfileAdmission(input: {
  readonly profile?: ProviderDataProfile | undefined;
  readonly instanceId: ProviderInstanceId;
  readonly entry: ProviderInstanceConfig;
  readonly config: unknown;
  readonly enabled: boolean;
  readonly baseEnvironment?: NodeJS.ProcessEnv | undefined;
}): ProviderProfileAdmission {
  const { profile, entry } = input;
  const baseEnvironment = input.baseEnvironment ?? process.env;
  if (profile?.dataProfile !== "debug") {
    return {
      kind: "admitted",
      config: input.config,
      processEnvironment: mergeProviderInstanceEnvironment(entry.environment, baseEnvironment),
    };
  }
  if (!input.enabled) {
    return {
      kind: "refused",
      reason: "Debug provider is disabled. Configure and enable it explicitly to start it.",
    };
  }
  if (entry.debugStateSharing === true) {
    const processEnvironment = mergeProviderInstanceEnvironment(entry.environment, baseEnvironment);
    return {
      kind: "admitted",
      config: input.config,
      // Shared native state is deliberate, but Cafe must not thereby grant a
      // background executable update against that same shared installation.
      processEnvironment:
        entry.driver === "claudeAgent"
          ? { ...processEnvironment, DISABLE_AUTOUPDATER: "1" }
          : processEnvironment,
    };
  }
  if (!LOCAL_HOME_DRIVERS.has(entry.driver)) {
    return {
      kind: "refused",
      reason:
        "This driver has no qualified Debug-local native home. Explicitly allow shared native provider state in its settings before enabling it.",
    };
  }
  const config = record(input.config);
  if (!config) {
    return { kind: "refused", reason: "Debug provider settings are invalid." };
  }
  const home = debugProviderHome(profile, entry.driver, input.instanceId);
  const homeSelectors: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: NodePath.join(home, "config"),
    XDG_DATA_HOME: NodePath.join(home, "data"),
    XDG_CACHE_HOME: NodePath.join(home, "cache"),
    XDG_STATE_HOME: NodePath.join(home, "state"),
    APPDATA: NodePath.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: NodePath.join(home, "AppData", "Local"),
    CODEX_HOME: home,
    CODEX_SQLITE_HOME: home,
    CLAUDE_CONFIG_DIR: NodePath.join(home, ".claude"),
    GROK_HOME: home,
  };
  // Never silently reinterpret a saved external native home as private state.
  // The UI exposes the explicit shared-state consent, with its real limits.
  if (
    (typeof config.homePath === "string" &&
      config.homePath.trim() !== "" &&
      NodePath.resolve(config.homePath) !== home) ||
    (typeof config.shadowHomePath === "string" && config.shadowHomePath.trim() !== "") ||
    (entry.driver === "claudeAgent" &&
      typeof config.launchArgs === "string" &&
      config.launchArgs.trim() !== "") ||
    (entry.environment ?? []).some((variable) => {
      const key = variable.name.toUpperCase();
      // Native cloud credential chains have additional OS/global selection
      // mechanisms that this local-home policy does not qualify. Do not label
      // those chains private merely because the Claude config directory moved.
      if (
        entry.driver === "claudeAgent" &&
        EXTERNAL_CLAUDE_AUTH_SELECTION_KEYS.has(key) &&
        variable.value.trim() !== ""
      )
        return true;
      return (
        (HOME_SELECTION_KEYS.has(key) ||
          NATIVE_PATH_SELECTION_KEYS.has(key) ||
          (/^(?:CODEX|OPENAI|ANTHROPIC|CLAUDE|GROK|XAI)_/.test(key) &&
            /_(?:HOME|DIR|FILE|PATH|CONFIG)$/.test(key))) &&
        variable.value.trim() !== "" &&
        (homeSelectors[key] === undefined ||
          NodePath.resolve(variable.value) !== homeSelectors[key])
      );
    })
  ) {
    return {
      kind: "refused",
      reason:
        "External native homes, custom Claude launch arguments and cloud authentication selectors require explicit shared-state consent in Debug. Clear the unsupported overrides to use the private Debug account.",
    };
  }
  const environment: NodeJS.ProcessEnv = {};
  // Some native launch helpers intentionally use extendEnv:true. Explicit
  // undefined properties are therefore removal tombstones, not optional
  // omissions: the later overlay must not resurrect a shell account. Keep
  // every known fixed selector plus all observed provider-prefixed keys.
  for (const key of AMBIENT_NATIVE_SELECTION_KEYS) environment[key] = undefined;
  for (const key of HOME_SELECTION_KEYS) environment[key] = undefined;
  for (const [key, value] of Object.entries(baseEnvironment)) {
    const canonical = key.toUpperCase();
    if (
      AMBIENT_NATIVE_SELECTION_KEYS.has(canonical) ||
      HOME_SELECTION_KEYS.has(canonical) ||
      /^(?:CODEX|OPENAI|ANTHROPIC|CLAUDE|GROK|XAI)_/.test(canonical)
    ) {
      environment[key] = undefined;
    } else {
      environment[key] = value;
    }
  }
  const explicit = mergeProviderInstanceEnvironment(entry.environment, {});
  for (const [key, value] of Object.entries(explicit)) {
    const canonical = key.toUpperCase();
    if (HOME_SELECTION_KEYS.has(canonical) || NATIVE_PATH_SELECTION_KEYS.has(canonical)) continue;
    environment[AMBIENT_NATIVE_SELECTION_KEYS.has(canonical) ? canonical : key] = value;
  }
  Object.assign(environment, homeSelectors);
  // Sharing read-only executable generations is independent of relocating the
  // account's LOCALAPPDATA. Resolve the installer root from the original
  // environment before that relocation; maintenance is separately refused.
  if (
    process.platform === "win32" &&
    !environment[CAFE_CODE_MANAGED_RUNTIME_ROOT_ENV] &&
    baseEnvironment.LOCALAPPDATA
  ) {
    environment[CAFE_CODE_MANAGED_RUNTIME_ROOT_ENV] = NodePath.win32.join(
      baseEnvironment.LOCALAPPDATA,
      "CafeCode",
      "managed",
    );
  }
  if (entry.driver === "claudeAgent") environment.DISABLE_AUTOUPDATER = "1";
  // Do not accept a native secure-storage account selector independent of the
  // home we qualified. Empty omission permits Claude's supported config-dir key.
  environment.CLAUDE_SECURESTORAGE_CONFIG_DIR = undefined;
  return {
    kind: "admitted",
    config: {
      ...config,
      homePath: home,
      ...(entry.driver === "codex" ? { shadowHomePath: "" } : {}),
    },
    processEnvironment: environment,
    nativeHome: home,
  };
}

/**
 * Prepare only the fixed, server-minted account directory. Refuse existing
 * symlink/junction components instead of following them into another profile.
 * As elsewhere, this is not a sandbox against another process with the same OS
 * identity changing its own namespace after admission.
 */
export async function prepareDebugProviderHome(
  profile: ProviderDataProfile,
  home: string,
): Promise<void> {
  if (
    profile.dataProfile !== "debug" ||
    !NodePath.isAbsolute(profile.baseDir) ||
    !NodePath.isAbsolute(home)
  ) {
    throw new Error("Debug provider home requires an absolute admitted Debug profile.");
  }
  const relative = NodePath.relative(profile.baseDir, home);
  if (
    relative.startsWith(`..${NodePath.sep}`) ||
    relative === ".." ||
    NodePath.isAbsolute(relative)
  ) {
    throw new Error("Debug provider home escaped its data profile.");
  }
  const components = [profile.baseDir];
  let current = profile.baseDir;
  for (const segment of relative.split(NodePath.sep)) {
    current = NodePath.join(current, segment);
    components.push(current);
  }
  for (const [index, directory] of components.entries()) {
    if (index > 0)
      await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      });
    const state = await lstat(directory);
    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw new Error("Debug provider home contains an unsafe directory alias.");
    }
    if (
      process.platform !== "win32" &&
      (state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0)
    ) {
      throw new Error("Debug provider home must be private to the current user.");
    }
  }
  // Private parent directories alone do not prove account isolation when an
  // existing native auth/config/history entry points back to another profile.
  // Inspect only fixed account roots; do not enumerate or read transcripts.
  const stateEntries = [
    ...NATIVE_STATE_ROOT_ENTRIES.map((entry) => NodePath.join(home, entry)),
    ...CLAUDE_STATE_ENTRIES.map((entry) => NodePath.join(home, ".claude", entry)),
  ];
  for (const entry of stateEntries) {
    const state = await lstat(entry).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (state?.isSymbolicLink() || (state?.isFile() && state.nlink !== 1)) {
      throw new Error(
        "Debug native account state contains an unsafe alias. Use explicit shared-state consent only if sharing is intentional.",
      );
    }
  }
}
