import { useUiLocale, useUiPresentation } from "~/i18n";
("use client");

import { uiText, type UiLocale } from "@cafecode/shared/i18n";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EyeIcon,
  EyeOffIcon,
  PlusIcon,
  StarIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@cafecode/contracts";
import { normalizeModelSlug } from "@cafecode/shared/model";

import { cn } from "../../lib/utils";
import { sortModelsForProviderInstance } from "../../modelOrdering";
import { MAX_CUSTOM_MODEL_LENGTH } from "../../modelSelection";
import { Button } from "../ui/button";
import { InfoTip } from "../ui/info-tip";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Placeholder text for the "add a custom model" input, keyed by driver
 * kind. Mirrors the prior hardcoded switch in `SettingsPanels.tsx` so the
 * UX is unchanged — only the owning component has moved.
 */
const CUSTOM_MODEL_PLACEHOLDER_BY_KIND: Partial<Record<ProviderDriverKind, string>> = {
  get [ProviderDriverKind.make("codex")]() {
    return uiText("gpt-6.7-codex-ultra-preview");
  },
  get [ProviderDriverKind.make("claudeAgent")]() {
    return uiText("claude-sonnet-5");
  },
};

type ModelValidationCode = "empty" | "built-in" | "too-long" | "saved";

/** Validation provenance is finite; slugs remain canonical, untranslated data. */
function formatModelValidation(code: ModelValidationCode, locale: UiLocale): string {
  switch (code) {
    case "empty":
      return uiText("Enter a model slug.", undefined, undefined, locale);
    case "built-in":
      return uiText("That model is already built in.", undefined, undefined, locale);
    case "too-long":
      return uiText(
        "Model slugs must be {value0} characters or less.",
        { value0: MAX_CUSTOM_MODEL_LENGTH },
        undefined,
        locale,
      );
    case "saved":
      return uiText("That custom model is already saved.", undefined, undefined, locale);
  }
}

interface ProviderModelsSectionProps {
  /** Identifier used to namespace input ids within the DOM. */
  readonly instanceId: ProviderInstanceId;
  /**
   * Driver kind for slug normalization + input placeholder. `null` when
   * the section is rendered without enough provider metadata.
   */
  readonly driverKind: ProviderDriverKind | null;
  /**
   * The live model list to display. Includes both built-in (probe-reported)
   * and custom entries, distinguished by `isCustom`.
   */
  readonly models: ReadonlyArray<ServerProviderModel>;
  /**
   * The persisted custom-model slug list for this instance. Drives dedup,
   * and is the array we hand back verbatim (with the new slug appended /
   * removed) via `onChange`.
   */
  readonly customModels: ReadonlyArray<string>;
  /** Server-returned model slugs hidden from the model picker. */
  readonly hiddenModels: ReadonlyArray<string>;
  /** Model slugs favorited for this provider instance. */
  readonly favoriteModels: ReadonlyArray<string>;
  /** Explicit user-authored model ordering for this provider instance. */
  readonly modelOrder: ReadonlyArray<string>;
  /**
   * Commit the new custom-model list. Caller is responsible for routing the
   * write to the correct storage (legacy `settings.providers[kind]` vs.
   * `providerInstances[id].config`).
   */
  readonly onChange: (next: ReadonlyArray<string>) => void;
  readonly onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
}

/**
 * Shared "Models" section rendered on both the built-in default and custom
 * provider-instance cards. Owns its own input + error local state so two
 * cards on screen don't fight over the input value.
 *
 * Validation mirrors the pre-consolidation logic in `SettingsPanels`:
 *   - empty / whitespace → "Enter a model slug."
 *   - duplicate of a non-custom (probe-reported) slug → "already built in"
 *   - exceeds `MAX_CUSTOM_MODEL_LENGTH` → length error
 *   - duplicate of an already-saved custom slug → already-saved error
 */
export function ProviderModelsSection({
  instanceId,
  driverKind,
  models,
  customModels,
  hiddenModels,
  favoriteModels,
  modelOrder,
  onChange,
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onModelOrderChange,
}: ProviderModelsSectionProps) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const [input, setInput] = useState("");
  const [errorCode, setErrorCode] = useState<ModelValidationCode | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const hiddenModelSet = useMemo(() => new Set(hiddenModels), [hiddenModels]);
  const favoriteModelSet = useMemo(() => new Set(favoriteModels), [favoriteModels]);
  const orderedModels = useMemo(() => {
    return sortModelsForProviderInstance(models, {
      favoriteModels: favoriteModelSet,
      groupFavorites: true,
      modelOrder,
    });
  }, [favoriteModelSet, modelOrder, models]);

  const handleAdd = () => {
    const normalized = driverKind ? normalizeModelSlug(input, driverKind) : input.trim() || null;
    if (!normalized) {
      setErrorCode("empty");
      return;
    }
    if (models.some((model) => !model.isCustom && model.slug === normalized)) {
      setErrorCode("built-in");
      return;
    }
    if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
      setErrorCode("too-long");
      return;
    }
    if (customModels.includes(normalized)) {
      setErrorCode("saved");
      return;
    }

    onChange([...customModels, normalized]);
    setInput("");
    setErrorCode(null);

    // Scroll the new row into view once the DOM reflects the commit.
    // `MutationObserver` handles the one-frame gap between `onChange` and
    // the `models` prop update; the `requestAnimationFrame` covers the
    // common case where the parent updates synchronously.
    const el = listRef.current;
    if (!el) return;
    const scrollToEnd = () => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    requestAnimationFrame(scrollToEnd);
    const observer = new MutationObserver(() => {
      scrollToEnd();
      observer.disconnect();
    });
    observer.observe(el, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 2_000);
  };

  const handleRemove = (slug: string) => {
    onChange(customModels.filter((model) => model !== slug));
    onModelOrderChange(modelOrder.filter((model) => model !== slug));
    onFavoriteModelsChange(favoriteModels.filter((model) => model !== slug));
    setErrorCode(null);
  };

  const handleToggleHidden = (slug: string) => {
    if (hiddenModelSet.has(slug)) {
      onHiddenModelsChange(hiddenModels.filter((model) => model !== slug));
      return;
    }
    onHiddenModelsChange([...hiddenModels, slug]);
  };

  const handleToggleFavorite = (slug: string) => {
    if (favoriteModelSet.has(slug)) {
      onFavoriteModelsChange(favoriteModels.filter((model) => model !== slug));
      return;
    }
    onFavoriteModelsChange([...favoriteModels, slug]);
  };

  const handleMove = (slug: string, direction: -1 | 1) => {
    const slugs = orderedModels.map((model) => model.slug);
    const index = slugs.indexOf(slug);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= slugs.length) {
      return;
    }
    const next = [...slugs];
    [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
    onModelOrderChange(next);
  };

  return (
    <div className="border-t border-border-subtle px-4 py-3 sm:px-5">
      <div className="flex items-baseline gap-1.5 text-xs">
        <span className="font-medium text-foreground">
          {uiText("Models", undefined, undefined, uiLocale)}
        </span>
        <span className="text-subtle-foreground tabular-nums">{models.length}</span>
      </div>
      <div ref={listRef} className="mt-2 max-h-40 overflow-y-auto pb-1">
        {orderedModels.map((model, index) => {
          const caps = model.capabilities;
          const capLabels: string[] = [];
          const isHidden = !model.isCustom && hiddenModelSet.has(model.slug);
          const isFavorite = favoriteModelSet.has(model.slug);
          const previousModel = orderedModels[index - 1];
          const nextModel = orderedModels[index + 1];
          const canMoveUp =
            previousModel !== undefined && favoriteModelSet.has(previousModel.slug) === isFavorite;
          const canMoveDown =
            nextModel !== undefined && favoriteModelSet.has(nextModel.slug) === isFavorite;
          const descriptors = caps?.optionDescriptors ?? [];
          if (descriptors.some((descriptor) => descriptor.id === "fastMode")) {
            capLabels.push(uiText("Fast mode", undefined, undefined, uiLocale));
          }
          if (descriptors.some((descriptor) => descriptor.id === "thinking")) {
            capLabels.push(uiText("Thinking", undefined, undefined, uiLocale));
          }
          if (
            descriptors.some(
              (descriptor) =>
                descriptor.type === "select" &&
                (descriptor.id === "reasoningEffort" ||
                  descriptor.id === "effort" ||
                  descriptor.id === "reasoning" ||
                  descriptor.id === "variant"),
            )
          ) {
            capLabels.push(uiText("Reasoning", undefined, undefined, uiLocale));
          }
          const hasDetails = capLabels.length > 0 || model.name !== model.slug;

          return (
            <div
              key={`${instanceId}:${model.slug}`}
              className={cn(
                "grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-1",
                isHidden && "text-muted-foreground",
              )}
            >
              <div className="flex min-w-0 items-center gap-1">
                <span
                  className={cn(
                    "min-w-0 truncate text-xs",
                    isHidden ? "text-muted-foreground line-through" : "text-foreground",
                  )}
                >
                  {model.name}
                </span>
                {hasDetails ? (
                  <InfoTip
                    label={uiText(
                      "Details for {value0}",
                      { value0: model.name },
                      undefined,
                      uiLocale,
                    )}
                    popupClassName="max-w-56"
                  >
                    <span className="grid gap-1">
                      <code className="block font-mono text-2xs text-foreground">{model.slug}</code>
                      {capLabels.length > 0 ? (
                        <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
                          {capLabels.map((label) => (
                            <span key={label}>{label}</span>
                          ))}
                        </span>
                      ) : null}
                    </span>
                  </InfoTip>
                ) : null}
                {isHidden ? (
                  <span className="text-2xs text-subtle-foreground">
                    {uiText("hidden", undefined, undefined, uiLocale)}
                  </span>
                ) : null}
                {model.isCustom ? (
                  <span className="text-2xs text-subtle-foreground">
                    {uiText("custom", undefined, undefined, uiLocale)}
                  </span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className={cn(
                          "size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground",
                          isFavorite && "text-warning hover:text-warning",
                        )}
                        onClick={() => handleToggleFavorite(model.slug)}
                        aria-label={uiText(
                          "{action, select, remove {Remove {model} from favorites} other {Add {model} to favorites}}",
                          {
                            action: isFavorite ? "remove" : "add",
                            model: model.name,
                          },
                          undefined,
                          uiLocale,
                        )}
                      />
                    }
                  >
                    <StarIcon className={cn("size-3", isFavorite && "fill-current")} />
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    {isFavorite
                      ? uiText("Remove from favorites", undefined, undefined, uiLocale)
                      : uiText("Add to favorites", undefined, undefined, uiLocale)}
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                        disabled={!canMoveUp}
                        onClick={() => handleMove(model.slug, -1)}
                        aria-label={uiText(
                          "Move {value0} up",
                          { value0: model.name },
                          undefined,
                          uiLocale,
                        )}
                      />
                    }
                  >
                    <ArrowUpIcon className="size-3" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    {uiText("Move up", undefined, undefined, uiLocale)}
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                        disabled={!canMoveDown}
                        onClick={() => handleMove(model.slug, 1)}
                        aria-label={uiText(
                          "Move {value0} down",
                          { value0: model.name },
                          undefined,
                          uiLocale,
                        )}
                      />
                    }
                  >
                    <ArrowDownIcon className="size-3" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    {uiText("Move down", undefined, undefined, uiLocale)}
                  </TooltipPopup>
                </Tooltip>
                {!model.isCustom ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                          onClick={() => handleToggleHidden(model.slug)}
                          aria-label={
                            isHidden
                              ? uiText("Show {model}", { model: model.name }, undefined, uiLocale)
                              : uiText("Hide {model}", { model: model.name }, undefined, uiLocale)
                          }
                        />
                      }
                    >
                      {isHidden ? (
                        <EyeIcon className="size-3" />
                      ) : (
                        <EyeOffIcon className="size-3" />
                      )}
                    </TooltipTrigger>
                    <TooltipPopup side="top">
                      {isHidden
                        ? uiText("Show in picker", undefined, undefined, uiLocale)
                        : uiText("Hide from picker", undefined, undefined, uiLocale)}
                    </TooltipPopup>
                  </Tooltip>
                ) : null}
                {model.isCustom ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                          aria-label={uiText(
                            "Remove {value0}",
                            { value0: model.slug },
                            undefined,
                            uiLocale,
                          )}
                          onClick={() => handleRemove(model.slug)}
                        />
                      }
                    >
                      <XIcon className="size-3" />
                    </TooltipTrigger>
                    <TooltipPopup side="top">
                      {uiText("Remove custom model", undefined, undefined, uiLocale)}
                    </TooltipPopup>
                  </Tooltip>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input
          id={`provider-instance-${instanceId}-custom-model`}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            if (errorCode) setErrorCode(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            handleAdd();
          }}
          placeholder={
            driverKind
              ? uiPresentation.CUSTOM_MODEL_PLACEHOLDER_BY_KIND[driverKind]
              : uiText("model-slug", undefined, undefined, uiLocale)
          }
          spellCheck={false}
        />
        <Button className="shrink-0" variant="outline" onClick={handleAdd}>
          <PlusIcon className="size-3.5" />
          {uiText("Add", undefined, undefined, uiLocale)}
        </Button>
      </div>

      {errorCode ? (
        <p className="mt-2 text-xs text-destructive">
          {formatModelValidation(errorCode, uiLocale)}
        </p>
      ) : null}
    </div>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { CUSTOM_MODEL_PLACEHOLDER_BY_KIND };
