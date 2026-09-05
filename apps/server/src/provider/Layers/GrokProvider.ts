import {
  type GrokSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
  type ServerProviderModel,
} from "@cafecode/contracts";
import { createModelCapabilities } from "@cafecode/shared/model";
import { compareSemverVersions } from "@cafecode/shared/semver";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { parseGrokAccountRateLimitsPayload } from "../grokAccountUsage.ts";
import {
  GrokSandboxProfile,
  makeGrokAcpRuntime,
  readGrokAcpModelMetadata,
  resolveGrokAcpBaseModelId,
} from "../acp/GrokAcpSupport.ts";

const PROVIDER = ProviderDriverKind.make("grok");
const GROK_PRESENTATION = {
  displayName: "Grok Build",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const MINIMUM_GROK_VERSION = "1.0.4";
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const GROK_ACP_PROBE_TIMEOUT_MS = 15_000;
const GROK_INSPECT_TIMEOUT_MS = 8_000;
const GROK_INSPECT_MAX_BYTES = 2 * 1024 * 1024;

const GROK_OWNERSHIP_COMMANDS = new Set([
  "always-approve",
  "auto",
  "effort",
  "exit",
  "goal",
  "load",
  "model",
  "new",
  "plan",
  "quit",
  "resume",
  "rewind",
]);

export function grokSlashCommandsFromAcp(
  commands: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly input?: { readonly hint: string };
  }>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  return commands.flatMap((command) => {
    const name = command.name.trim().replace(/^\/+/, "");
    if (!name || seen.has(name) || GROK_OWNERSHIP_COMMANDS.has(name.toLowerCase())) return [];
    seen.add(name);
    return [
      {
        name,
        ...(command.description?.trim() ? { description: command.description.trim() } : {}),
        ...(command.input?.hint.trim() ? { input: { hint: command.input.hint.trim() } } : {}),
      },
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseGrokInspectSkills(
  rawJson: string,
  cwd: string,
): ReadonlyArray<ServerProviderSkill> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawJson) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(decoded) || !Array.isArray(decoded.skills)) return [];
  const seen = new Set<string>();
  return decoded.skills.flatMap((candidate) => {
    if (!isRecord(candidate) || candidate.userInvocable !== true) return [];
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const description =
      typeof candidate.description === "string" ? candidate.description.trim() : "";
    const source = isRecord(candidate.source) ? candidate.source : undefined;
    const skillPath = typeof source?.path === "string" ? source.path.trim() : "";
    if (!name || !skillPath || seen.has(name)) return [];
    seen.add(name);
    return [
      {
        name,
        ...(description ? { description, shortDescription: description } : {}),
        path: skillPath,
        scope: skillPath.startsWith(cwd) ? "project" : "user",
        enabled: true,
        displayName: name,
      },
    ];
  });
}

const discoverGrokSkills = (settings: GrokSettings, cwd: string, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = settings.binaryPath || "grok";
    const homePath = settings.homePath?.trim();
    const child = yield* spawner.spawn(
      ChildProcess.make(command, ["--no-auto-update", "inspect", "--json"], {
        cwd,
        env: {
          ...environment,
          ...(homePath ? { GROK_HOME: homePath } : {}),
        },
        extendEnv: true,
        shell: false,
      }),
    );
    const [stdout, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: GROK_INSPECT_MAX_BYTES }),
        child.exitCode.pipe(Effect.map(Number)),
        // Always drain stderr, but never retain or log it because provider
        // diagnostics can contain paths and user configuration.
        Stream.runDrain(child.stderr),
      ],
      { concurrency: "unbounded" },
    );
    return exitCode === 0 && !stdout.truncated ? parseGrokInspectSkills(stdout.text, cwd) : [];
  }).pipe(Effect.scoped);

function buildGrokModelCapabilities(model: EffectAcpSchema.ModelInfo): ModelCapabilities {
  const metadata = readGrokAcpModelMetadata(model);
  return createModelCapabilities({
    optionDescriptors:
      metadata.reasoningEfforts.length > 0
        ? [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              options: metadata.reasoningEfforts.map((effort) => ({
                id: effort.value,
                label: effort.label,
                ...(effort.description ? { description: effort.description } : {}),
                ...(effort.isDefault ? { isDefault: true } : {}),
              })),
              ...(metadata.reasoningEffort ? { currentValue: metadata.reasoningEffort } : {}),
            },
          ]
        : [],
  });
}

const GROK_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "grok-build",
    name: "Grok Build",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

function grokModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = GROK_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    builtInModels,
    PROVIDER,
    customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

function buildDiscoveredModels(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) return [];
  const seen = new Set<string>();
  return modelState.availableModels.flatMap((model) => {
    const slug = resolveGrokAcpBaseModelId(model.modelId);
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities: buildGrokModelCapabilities(model),
      },
    ];
  });
}

export const buildInitialGrokProviderSnapshot = (
  settings: GrokSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = grokModelsFromSettings(settings.customModels);
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      runtimeCapabilities: { liveSteer: "unsupported", threadGoals: "supported" },
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Grok CLI availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Grok is disabled in Cafe Code settings.",
          },
    });
  });

export const makePendingGrokProvider = buildInitialGrokProviderSnapshot;

const runVersionProbe = (settings: GrokSettings, environment: NodeJS.ProcessEnv) => {
  const command = settings.binaryPath || "grok";
  return spawnAndCollect(
    command,
    ChildProcess.make(command, ["--version"], {
      env: environment,
      extendEnv: true,
      shell: false,
    }),
  );
};

const discoverViaAcp = (
  settings: GrokSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  checkedAt: string,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makeGrokAcpRuntime({
      grokSettings: settings,
      environment,
      childProcessSpawner,
      cwd,
      sandboxProfile: GrokSandboxProfile.ReadOnly,
      clientInfo: { name: "cafe-code-provider-probe", version: "0.0.0" },
    });
    const eventFiber = yield* runtime.getEvents().pipe(
      Stream.runForEach((event) =>
        event._tag === "EventStreamBarrier"
          ? Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid)
          : Effect.void,
      ),
      Effect.forkScoped,
    );
    const started = yield* runtime.start();
    const [liveSteer, accountRateLimits] = yield* Effect.all(
      [
        runtime
          .request("x.ai/interject", {
            sessionId: "cafe-code-capability-probe-no-session",
            text: "",
            interjectionId: "cafe-code-capability-probe",
          })
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              error instanceof EffectAcpErrors.AcpRequestError
                ? Effect.succeed(error.code !== -32601)
                : Effect.fail(error),
            ),
          ),
        // Grok upstream routes this extension in newer builds, while stable
        // 1.0.4 returns -32601 from agent stdio. Feature-detect it before the
        // auth-file/CLI-proxy fallback so Cafe automatically moves back onto
        // the provider-owned protocol as soon as the installed CLI exposes it.
        runtime.request("x.ai/billing", {}).pipe(
          Effect.map((payload) => parseGrokAccountRateLimitsPayload(payload, checkedAt)),
          Effect.catch(() => Effect.succeed(undefined)),
        ),
      ],
      { concurrency: "unbounded" },
    );
    yield* runtime.drainEvents;
    yield* Fiber.interrupt(eventFiber);
    return {
      models: buildDiscoveredModels(started.sessionSetupResult.models),
      liveSteer,
      slashCommands: grokSlashCommandsFromAcp(yield* runtime.getAvailableCommands),
      ...(accountRateLimits ? { accountRateLimits } : {}),
    };
  }).pipe(Effect.scoped);

function causeTag(cause: Cause.Cause<unknown>): string {
  const reason = cause.reasons[0];
  if (reason === undefined) return "Unknown";
  if (Cause.isFailReason(reason)) {
    const error = reason.error;
    return typeof error === "object" && error !== null && "_tag" in error
      ? String(error._tag)
      : "Failure";
  }
  return Cause.isDieReason(reason) ? "Die" : "Interrupt";
}

export const checkGrokProviderStatus = Effect.fn("checkGrokProviderStatus")(function* (
  settings: GrokSettings,
  cwd: string = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = grokModelsFromSettings(settings.customModels);
  const build = (
    probe: Parameters<typeof buildServerProvider>[0]["probe"],
    models = fallbackModels,
    liveSteer = false,
    slashCommands: ReadonlyArray<ServerProviderSlashCommand> = [],
    skills: ReadonlyArray<ServerProviderSkill> = [],
  ) =>
    buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      slashCommands,
      skills,
      runtimeCapabilities: {
        liveSteer: liveSteer ? "supported" : "unsupported",
        threadGoals: "supported",
      },
      probe,
    });

  if (!settings.enabled) {
    return build({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Grok is disabled in Cafe Code settings.",
    });
  }

  const versionExit = yield* runVersionProbe(settings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(versionExit)) {
    const squashed = Cause.squash(versionExit.cause);
    const message = squashed instanceof Error ? squashed.message : String(squashed);
    yield* Effect.logWarning("Grok CLI health check failed.", {
      errorTag: causeTag(versionExit.cause),
    });
    return build({
      installed: !isCommandMissingCause({ message }),
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: isCommandMissingCause({ message })
        ? "Grok CLI (`grok`) is not installed or not on PATH."
        : "Failed to execute Grok CLI health check.",
    });
  }
  if (Option.isNone(versionExit.value)) {
    return build({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "Grok CLI timed out while running `grok --version`.",
    });
  }

  const versionResult = versionExit.value.value;
  const version = parseGenericCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (versionResult.code !== 0) {
    yield* Effect.logWarning("Grok CLI version probe exited with a non-zero status.", {
      exitCode: versionResult.code,
      stdoutLength: versionResult.stdout.length,
      stderrLength: versionResult.stderr.length,
    });
    return build({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Grok CLI is installed but failed to run.",
    });
  }
  if (!version || compareSemverVersions(version, MINIMUM_GROK_VERSION) < 0) {
    return build({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: version
        ? `Grok v${version} is too old. Upgrade to v${MINIMUM_GROK_VERSION} or newer.`
        : `Unable to determine the Grok version. Cafe Code requires v${MINIMUM_GROK_VERSION} or newer.`,
    });
  }

  const acpExit = yield* discoverViaAcp(settings, cwd, environment, checkedAt).pipe(
    Effect.timeoutOption(GROK_ACP_PROBE_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(acpExit)) {
    const error = Cause.squash(acpExit.cause);
    const unauthenticated =
      error instanceof EffectAcpErrors.AcpRequestError && error.code === -32000;
    yield* Effect.logWarning("Grok ACP qualification probe failed.", {
      errorTag: causeTag(acpExit.cause),
      unauthenticated,
    });
    return build({
      installed: true,
      version,
      status: unauthenticated ? "warning" : "error",
      auth: { status: unauthenticated ? "unauthenticated" : "unknown" },
      message: unauthenticated
        ? "Grok Build is not authenticated. Run `grok login` in a terminal."
        : "Grok CLI is installed but ACP startup failed. Check server logs for details.",
    });
  }
  if (Option.isNone(acpExit.value)) {
    return build({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: `Grok CLI is installed but ACP startup timed out after ${GROK_ACP_PROBE_TIMEOUT_MS}ms.`,
    });
  }

  const discovered = acpExit.value.value;
  const skills = yield* discoverGrokSkills(settings, cwd, environment).pipe(
    Effect.timeoutOption(GROK_INSPECT_TIMEOUT_MS),
    Effect.map(Option.getOrElse(() => [] as ReadonlyArray<ServerProviderSkill>)),
    Effect.catch(() => Effect.succeed([] as ReadonlyArray<ServerProviderSkill>)),
  );
  return build(
    {
      installed: true,
      version,
      status: "ready",
      auth: { status: "authenticated", type: "cached-token" },
      ...(discovered.accountRateLimits ? { accountRateLimits: discovered.accountRateLimits } : {}),
    },
    discovered.models.length > 0
      ? grokModelsFromSettings(settings.customModels, discovered.models)
      : fallbackModels,
    discovered.liveSteer,
    discovered.slashCommands,
    skills,
  );
});
