import { type GrokSettings, ProviderDriverKind, type RuntimeMode } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@cafecode/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { makeXAiPromptCompletionRuntime } from "./XAiAcpExtension.ts";

const GROK_API_KEY_ENV = "XAI_API_KEY";
const GROK_OAUTH2_REFERRER_ENV = "GROK_OAUTH2_REFERRER";
const CAFE_CODE_OAUTH_REFERRER = "cafe-code";
const GROK_AUTH_METHOD_API_KEY = "xai.api_key";
const GROK_AUTH_METHOD_CACHED_TOKEN = "cached_token";
const GROK_DRIVER_KIND = ProviderDriverKind.make("grok");
const GROK_FALLBACK_REASONING_EFFORTS = ["xhigh", "high", "medium", "low"] as const;

export const GrokSandboxProfile = {
  ReadOnly: "read-only",
  Workspace: "workspace",
  Off: "off",
} as const;
export type GrokSandboxProfile = (typeof GrokSandboxProfile)[keyof typeof GrokSandboxProfile];

export const GrokPermissionMode = {
  Ask: "default",
  AcceptEdits: "acceptEdits",
  Auto: "auto",
  Plan: "plan",
  Bypass: "bypassPermissions",
} as const;
export type GrokPermissionMode = (typeof GrokPermissionMode)[keyof typeof GrokPermissionMode];

export interface GrokAcpReasoningEffortOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly isDefault: boolean;
}

export interface GrokAcpModelMetadata {
  readonly totalContextTokens?: number;
  readonly reasoningEffort?: string;
  readonly reasoningEfforts: ReadonlyArray<GrokAcpReasoningEffortOption>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function reasoningEffortLabel(value: string): string {
  switch (value) {
    case "xhigh":
      return "Extra High";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
    case "minimal":
      return "Minimal";
    case "none":
      return "None";
    default:
      return value;
  }
}

/**
 * Decode only the xAI model metadata Cafe has existing consumers for. The ACP
 * `_meta` extension is intentionally open-ended, so every field is validated
 * independently and malformed optional data simply stays unavailable.
 */
export function readGrokAcpModelMetadata(
  model: EffectAcpSchema.ModelInfo | null | undefined,
): GrokAcpModelMetadata {
  const meta = isRecord(model?._meta) ? model._meta : undefined;
  const totalContextTokensCandidate = meta?.totalContextTokens;
  const totalContextTokens =
    typeof totalContextTokensCandidate === "number" &&
    Number.isSafeInteger(totalContextTokensCandidate) &&
    totalContextTokensCandidate > 0
      ? totalContextTokensCandidate
      : undefined;
  const reasoningEffort = trimmedString(meta?.reasoningEffort);
  const supportsReasoningEffort = meta?.supportsReasoningEffort === true;
  const advertised = Array.isArray(meta?.reasoningEfforts) ? meta.reasoningEfforts : [];
  const seen = new Set<string>();
  const decoded = advertised.flatMap((candidate): ReadonlyArray<GrokAcpReasoningEffortOption> => {
    if (!isRecord(candidate)) return [];
    // Grok permits a presentation id to map to a canonical effort value. Cafe's
    // existing model-option value must be directly usable by the CLI, so retain
    // the canonical `value` rather than the presentation-only id.
    const value = trimmedString(candidate.value) ?? trimmedString(candidate.id);
    if (!value || seen.has(value)) return [];
    seen.add(value);
    const label = trimmedString(candidate.label) ?? reasoningEffortLabel(value);
    const description = trimmedString(candidate.description);
    return [
      {
        value,
        label,
        ...(description ? { description } : {}),
        isDefault: reasoningEffort ? value === reasoningEffort : candidate.default === true,
      },
    ];
  });
  const reasoningEfforts =
    supportsReasoningEffort && decoded.length === 0
      ? GROK_FALLBACK_REASONING_EFFORTS.map((value) => ({
          value,
          label: reasoningEffortLabel(value),
          isDefault: value === reasoningEffort,
        }))
      : supportsReasoningEffort
        ? decoded
        : [];

  return {
    ...(totalContextTokens ? { totalContextTokens } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    reasoningEfforts,
  };
}

export function readGrokAcpSessionModelMetadata(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
  modelId?: string,
): GrokAcpModelMetadata {
  const modelState = sessionSetupResult.models;
  const selectedModelId = modelId?.trim() || modelState?.currentModelId?.trim();
  const model = modelState?.availableModels.find(
    (candidate) => candidate.modelId === selectedModelId,
  );
  return readGrokAcpModelMetadata(model);
}

const GROK_SANDBOX_APPLY_FAILURE = "warning: sandbox could not be applied:";

/**
 * Only Cafe's bounded local stderr classifier constructs this subtype. Do not
 * recover it from provider JSON-RPC data: that boundary deliberately discards
 * arbitrary provider messages/data, which may include secrets or host paths.
 * Keeping a local type distinguishes an enforcement failure from an ACP or
 * login failure without copying any of the original diagnostic into a log.
 */
export class GrokSandboxStartupError extends EffectAcpErrors.AcpRequestError {
  readonly reason: "container-socket-symlink" | "sandbox-unavailable";

  constructor(
    profile: GrokSandboxProfile,
    reason: "container-socket-symlink" | "sandbox-unavailable",
  ) {
    super({
      code: -32603,
      errorMessage:
        reason === "container-socket-symlink"
          ? `Grok cannot start its ${profile} sandbox because a container-runtime socket is a symbolic link. Review the Docker/container socket configuration or use a Grok version that supports it. Cafe has not disabled sandbox protection.`
          : `Grok could not enforce its ${profile} sandbox. Check Grok's sandbox requirements for this machine. Cafe stopped startup instead of continuing without protection.`,
    });
    this.reason = reason;
  }
}

/**
 * Older Grok builds can warn and continue when the host OS cannot apply
 * Landlock or Seatbelt; newer builds can refuse startup after the warning.
 * Cafe treats read-only/workspace as a
 * security promise, so protected sessions fail closed on that upstream warning
 * while explicit full-access (`off`) remains unaffected. The returned error is
 * deliberately free of the raw stderr, which can contain host paths.
 */
export function classifyGrokSandboxStartupStderr(
  sandboxProfile: GrokSandboxProfile,
  boundedStderr: string,
): GrokSandboxStartupError | undefined {
  const normalized = boundedStderr.toLowerCase();
  if (
    sandboxProfile === GrokSandboxProfile.Off ||
    !normalized.includes(GROK_SANDBOX_APPLY_FAILURE)
  ) {
    return undefined;
  }
  // Grok 1.0.34 rejects symlink endpoints while resolving runtime-socket denies,
  // including Docker Desktop's optional default socket link on macOS. This is
  // an upstream security refusal, not failed authentication. Classify fixed
  // phrases only; never return the intervening path or suggest an off fallback.
  // Upstream: xai-org/grok-build at 482711333c7195dc16a272777f86086d615e2afb,
  // crates/codegen/xai-grok-sandbox/src/runtime_sockets.rs (endpoint validation).
  return new GrokSandboxStartupError(
    sandboxProfile,
    normalized.includes("runtime-socket deny path") && normalized.includes("endpoint is a symlink")
      ? "container-socket-symlink"
      : "sandbox-unavailable",
  );
}

/**
 * The ACP sandbox is the enforcement boundary for Cafe's runtime-mode policy.
 * Keep this mapping explicit so health probes and text-generation can choose a
 * deliberately stricter profile without weakening interactive sessions.
 */
export function grokSandboxProfileForRuntimeMode(
  runtimeMode: RuntimeMode,
  interactionMode: "default" | "plan" | "auto" = "default",
): GrokSandboxProfile {
  // Native Plan is also backed by Cafe's read-only sandbox, even when the
  // underlying access selection was broader before entering Plan.
  if (interactionMode === "plan") return GrokSandboxProfile.ReadOnly;
  switch (runtimeMode) {
    case "approval-required":
      return GrokSandboxProfile.ReadOnly;
    case "auto-accept-edits":
      return GrokSandboxProfile.Workspace;
    case "full-access":
      return GrokSandboxProfile.Off;
  }
}

/**
 * Pin the provider's prompt policy for every Cafe-owned process. Grok gives an
 * explicit CLI flag precedence over user config, which prevents a persisted
 * `always-approve` setting from silently weakening Cafe's supervised mode.
 * Provider deny/ask rules and managed policy remain authoritative even in
 * bypass mode, so any residual ACP permission request must still be surfaced.
 */
export function grokPermissionModeForRuntimeMode(
  runtimeMode: RuntimeMode,
  interactionMode: "default" | "plan" | "auto" = "default",
): GrokPermissionMode {
  if (interactionMode === "plan") return GrokPermissionMode.Plan;
  if (interactionMode === "auto") return GrokPermissionMode.Auto;
  switch (runtimeMode) {
    case "approval-required":
      return GrokPermissionMode.Ask;
    case "auto-accept-edits":
      return GrokPermissionMode.AcceptEdits;
    case "full-access":
      return GrokPermissionMode.Bypass;
  }
}

type GrokAcpRuntimeGrokSettings = Pick<GrokSettings, "binaryPath"> &
  Partial<Pick<GrokSettings, "homePath">>;

interface GrokAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly grokSettings: GrokAcpRuntimeGrokSettings | null | undefined;
  readonly sandboxProfile: GrokSandboxProfile;
  readonly permissionMode?: GrokPermissionMode;
  readonly reasoningEffort?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildGrokAcpSpawnInput(
  grokSettings: GrokAcpRuntimeGrokSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  sandboxProfile: GrokSandboxProfile = GrokSandboxProfile.ReadOnly,
  permissionMode: GrokPermissionMode = GrokPermissionMode.Ask,
  reasoningEffort?: string,
): AcpSessionRuntime.AcpSpawnInput {
  const homePath = grokSettings?.homePath?.trim();
  const selectedReasoningEffort = reasoningEffort?.trim();
  return {
    command: grokSettings?.binaryPath || "grok",
    // The global flags must precede the subcommand. --no-leader prevents
    // user configuration from handing Cafe's session to an unowned daemon.
    args: [
      "--no-auto-update",
      "--sandbox",
      sandboxProfile,
      "--permission-mode",
      permissionMode,
      ...(selectedReasoningEffort ? ["--reasoning-effort", selectedReasoningEffort] : []),
      "agent",
      "--no-leader",
      "stdio",
    ],
    cwd,
    env: {
      ...environment,
      [GROK_OAUTH2_REFERRER_ENV]: CAFE_CODE_OAUTH_REFERRER,
      ...(homePath ? { GROK_HOME: homePath } : {}),
    },
  };
}

function advertisedDefaultAuthMethodId(
  methods: ReadonlyArray<EffectAcpSchema.AuthMethod>,
): string | undefined {
  return methods.find((method) => {
    if ("type" in method && method.type === "terminal") return false;
    const meta = method._meta;
    return (
      meta !== null &&
      typeof meta === "object" &&
      (meta.default === true || meta.isDefault === true || meta.preferred === true)
    );
  })?.id;
}

export function resolveGrokAuthMethodId(
  initializeResult: EffectAcpSchema.InitializeResponse,
  environment: NodeJS.ProcessEnv | undefined,
): Effect.Effect<string, EffectAcpErrors.AcpError> {
  const methods = initializeResult.authMethods ?? [];
  const advertised = new Set(methods.map((method) => method.id));
  if (environment?.[GROK_API_KEY_ENV]?.trim() && advertised.has(GROK_AUTH_METHOD_API_KEY)) {
    return Effect.succeed(GROK_AUTH_METHOD_API_KEY);
  }
  const preferred = advertisedDefaultAuthMethodId(methods);
  if (preferred) return Effect.succeed(preferred);
  if (advertised.has(GROK_AUTH_METHOD_CACHED_TOKEN)) {
    return Effect.succeed(GROK_AUTH_METHOD_CACHED_TOKEN);
  }
  return Effect.fail(
    EffectAcpErrors.AcpRequestError.authRequired(
      "Grok Build is not authenticated. Run `grok login` in a terminal, or configure XAI_API_KEY in this provider instance.",
    ),
  );
}

export const makeGrokAcpRuntime = (
  input: GrokAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGrokAcpSpawnInput(
          input.grokSettings,
          input.cwd,
          input.environment,
          input.sandboxProfile,
          input.permissionMode,
          input.reasoningEffort,
        ),
        authMethodId: (initializeResult) =>
          resolveGrokAuthMethodId(initializeResult, input.environment),
        ...(input.sandboxProfile === GrokSandboxProfile.Off
          ? {}
          : {
              classifyStartupStderr: (boundedStderr: string) =>
                classifyGrokSandboxStartupStderr(input.sandboxProfile, boundedStderr),
            }),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
    return yield* makeXAiPromptCompletionRuntime(runtime);
  });

export function resolveGrokAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "grok-build";
  return normalizeModelSlug(base, GROK_DRIVER_KIND) ?? "grok-build";
}

export function currentGrokModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyGrokAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}
