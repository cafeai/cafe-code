import { ProviderTurnConfiguration, type RuntimeMode } from "@cafecode/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  CLAUDE_PERMISSION_MODE_OPTIONS,
  deriveClaudePermissionMode,
  GROK_PERMISSION_MODE_OPTIONS,
} from "./components/chat/claudePermissionMode";

/** Access names shared with the composer's access control. */
const RUNTIME_MODE_LABELS: Readonly<Record<RuntimeMode, string>> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  "full-access": "Full access",
};

/**
 * Claude and Grok present one native permission mode (Ask permissions,
 * Accept edits, Plan, Auto, Bypass permissions) rather than Cafe's
 * interaction/access pair. Reuse the composer's own mapping so the work log
 * names the mode exactly as it was selected. An omitted interaction mode
 * (provider default) is ambiguous, so it keeps the generic pair.
 */
function nativePermissionModeLabel(configuration: ProviderTurnConfiguration): string | null {
  if (configuration.interactionMode === undefined) return null;
  const options =
    configuration.provider === "claudeAgent"
      ? CLAUDE_PERMISSION_MODE_OPTIONS
      : configuration.provider === "grok"
        ? GROK_PERMISSION_MODE_OPTIONS
        : null;
  if (options === null) return null;
  const mode = deriveClaudePermissionMode({
    interactionMode: configuration.interactionMode,
    runtimeMode: configuration.runtimeMode,
  });
  return options.find((option) => option.id === mode)?.label ?? null;
}

const decodeTurnConfiguration = Schema.decodeUnknownOption(ProviderTurnConfiguration);

/**
 * Read only the durable, server-authored snapshot. Looking up today's provider
 * catalog or composer selection here would silently rewrite an old turn after
 * an account rename, a model switch, or a settings change. Schema decoding also
 * rejects oversized/control-bearing labels before they reach the compact row.
 */
export function readTurnConfiguration(payload: unknown): ProviderTurnConfiguration | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const decoded = decodeTurnConfiguration((payload as Record<string, unknown>).turnConfiguration);
  return Option.isSome(decoded) ? decoded.value : undefined;
}

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

function presentServiceTier(tier: string): string {
  switch (tier) {
    case "default":
      return "Fast off · Service tier: Standard";
    case "priority":
    case "fast":
      return "Fast on · Service tier: Fast";
    case "ultrafast":
      return "Fast on · Service tier: Ultra fast";
    default:
      // Future native ids stay exact; their speed/cost semantics are unknown.
      return `Service tier: ${tier}`;
  }
}

/** Compact Fast label for the one-line work-log summary; the exact tier moves
 * to the row's tooltip. Unknown future tiers stay exact because their
 * speed/cost semantics are not known to Cafe. */
function presentCompactServiceTier(tier: string): string {
  switch (tier) {
    case "default":
      return "Fast off";
    case "priority":
    case "fast":
      return "Fast on";
    case "ultrafast":
      return "Ultra fast";
    default:
      return `Service tier: ${tier}`;
  }
}

/** Known native tier names for the tooltip; unknown ids are already exact on the line. */
function knownServiceTierName(tier: string): string | null {
  switch (tier) {
    case "default":
      return "Standard";
    case "priority":
    case "fast":
      return "Fast";
    case "ultrafast":
      return "Ultra fast";
    default:
      return null;
  }
}

/**
 * Ultracode is a separately submitted workflow setting, not an effort alias.
 * Older snapshots never imply Off or a successful native activation: only an
 * explicitly captured request is shown, while the existing source caveat keeps
 * provider execution and billing confirmation distinct.
 */
function requestedUltracodeLabel(configuration: ProviderTurnConfiguration): string | undefined {
  return configuration.provider === "claudeAgent" && configuration.ultracode !== undefined
    ? configuration.ultracode
      ? "Ultracode requested on"
      : "Ultracode requested off"
    : undefined;
}

/**
 * One-line work-log summary of the frozen snapshot, e.g.
 * "GPT-6.1 Sol · Ultra · Fast on · Codex Personal · Build · Full access".
 * It keeps the exact configured account label, model, effort, Fast and mode
 * settings visible; the settings source, exact service tier and the
 * not-billing-confirmation caveat move to `detail` (shown in a tooltip).
 * Plain text only: these labels are never Markdown, HTML, or link targets.
 */
export function presentTurnConfigurationSummary(configuration: ProviderTurnConfiguration): {
  readonly summary: string;
  readonly detail: string;
} {
  const full = presentTurnConfiguration(configuration);
  const isOpenCode = configuration.provider === "opencode";
  const model = configuration.modelDisplayName ?? configuration.model ?? "Default model";
  const effort =
    configuration.effort === undefined
      ? isOpenCode
        ? "Default variant"
        : "Default effort"
      : Object.hasOwn(EFFORT_LABELS, configuration.effort)
        ? EFFORT_LABELS[configuration.effort]!
        : configuration.effort;
  const routedTier =
    configuration.provider === "codex"
      ? (configuration.resolvedServiceTier ?? configuration.serviceTier)
      : undefined;
  const fast =
    routedTier !== undefined
      ? presentCompactServiceTier(routedTier)
      : configuration.provider === "codex" || configuration.provider === "claudeAgent"
        ? configuration.fastMode === undefined
          ? "Fast status not recorded"
          : configuration.fastMode
            ? "Fast on"
            : "Fast off"
        : undefined;
  const interactionMode =
    configuration.interactionMode === undefined
      ? "Default mode"
      : { default: "Build", plan: "Plan", auto: "Auto" }[configuration.interactionMode];
  const nativeMode = nativePermissionModeLabel(configuration);
  const modes = nativeMode
    ? [nativeMode]
    : [interactionMode, RUNTIME_MODE_LABELS[configuration.runtimeMode]];
  const tierName = routedTier === undefined ? null : knownServiceTierName(routedTier);
  const tierDetail = tierName ? ` · Service tier: ${tierName}` : "";
  return {
    summary: [
      model,
      effort,
      requestedUltracodeLabel(configuration),
      fast,
      // The configured instance label, never an auth email or account id.
      configuration.providerDisplayName,
      ...modes,
    ]
      .filter((value) => value !== undefined)
      .join(" · "),
    detail: `${full.source}${tierDetail}. ${full.sourceDescription}`,
  };
}

/** Plain text only: these labels are never Markdown, HTML, or link targets. */
export function presentTurnConfiguration(configuration: ProviderTurnConfiguration): {
  readonly settings: string;
  readonly account: string;
  readonly modes: string;
  readonly source: string;
  readonly sourceDescription: string;
} {
  const model = configuration.modelDisplayName ?? configuration.model ?? "Model: provider default";
  const effort =
    configuration.effort === undefined
      ? `${configuration.provider === "opencode" ? "Variant" : "Effort"}: provider default`
      : `${configuration.provider === "opencode" ? "Variant" : "Effort"}: ${
          Object.hasOwn(EFFORT_LABELS, configuration.effort)
            ? EFFORT_LABELS[configuration.effort]
            : configuration.effort
        }`;
  // Prefer routing captured from the exact native start over submitted options.
  // Old snapshots stay unknown rather than borrowing today's session settings.
  const fast =
    configuration.provider === "codex" &&
    (configuration.resolvedServiceTier ?? configuration.serviceTier) !== undefined
      ? presentServiceTier((configuration.resolvedServiceTier ?? configuration.serviceTier)!)
      : configuration.provider === "codex" || configuration.provider === "claudeAgent"
        ? configuration.fastMode === undefined
          ? "Fast status not recorded"
          : configuration.fastMode
            ? "Fast on"
            : "Fast off"
        : undefined;
  const runtimeMode = RUNTIME_MODE_LABELS[configuration.runtimeMode];
  const interactionMode =
    configuration.interactionMode === undefined
      ? "Mode: provider default"
      : { default: "Build", plan: "Plan", auto: "Auto" }[configuration.interactionMode];
  return {
    settings: [model, effort, requestedUltracodeLabel(configuration), fast]
      .filter((value) => value !== undefined)
      .join(" · "),
    // This is the configured instance label, deliberately not an auth email,
    // account identifier, token, or a fresh read of the provider's credentials.
    account: `Account: ${configuration.providerDisplayName}`,
    modes: `${interactionMode} · ${runtimeMode}`,
    source:
      configuration.settingsSource === "submitted"
        ? "Submitted settings"
        : "Existing session settings",
    sourceDescription:
      (configuration.settingsSource === "submitted"
        ? "Settings Cafe submitted for this accepted turn. Provider defaults may be inherited; this is not independent execution or billing confirmation."
        : "Settings of the existing session that accepted this input. Provider defaults may be inherited; this is not independent execution or billing confirmation.") +
      (configuration.provider === "codex" && configuration.resolvedServiceTier !== undefined
        ? " Fast mode uses the native session routing captured for this turn."
        : ""),
  };
}
