import {
  type GeminiSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@cafecode/shared/model";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

export const GEMINI_PROVIDER = ProviderDriverKind.make("gemini");
export const GEMINI_ACP_ARGS = ["--acp"] as const;
export const GEMINI_DEFAULT_AUTH_METHOD = "oauth-personal";

const GEMINI_PRESENTATION = {
  displayName: "Gemini",
  badgeLabel: "v0",
  showInteractionModeToggle: true,
} as const;

const DEFAULT_GEMINI_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Auto",
    shortName: "Auto",
    isCustom: false,
    capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3-pro-preview",
    name: "Gemini 3 Pro Preview",
    shortName: "3 Pro",
    isCustom: false,
    capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    shortName: "3 Flash",
    isCustom: false,
    capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    shortName: "2.5 Pro",
    isCustom: false,
    capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    shortName: "2.5 Flash",
    isCustom: false,
    capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    shortName: "2.5 Lite",
    isCustom: false,
    capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
  },
];

function geminiModelsFromSettings(settings: GeminiSettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    BUILT_IN_MODELS,
    GEMINI_PROVIDER,
    settings.customModels,
    DEFAULT_GEMINI_MODEL_CAPABILITIES,
  );
}

const runGeminiCommand = (
  geminiSettings: GeminiSettings,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) => {
  const command = ChildProcess.make(geminiSettings.binaryPath, [...args], {
    env,
    shell: process.platform === "win32",
  });
  return spawnAndCollect(geminiSettings.binaryPath, command);
};

export const makePendingGeminiProvider = (
  geminiSettings: GeminiSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = geminiModelsFromSettings(geminiSettings);

    if (!geminiSettings.enabled) {
      return buildServerProvider({
        presentation: GEMINI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Gemini is disabled in Cafe Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Gemini provider status has not been checked in this session yet.",
      },
    });
  });

export const checkGeminiProviderStatus = Effect.fn("checkGeminiProviderStatus")(function* (
  geminiSettings: GeminiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = geminiModelsFromSettings(geminiSettings);

  if (!geminiSettings.enabled) {
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Gemini is disabled in Cafe Code settings.",
      },
    });
  }

  const versionProbe = yield* runGeminiCommand(geminiSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: geminiSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Gemini CLI (`gemini`) is not installed or not on PATH."
          : `Failed to execute Gemini CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: geminiSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Gemini CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const versionResult = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (versionResult.code !== 0) {
    const detail = detailFromResult(versionResult);
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: geminiSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Gemini CLI is installed but failed to run. ${detail}`
          : "Gemini CLI is installed but failed to run.",
      },
    });
  }

  return buildServerProvider({
    presentation: GEMINI_PRESENTATION,
    enabled: geminiSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "warning",
      auth: { status: "unknown" },
      message:
        "Gemini CLI is installed. Cafe Code v0 verifies authentication when a Gemini ACP session starts.",
    },
    runtimeCapabilities: { liveSteer: "unsupported" },
  });
});
