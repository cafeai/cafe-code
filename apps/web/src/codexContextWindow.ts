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
  return {
    requested,
    configured,
    pending: configured !== undefined && configured !== requested,
    source:
      override !== null
        ? "Chat override"
        : inherited !== null
          ? "Account default"
          : "Codex default",
  };
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
      : uiText(
          "Context override: {tokens}",
          {
            tokens: formatCodexContextWindowTokens(requested, locale),
          },
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
  return uiText(
    "Context override: {current} → {next} when idle",
    { current, next },
    undefined,
    locale,
  );
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
