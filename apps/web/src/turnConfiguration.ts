import { ProviderTurnConfiguration } from "@cafecode/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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
  // Absence is not false. An inherited provider preference may enable Fast, so
  // the row must not claim Normal/Fast off without an explicit frozen value.
  const fast =
    configuration.provider === "codex" && configuration.serviceTier !== undefined
      ? `Service tier: ${configuration.serviceTier === "default" ? "Standard" : configuration.serviceTier}`
      : configuration.provider === "codex" || configuration.provider === "claudeAgent"
        ? configuration.fastMode === undefined
          ? "Fast: provider default"
          : configuration.fastMode
            ? "Fast on"
            : "Fast off"
        : undefined;
  const runtimeMode = {
    "approval-required": "Approval required",
    "auto-accept-edits": "Auto-accept edits",
    "full-access": "Full access",
  }[configuration.runtimeMode];
  const interactionMode =
    configuration.interactionMode === undefined
      ? "Mode: provider default"
      : { default: "Build", plan: "Plan", auto: "Auto" }[configuration.interactionMode];
  return {
    settings: [model, effort, fast].filter((value) => value !== undefined).join(" · "),
    // This is the configured instance label, deliberately not an auth email,
    // account identifier, token, or a fresh read of the provider's credentials.
    account: `Account: ${configuration.providerDisplayName}`,
    modes: `${interactionMode} · ${runtimeMode}`,
    source:
      configuration.settingsSource === "submitted"
        ? "Submitted settings"
        : "Existing session settings",
    sourceDescription:
      configuration.settingsSource === "submitted"
        ? "Settings Cafe submitted for this accepted turn. Provider defaults may be inherited; this is not independent execution or billing confirmation."
        : "Settings of the existing session that accepted this input. Provider defaults may be inherited; this is not independent execution or billing confirmation.",
  };
}
