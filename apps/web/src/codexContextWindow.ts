import { uiText, type UiLocale } from "@cafecode/shared/i18n";
import {
  validCodexContextWindowOverride,
  type ServerSettings,
  type ProviderInstanceId,
} from "@cafecode/contracts";

/** Saved chat intent and independently recorded configuration are never capacity evidence. */
export interface CodexContextWindowPresentation {
  readonly requested: number | null;
  readonly configured: number | null | undefined;
  readonly pending: boolean;
  readonly source: "Chat override" | "Account default" | "Codex default";
  /** Exact selected account's saved request, never a resolved native threshold. */
  readonly requestedAutoCompactTokenLimit?: number;
  /** Actual nominal request recorded at native opening, not the resolved threshold.
   * Null positively records omission; absence remains legacy/unknown evidence. */
  readonly configuredAutoCompactTokenLimit?: number | null;
  /** The same context number does not prove the companion policy was sent. */
  readonly pendingCompaction: boolean;
  /** Advisory exact-owner capability only, never authority to replace a process. */
  readonly canApplyWhenIdle: boolean;
}

/** Only the exact enabled Codex account may supply a live inherited numeric preference. */
export function inheritedCodexContextWindowOverride(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
  provider: string,
): number | undefined {
  const instance = settings.providerInstances?.[instanceId];
  if (
    provider !== "codex" ||
    !instance ||
    instance.driver !== "codex" ||
    instance.enabled === false
  )
    return undefined;
  const value = instance.defaultCodexContextWindowOverride;
  return typeof value === "number" && validCodexContextWindowOverride(value) ? value : undefined;
}

/** Driver config is opaque at the envelope boundary. Read only an own numeric
 * data property from the exact enabled Codex account, never a sibling/global
 * default or an accessor with side effects. This helper has no launch authority. */
export function requestedCodexAutoCompactTokenLimit(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
  provider: string,
): number | undefined {
  const instances = settings.providerInstances;
  if (provider !== "codex" || !instances || !Object.hasOwn(instances, instanceId)) return undefined;
  const instance = instances[instanceId];
  if (!instance || instance.driver !== "codex" || instance.enabled === false) return undefined;
  const config = instance.config;
  if (config === null || typeof config !== "object" || Array.isArray(config)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(config, "autoCompactTokenLimit");
  const value: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
  return typeof value === "number" && validCodexContextWindowOverride(value) ? value : undefined;
}

export function codexContextWindowSourceLabel(source: CodexContextWindowPresentation["source"]) {
  switch (source) {
    case "Chat override":
      return uiText("Chat override");
    case "Account default":
      return uiText("Account default");
    case "Codex default":
      return uiText("Codex default");
  }
}

export function deriveCodexContextWindowPresentation(input: {
  readonly requested: number | null | undefined;
  readonly configured: number | null | undefined;
  readonly inherited?: number | undefined;
  readonly requestedAutoCompactTokenLimit?: number | undefined;
  readonly configuredAutoCompactTokenLimit?: number | null | undefined;
  readonly canApplyWhenIdle?: boolean | undefined;
}): CodexContextWindowPresentation {
  const override =
    typeof input.requested === "number" && validCodexContextWindowOverride(input.requested)
      ? input.requested
      : null;
  const inherited =
    typeof input.inherited === "number" && validCodexContextWindowOverride(input.inherited)
      ? input.inherited
      : null;
  const requested = override ?? inherited;
  const configured =
    input.configured === null
      ? null
      : typeof input.configured === "number" && validCodexContextWindowOverride(input.configured)
        ? input.configured
        : undefined;
  const requestedAutoCompactTokenLimit =
    typeof input.requestedAutoCompactTokenLimit === "number" &&
    validCodexContextWindowOverride(input.requestedAutoCompactTokenLimit)
      ? input.requestedAutoCompactTokenLimit
      : undefined;
  const configuredAutoCompactTokenLimit =
    input.configuredAutoCompactTokenLimit === null
      ? null
      : typeof input.configuredAutoCompactTokenLimit === "number" &&
          validCodexContextWindowOverride(input.configuredAutoCompactTokenLimit)
        ? input.configuredAutoCompactTokenLimit
        : undefined;
  // Compare nominal requests, not the derived 90% estimate or received usable
  // context meter. A legacy 800K context-only session must not look as though its
  // missing companion request had already adopted the saved compaction policy.
  const desiredAutoCompactTokenLimit = requestedAutoCompactTokenLimit ?? requested;
  const pendingCompaction =
    configured !== undefined &&
    (requested !== null || typeof configured === "number") &&
    desiredAutoCompactTokenLimit !== null &&
    desiredAutoCompactTokenLimit !== configuredAutoCompactTokenLimit;
  return {
    requested,
    configured,
    pending: configured !== undefined && (configured !== requested || pendingCompaction),
    pendingCompaction,
    canApplyWhenIdle: input.canApplyWhenIdle === true,
    source:
      override !== null
        ? "Chat override"
        : inherited !== null
          ? "Account default"
          : "Codex default",
    // Preserve legacy absent-key/null/current-to-saved semantics. This separate
    // request exists only when its exact account actually supplied a valid value.
    ...(requestedAutoCompactTokenLimit !== undefined ? { requestedAutoCompactTokenLimit } : {}),
    ...(configuredAutoCompactTokenLimit !== undefined ? { configuredAutoCompactTokenLimit } : {}),
  };
}

/** Presentation-only default-total-scope estimate from the reviewed immutable
 * native policy. Never write this ratio to config, usage, capabilities or saved
 * metadata: native model caps, accounting scope and buffers remain authoritative. */
export function estimateCodexContextCompactionThreshold(
  presentation: CodexContextWindowPresentation | null | undefined,
): number | null {
  const requested = presentation?.requested;
  if (typeof requested !== "number" || !validCodexContextWindowOverride(requested)) return null;
  // Integer arithmetic retains floor(9*n/10) even at the admitted safe-integer
  // boundary, without a floating-point product rounding across a token boundary.
  const ceiling = Number((BigInt(requested) * 9n) / 10n);
  const explicit = presentation?.requestedAutoCompactTokenLimit;
  return typeof explicit === "number" && validCodexContextWindowOverride(explicit)
    ? Math.min(ceiling, explicit)
    : ceiling;
}

export function formatCodexContextCompactionEstimate(
  presentation: CodexContextWindowPresentation | null | undefined,
  locale: UiLocale,
): string | null {
  const estimate = estimateCodexContextCompactionThreshold(presentation);
  return estimate === null
    ? null
    : uiText(
        "(~{tokens} compaction)",
        { tokens: formatCodexContextWindowTokens(estimate, locale) },
        undefined,
        locale,
      );
}

/** Compact numbers follow the viewer's language; raw requested counts stay exact in the editor. */
export function formatCodexContextWindowTokens(value: number, locale: UiLocale): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

export function formatCodexContextWindowOverride(
  presentation: CodexContextWindowPresentation | null | undefined,
  locale: UiLocale,
): string | null {
  if (!presentation) return null;
  const { configured, requested } = presentation;
  if (configured === undefined) {
    return requested === null
      ? null
      : uiText(
          "Context override: {tokens} · saved",
          {
            tokens: formatCodexContextWindowTokens(requested, locale),
          },
          undefined,
          locale,
        );
  }
  if (configured === requested) {
    return requested === null
      ? null
      : presentation.pendingCompaction
        ? presentation.canApplyWhenIdle
          ? uiText(
              "Context override: {tokens} · compaction when idle",
              { tokens: formatCodexContextWindowTokens(requested, locale) },
              undefined,
              locale,
            )
          : uiText(
              "Context override: {tokens} · saved",
              { tokens: formatCodexContextWindowTokens(requested, locale) },
              undefined,
              locale,
            )
        : uiText(
            "Context override: {tokens}",
            { tokens: formatCodexContextWindowTokens(requested, locale) },
            undefined,
            locale,
          );
  }
  const current =
    configured === null
      ? uiText("Codex default", undefined, undefined, locale)
      : formatCodexContextWindowTokens(configured, locale);
  const next =
    requested === null
      ? uiText("Codex default", undefined, undefined, locale)
      : formatCodexContextWindowTokens(requested, locale);
  return presentation.canApplyWhenIdle
    ? uiText("Context override: {current} → {next} when idle", { current, next }, undefined, locale)
    : uiText("Context override: {current} → {next} · saved", { current, next }, undefined, locale);
}

/** An injective tuple prevents a reused pane from carrying an edit into another target/model. */
export function buildCodexContextWindowEditorKey(input: {
  readonly environmentId: string;
  readonly threadId: string | null;
  readonly draftId: string | null | undefined;
  readonly instanceId: string;
  readonly model: string;
  readonly isServerThread: boolean;
}): string {
  return JSON.stringify([
    input.environmentId,
    input.threadId,
    input.draftId ?? null,
    input.instanceId,
    input.model,
    input.isServerThread,
  ]);
}
