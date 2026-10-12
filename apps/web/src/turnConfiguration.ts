import { uiText } from "@cafecode/shared/i18n";
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
  get "approval-required"() {
    return uiText("Supervised");
  },
  get "auto-accept-edits"() {
    return uiText("Auto-accept edits");
  },
  get "full-access"() {
    return uiText("Full access");
  },
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
  get none() {
    return uiText("None");
  },
  get minimal() {
    return uiText("Minimal");
  },
  get low() {
    return uiText("Low");
  },
  get medium() {
    return uiText("Medium");
  },
  get high() {
    return uiText("High");
  },
  get xhigh() {
    return uiText("Extra high");
  },
  get max() {
    return uiText("Max");
  },
  get ultra() {
    return uiText("Ultra");
  },
};

function presentServiceTier(tier: string): string {
  switch (tier) {
    case "default":
      return uiText("Fast off · Service tier: Standard");
    case "priority":
    case "fast":
      return uiText("Fast on · Service tier: Fast");
    case "ultrafast":
      return uiText("Fast on · Service tier: Ultra fast");
    default:
      // Future native ids stay exact; their speed/cost semantics are unknown.
      return uiText("Service tier: {tier}", { tier });
  }
}

/** Compact Fast label for the one-line work-log summary; the exact tier moves
 * to the row's tooltip. Unknown future tiers stay exact because their
 * speed/cost semantics are not known to Cafe. */
function presentCompactServiceTier(tier: string): string {
  switch (tier) {
    case "default":
      return uiText("Fast off");
    case "priority":
    case "fast":
      return uiText("Fast on");
    case "ultrafast":
      return uiText("Ultra fast");
    default:
      return uiText("Service tier: {tier}", { tier });
  }
}

/** Known native tier names for the tooltip; unknown ids are already exact on the line. */
function knownServiceTierName(tier: string): string | null {
  switch (tier) {
    case "default":
      return uiText("Standard");
    case "priority":
    case "fast":
      return uiText("Fast");
    case "ultrafast":
      return uiText("Ultra fast");
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
      ? uiText("Ultracode requested on")
      : uiText("Ultracode requested off")
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
  const model = configuration.modelDisplayName ?? configuration.model ?? uiText("Default model");
  const effort =
    configuration.effort === undefined
      ? isOpenCode
        ? uiText("Default variant")
        : uiText("Default effort")
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
          ? uiText("Fast status not recorded")
          : configuration.fastMode
            ? uiText("Fast on")
            : uiText("Fast off")
        : undefined;
  const interactionMode =
    configuration.interactionMode === undefined
      ? uiText("Default mode")
      : { default: uiText("Build"), plan: uiText("Plan"), auto: uiText("Auto") }[
          configuration.interactionMode
        ];
  const nativeMode = nativePermissionModeLabel(configuration);
  const modes = nativeMode
    ? [nativeMode]
    : [interactionMode, RUNTIME_MODE_LABELS[configuration.runtimeMode]];
  const tierName = routedTier === undefined ? null : knownServiceTierName(routedTier);
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
    detail: uiText(
      "{source}{tier, select, absent {} other { · Service tier: {tierName}}}. {description}",
      {
        source: full.source,
        tier: tierName === null ? "absent" : "present",
        tierName: tierName ?? "",
        description: full.sourceDescription,
      },
    ),
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
  const model =
    configuration.modelDisplayName ?? configuration.model ?? uiText("Model: provider default");
  const effort =
    configuration.effort === undefined
      ? uiText("{provider, select, opencode {Variant} other {Effort}}: provider default", {
          provider: configuration.provider,
        })
      : uiText("{provider, select, opencode {Variant} other {Effort}}: {effort}", {
          provider: configuration.provider,
          effort: Object.hasOwn(EFFORT_LABELS, configuration.effort)
            ? EFFORT_LABELS[configuration.effort]
            : configuration.effort,
        });
  // Prefer routing captured from the exact native start over submitted options.
  // Old snapshots stay unknown rather than borrowing today's session settings.
  const fast =
    configuration.provider === "codex" &&
    (configuration.resolvedServiceTier ?? configuration.serviceTier) !== undefined
      ? presentServiceTier((configuration.resolvedServiceTier ?? configuration.serviceTier)!)
      : configuration.provider === "codex" || configuration.provider === "claudeAgent"
        ? configuration.fastMode === undefined
          ? uiText("Fast status not recorded")
          : configuration.fastMode
            ? uiText("Fast on")
            : uiText("Fast off")
        : undefined;
  const runtimeMode = RUNTIME_MODE_LABELS[configuration.runtimeMode];
  const interactionMode =
    configuration.interactionMode === undefined
      ? uiText("Mode: provider default")
      : { default: uiText("Build"), plan: uiText("Plan"), auto: uiText("Auto") }[
          configuration.interactionMode
        ];
  return {
    settings: [model, effort, requestedUltracodeLabel(configuration), fast]
      .filter((value) => value !== undefined)
      .join(" · "),
    // This is the configured instance label, deliberately not an auth email,
    // account identifier, token, or a fresh read of the provider's credentials.
    account: uiText("Account: {account}", { account: configuration.providerDisplayName }),
    modes: uiText("{interactionMode} · {runtimeMode}", { interactionMode, runtimeMode }),
    source:
      configuration.settingsSource === "submitted"
        ? uiText("Submitted settings")
        : uiText("Existing session settings"),
    sourceDescription: uiText(
      "{source, select, submitted {Settings Cafe submitted for this accepted turn.} other {Settings of the existing session that accepted this input.}} Provider defaults may be inherited; this is not independent execution or billing confirmation.{nativeFast, select, yes { Fast mode uses the native session routing captured for this turn.} other {}}",
      {
        source: configuration.settingsSource,
        nativeFast:
          configuration.provider === "codex" && configuration.resolvedServiceTier !== undefined
            ? "yes"
            : "no",
      },
    ),
  };
}
