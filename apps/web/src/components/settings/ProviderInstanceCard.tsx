"use client";

import {
  ArrowUpCircleIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  LogInIcon,
  PinIcon,
  PlusIcon,
  RotateCcwIcon,
  Settings2Icon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import {
  isProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceDefaultOption,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@cafecode/contracts";

import { cn } from "../../lib/utils";
import { ProviderUsageResetButton } from "../ProviderUsageResetButton";
import { ProviderAccountQuotaDetails } from "../ProviderAccountQuotaDetails";
import { ensureWorkspaceApi } from "../../environments/workspaceApi";
import {
  formatCodexRateLimitPresentation,
  shouldSurfaceProviderAccountRateLimits,
} from "../../lib/codexRateLimits";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { useServerConfig } from "../../rpc/serverState";
import { subagentLimitKey, validSubagentLimit } from "../../subagentConcurrency";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { DraftInput } from "../ui/draft-input";
import { InfoTip } from "../ui/info-tip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DriverOption } from "./providerDriverMeta";
import {
  ProviderSettingsForm,
  deriveProviderSettingsFields,
  isProviderSettingCustomized,
  readProviderConfigString,
} from "./ProviderSettingsForm";
import { ProviderModelsSection } from "./ProviderModelsSection";
import { GrokSandboxSettings } from "./GrokSandboxSettings";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import {
  getProviderVersionAdvisoryPresentation,
  PROVIDER_STATUS_STYLES,
  getProviderSummary,
  getProviderVersionLabel,
  type ProviderStatusKey,
} from "./providerStatus";

// Accent colours are user data (a per-account marker), not theme colours, so
// these preset values are deliberately literal.
export const PROVIDER_ACCENT_SWATCHES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
] as const;

const ACCENT_SWATCH_CLASS_NAME =
  "focus-ring relative size-6 shrink-0 cursor-pointer rounded-full border border-border transition-transform duration-(--duration-fast) ease-out hover:scale-105";
// Selection uses a neutral ring so it stays distinct from the accent focus ring.
const ACCENT_SWATCH_SELECTED_CLASS_NAME =
  "ring-2 ring-foreground ring-offset-2 ring-offset-popover";
// The custom-colour swatch shows a colour wheel until a custom colour is chosen.
const ACCENT_COLOR_WHEEL_CLASS_NAME =
  "bg-[conic-gradient(from_40deg,#ef4444,#f97316,#facc15,#22c55e,#06b6d4,#3b82f6,#8b5cf6,#ef4444)]";

const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

let environmentVariableDraftId = 0;
const nextEnvironmentVariableDraftId = () => `provider-env-${environmentVariableDraftId++}`;

type EnvironmentDraftRow = {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
  readonly valueRedacted?: boolean;
};

function makeEnvironmentDraftRow(
  variable: ProviderInstanceEnvironmentVariable,
  index: number,
): EnvironmentDraftRow {
  return {
    id: `${index}:${variable.name}`,
    name: variable.name,
    value: variable.value,
    sensitive: variable.sensitive,
    ...(variable.valueRedacted !== undefined ? { valueRedacted: variable.valueRedacted } : {}),
  };
}

/**
 * Read a string[] at `key` from the opaque config blob, filtering out
 * non-string entries. Used for `customModels`, which is always typed as
 * `string[]` by the concrete driver schemas but arrives here as
 * `Schema.Unknown`.
 */
function readConfigStringArray(config: unknown, key: string): ReadonlyArray<string> {
  if (config === null || typeof config !== "object") return [];
  const value = (config as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Set `key` to an arbitrary value on the opaque config blob. Unlike
 * provider settings field updates, does not drop empty-looking values — the
 * caller is responsible for deciding whether an empty array / empty
 * object should be stored explicitly (e.g. `customModels: []` is a
 * meaningful "user cleared their custom list" state distinct from
 * "driver default").
 */
function nextConfigBlobWithValue(
  config: unknown,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};
  base[key] = value;
  return base;
}

export function deriveProviderModelsForDisplay(input: {
  readonly liveModels: ReadonlyArray<ServerProviderModel> | undefined;
  readonly customModels: ReadonlyArray<string>;
}): ReadonlyArray<ServerProviderModel> {
  const liveCustomModelsBySlug = new Map(
    (input.liveModels ?? [])
      .filter((model) => model.isCustom)
      .map((model) => [model.slug, model] as const),
  );
  const serverModels = input.liveModels?.filter((model) => !model.isCustom) ?? [];
  const customModels = input.customModels.map(
    (slug) =>
      liveCustomModelsBySlug.get(slug) ?? {
        slug,
        name: slug,
        isCustom: true,
        capabilities: null,
      },
  );
  return [...serverModels, ...customModels];
}

function ProviderAuthEmail(props: {
  readonly email: string | undefined;
  readonly prefix?: string;
  readonly separator?: boolean;
}) {
  const trimmed = props.email?.trim();
  if (!trimmed) return null;

  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
      {props.separator ? <span aria-hidden>·</span> : null}
      {props.prefix ? <span className="text-subtle-foreground">{props.prefix}</span> : null}
      <RedactedSensitiveText
        value={trimmed}
        ariaLabel="Toggle account email visibility"
        revealTooltip="Click to reveal email"
        hideTooltip="Click to hide email"
        className="[overflow-wrap:anywhere]"
      />
    </span>
  );
}

/**
 * Preset accent swatches plus one custom colour, all the same circular
 * control. A swatch commits immediately; the custom colour commits when its
 * native picker closes (blur), so dragging through the picker does not save
 * every intermediate value. Shared with the add-provider dialog.
 */
export function ProviderAccentColorPicker(props: {
  readonly label: ReactNode;
  readonly customColorLabel: string;
  readonly value: string | undefined;
  readonly onCommit: (value: string) => void;
}) {
  const labelId = useId();
  const [draft, setDraft] = useState(props.value ?? "");
  const [isEditing, setIsEditing] = useState(false);
  const draftColor = normalizeProviderAccentColor(draft);
  const selectedSwatch = PROVIDER_ACCENT_SWATCHES.find(
    (swatch) => swatch === draftColor?.toLowerCase(),
  );
  const customColor = draftColor && !selectedSwatch ? draftColor : null;

  useEffect(() => {
    if (isEditing) return;
    setDraft(props.value ?? "");
  }, [isEditing, props.value]);

  const commitDraft = () => {
    setIsEditing(false);
    props.onCommit(draftColor ?? "");
  };

  const commitSwatch = (swatch: string) => {
    setIsEditing(false);
    setDraft(swatch);
    props.onCommit(swatch);
  };

  return (
    <div className="grid gap-2">
      <span id={labelId} className="text-xs font-medium text-foreground">
        {props.label}
      </span>
      <div
        role="group"
        aria-labelledby={labelId}
        className="flex min-h-7 min-w-0 flex-wrap items-center gap-2"
      >
        {PROVIDER_ACCENT_SWATCHES.map((swatch) => {
          const selected = selectedSwatch === swatch;
          return (
            <button
              key={swatch}
              type="button"
              className={cn(
                ACCENT_SWATCH_CLASS_NAME,
                selected && ACCENT_SWATCH_SELECTED_CLASS_NAME,
              )}
              style={{ backgroundColor: swatch }}
              onClick={() => commitSwatch(swatch)}
              aria-label={`Use ${swatch} accent`}
              aria-pressed={selected}
            />
          );
        })}
        <label
          className={cn(
            ACCENT_SWATCH_CLASS_NAME,
            "overflow-hidden has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-2 has-focus-visible:ring-offset-popover",
            customColor ? ACCENT_SWATCH_SELECTED_CLASS_NAME : ACCENT_COLOR_WHEEL_CLASS_NAME,
          )}
          style={customColor ? { backgroundColor: customColor } : undefined}
        >
          <input
            type="color"
            value={draftColor ?? PROVIDER_ACCENT_SWATCHES[0]}
            onFocus={() => setIsEditing(true)}
            onInput={(event) => {
              setIsEditing(true);
              setDraft(event.currentTarget.value);
            }}
            onChange={(event) => {
              setIsEditing(true);
              setDraft(event.currentTarget.value);
            }}
            onBlur={commitDraft}
            aria-label={props.customColorLabel}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </label>
        {draftColor ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => {
              setIsEditing(false);
              setDraft("");
              props.onCommit("");
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ProviderEnvironmentSection(props: {
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly onChange: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
}) {
  const [rows, setRows] = useState<ReadonlyArray<EnvironmentDraftRow>>(() =>
    props.environment.map(makeEnvironmentDraftRow),
  );

  useEffect(() => {
    setRows(props.environment.map(makeEnvironmentDraftRow));
  }, [props.environment]);

  const publishRows = (nextRows: ReadonlyArray<EnvironmentDraftRow>) => {
    const published: ProviderInstanceEnvironmentVariable[] = [];
    for (const row of nextRows) {
      const name = row.name.trim();
      if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
        if (
          name.length > 0 ||
          row.value.length > 0 ||
          row.sensitive !== true ||
          row.valueRedacted !== undefined
        ) {
          return;
        }
        continue;
      }
      const { id: _id, ...rest } = row;
      published.push({ ...rest, name });
    }
    props.onChange(published);
  };

  const updateVariable = (id: string, patch: Partial<Omit<EnvironmentDraftRow, "id">>) => {
    const nextRows = rows.map((row) =>
      row.id === id
        ? {
            ...row,
            ...patch,
            ...(patch.value !== undefined ? { valueRedacted: false } : {}),
          }
        : row,
    );
    setRows(nextRows);
    publishRows(nextRows);
  };

  const removeVariable = (id: string) => {
    const nextRows = rows.filter((row) => row.id !== id);
    setRows(nextRows);
    publishRows(nextRows);
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-foreground">Environment variables</span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() =>
            setRows([
              ...rows,
              {
                id: nextEnvironmentVariableDraftId(),
                name: "",
                value: "",
                sensitive: true,
              },
            ])
          }
        >
          <PlusIcon />
          Add
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Pass API keys, base URLs or other CLI settings to this account.
        </p>
      ) : (
        <div className="grid gap-2">
          {rows.map((variable, index) => (
            <div
              key={variable.id}
              className="grid gap-2 rounded-lg border border-border-subtle bg-muted/30 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto_auto] sm:items-center"
            >
              <DraftInput
                value={variable.name}
                onCommit={(name) => updateVariable(variable.id, { name: name.trim() })}
                placeholder="VARIABLE_NAME"
                spellCheck={false}
                aria-label={`Environment variable name ${index + 1}`}
              />
              <DraftInput
                value={variable.valueRedacted ? "" : variable.value}
                onCommit={(value) => updateVariable(variable.id, { value })}
                type={variable.sensitive ? "password" : undefined}
                autoComplete="off"
                placeholder={
                  variable.valueRedacted ? "Saved. Type a new value to replace it." : "Value"
                }
                spellCheck={false}
                aria-label={`Environment variable value ${index + 1}`}
              />
              <div className="inline-flex h-8 items-center gap-1">
                <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    className="size-3.5 cursor-pointer accent-primary"
                    checked={variable.sensitive}
                    onChange={(event) => {
                      const sensitive = event.currentTarget.checked;
                      updateVariable(variable.id, {
                        sensitive,
                        ...(sensitive && variable.valueRedacted === undefined
                          ? {}
                          : { valueRedacted: sensitive ? variable.valueRedacted : false }),
                      });
                    }}
                  />
                  Sensitive
                </label>
                {/* Outside the label so its button is not part of the checkbox name. */}
                <InfoTip label="About sensitive values">
                  Sensitive values are stored separately and aren&apos;t shown again after saving.
                </InfoTip>
              </div>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="size-8 justify-self-start text-muted-foreground hover:text-destructive sm:justify-self-end"
                onClick={() => removeVariable(variable.id)}
                aria-label={`Remove environment variable ${variable.name || index + 1}`}
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const NO_DEFAULT_SELECT_VALUE = "__no-default__";
const BOOLEAN_DEFAULT_ON_VALUE = "__on__";
const BOOLEAN_DEFAULT_OFF_VALUE = "__off__";

type DefaultsSelectItem = {
  readonly value: string;
  readonly label: string;
  readonly description?: string | undefined;
};

function DefaultsSelectField(props: {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly value: string;
  readonly items: ReadonlyArray<DefaultsSelectItem>;
  readonly onValueChange: (next: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <span id={props.id} className="text-xs font-medium text-foreground">
        {props.label}
      </span>
      <Select
        modal={false}
        value={props.value}
        onValueChange={(next) => {
          if (typeof next === "string") {
            props.onValueChange(next);
          }
        }}
        items={props.items}
      >
        <SelectTrigger aria-labelledby={props.id}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {props.items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              <span className="grid min-w-0 gap-0.5">
                <span className="truncate">{item.label}</span>
                {item.description ? (
                  <span className="whitespace-normal text-xs text-muted-foreground">
                    {item.description}
                  </span>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {props.description ? (
        <span className="text-xs text-muted-foreground">{props.description}</span>
      ) : null}
    </div>
  );
}

/**
 * "New chat defaults" editor for one provider instance: an explicit default
 * model plus explicit defaults for the option traits that model reports
 * (reasoning effort, fast mode, …). Anything left on "No default" falls back
 * to the composer's usual resolution, so this section only stores values the
 * user deliberately picked.
 */
function ProviderInstanceDefaultsSection(props: {
  readonly instanceId: ProviderInstanceId;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly defaultModel: string | undefined;
  readonly defaultModelOptions: ReadonlyArray<ProviderInstanceDefaultOption>;
  readonly driver: ProviderDriverKind | null;
  readonly defaultMaxConcurrentSubagents: number | undefined;
  readonly onConcurrencyDefaultChange: (limit: number | undefined) => void;
  readonly onChange: (next: {
    readonly defaultModel: string | undefined;
    readonly defaultModelOptions: ReadonlyArray<ProviderInstanceDefaultOption> | undefined;
  }) => void;
}) {
  const selectableModels = props.models.filter(
    (model) => !props.hiddenModels.includes(model.slug) || model.slug === props.defaultModel,
  );
  const selectedModel = props.defaultModel
    ? props.models.find((model) => model.slug === props.defaultModel)
    : undefined;
  const optionDescriptors = selectedModel?.capabilities?.optionDescriptors ?? [];

  const modelItems: DefaultsSelectItem[] = [
    {
      value: NO_DEFAULT_SELECT_VALUE,
      label: "No default",
      description: "New chats keep the last model used.",
    },
    ...selectableModels.map((model) => ({
      value: model.slug,
      label: model.name,
      description: model.name === model.slug ? undefined : model.slug,
    })),
  ];
  // Keep a stale stored slug selectable (e.g. the provider has not been
  // probed yet, or the model was retired) so the stored default stays
  // visible instead of silently rendering as "No default".
  if (props.defaultModel && !selectableModels.some((model) => model.slug === props.defaultModel)) {
    modelItems.push({
      value: props.defaultModel,
      label: props.defaultModel,
      description: "Not currently reported by this provider.",
    });
  }

  const handleModelChange = (value: string) => {
    if (value === NO_DEFAULT_SELECT_VALUE) {
      props.onChange({ defaultModel: undefined, defaultModelOptions: undefined });
      return;
    }
    const nextDescriptors = props.models.find((model) => model.slug === value)?.capabilities
      ?.optionDescriptors;
    // Carry option defaults over only when they still exist on the new
    // model; unknown capabilities keep them untouched.
    const prunedOptions = nextDescriptors
      ? props.defaultModelOptions.filter((option) =>
          nextDescriptors.some(
            (descriptor) =>
              descriptor.id === option.id &&
              (descriptor.type === "boolean"
                ? typeof option.value === "boolean"
                : typeof option.value === "string" &&
                  descriptor.options.some((choice) => choice.id === option.value)),
          ),
        )
      : props.defaultModelOptions;
    props.onChange({ defaultModel: value, defaultModelOptions: prunedOptions });
  };

  const setOptionDefault = (id: string, value: string | boolean | null) => {
    const without = props.defaultModelOptions.filter((option) => option.id !== id);
    props.onChange({
      defaultModel: props.defaultModel,
      defaultModelOptions: value === null ? without : [...without, { id, value }],
    });
  };

  return (
    <div className="grid gap-3">
      <div className="grid gap-0.5">
        <span className="text-xs font-medium text-foreground">New chat defaults</span>
        <span className="text-xs text-muted-foreground">
          Used for new chats. “No default” uses the model&apos;s default.
        </span>
      </div>
      <DefaultsSelectField
        id={`provider-instance-${props.instanceId}-default-model`}
        label="Default model"
        value={props.defaultModel ?? NO_DEFAULT_SELECT_VALUE}
        items={modelItems}
        onValueChange={handleModelChange}
      />
      {props.driver && subagentLimitKey(props.driver) ? (
        <div className="grid gap-1.5">
          <div className="flex min-w-0 items-center gap-1">
            <label
              className="text-xs font-medium text-foreground"
              htmlFor={`provider-instance-${props.instanceId}-default-subagent-limit`}
            >
              Default subagent limit
            </label>
            {/* Outside the label so its button is not part of the input name. */}
            <InfoTip label="About the default subagent limit">
              Copied to new chats only; changing it doesn&apos;t restart the provider or change
              existing chats. The main agent isn&apos;t counted.{" "}
              {props.driver === "claudeAgent"
                ? "Claude limits Agent-tool spawning, not all running work."
                : "Codex limits spawned agents that stay open."}
            </InfoTip>
          </div>
          <DraftInput
            id={`provider-instance-${props.instanceId}-default-subagent-limit`}
            aria-describedby={`provider-instance-${props.instanceId}-default-subagent-limit-description`}
            type="number"
            min={1}
            max={64}
            step={1}
            value={
              props.defaultMaxConcurrentSubagents === undefined
                ? ""
                : String(props.defaultMaxConcurrentSubagents)
            }
            placeholder="Provider default"
            onCommit={(value) => {
              if (value.trim() === "") props.onConcurrencyDefaultChange(undefined);
              else if (validSubagentLimit(Number(value)))
                props.onConcurrencyDefaultChange(Number(value));
            }}
          />
          <span
            id={`provider-instance-${props.instanceId}-default-subagent-limit-description`}
            className="text-xs text-muted-foreground"
          >
            1–64. New chats only; blank uses the provider default.
          </span>
        </div>
      ) : null}
      {props.defaultModel && selectedModel && optionDescriptors.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          This model does not report configurable options.
        </p>
      ) : null}
      {props.defaultModel && !selectedModel ? (
        <p className="text-xs text-muted-foreground">
          Option defaults become editable once the provider reports this model.
        </p>
      ) : null}
      {optionDescriptors.map((descriptor) => {
        const current = props.defaultModelOptions.find((option) => option.id === descriptor.id);
        if (descriptor.type === "boolean") {
          const value =
            typeof current?.value === "boolean"
              ? current.value
                ? BOOLEAN_DEFAULT_ON_VALUE
                : BOOLEAN_DEFAULT_OFF_VALUE
              : NO_DEFAULT_SELECT_VALUE;
          return (
            <DefaultsSelectField
              key={descriptor.id}
              id={`provider-instance-${props.instanceId}-default-option-${descriptor.id}`}
              label={descriptor.label}
              description={descriptor.description}
              value={value}
              items={[
                { value: NO_DEFAULT_SELECT_VALUE, label: "No default" },
                { value: BOOLEAN_DEFAULT_ON_VALUE, label: "On" },
                { value: BOOLEAN_DEFAULT_OFF_VALUE, label: "Off" },
              ]}
              onValueChange={(next) =>
                setOptionDefault(
                  descriptor.id,
                  next === NO_DEFAULT_SELECT_VALUE ? null : next === BOOLEAN_DEFAULT_ON_VALUE,
                )
              }
            />
          );
        }
        const modelDefaultChoice = descriptor.options.find((choice) => choice.isDefault);
        const value =
          typeof current?.value === "string" &&
          descriptor.options.some((choice) => choice.id === current.value)
            ? current.value
            : NO_DEFAULT_SELECT_VALUE;
        return (
          <DefaultsSelectField
            key={descriptor.id}
            id={`provider-instance-${props.instanceId}-default-option-${descriptor.id}`}
            label={descriptor.label}
            description={descriptor.description}
            value={value}
            items={[
              {
                value: NO_DEFAULT_SELECT_VALUE,
                label: "No default",
                ...(modelDefaultChoice
                  ? { description: `Model default: ${modelDefaultChoice.label}` }
                  : {}),
              },
              ...descriptor.options.map((choice) => ({
                value: choice.id,
                label: choice.label,
                description: choice.description,
              })),
            ]}
            onValueChange={(next) =>
              setOptionDefault(descriptor.id, next === NO_DEFAULT_SELECT_VALUE ? null : next)
            }
          />
        );
      })}
    </div>
  );
}

const DIALOG_SECTION_CLASS_NAME =
  "border-t border-border-subtle px-4 py-3 first:border-t-0 sm:px-5";
const RUNTIME_SOURCE_FIELD_KEYS: ReadonlySet<string> = new Set(["runtimeSource"]);

/**
 * Settings-form fields to hide for the current server. The bundled runtime is
 * Windows-only (AGENTS.md "Bundled mode is Windows-only"), so other servers
 * hide the Runtime choice; an unknown platform keeps it. A stored "bundled"
 * value stays visible so it can be switched back. Presentation only: hidden
 * fields keep their stored values.
 */
export function useHiddenProviderSettingsFieldKeys(
  config: unknown,
): ReadonlySet<string> | undefined {
  const serverOs = useServerConfig()?.environment.platform.os;
  const showRuntimeSource =
    serverOs === "windows" ||
    serverOs === "unknown" ||
    readProviderConfigString(config, "runtimeSource") === "bundled";
  return showRuntimeSource ? undefined : RUNTIME_SOURCE_FIELD_KEYS;
}

/**
 * Collapsed "Advanced" block for runtime identity (config fields and
 * environment). Saving any of these reloads the instance and can end its
 * sessions (AGENTS.md "Provider instance reconciliation"), so the warning is
 * one visible line inside the section.
 *
 * It starts collapsed. None of its fields render inline validation errors
 * (invalid numbers are rejected without saving), so collapsing cannot hide
 * one; the trigger instead shows how many values are customized.
 */
function ProviderAdvancedSection(props: {
  readonly customizedCount: number;
  readonly reloadDetail?: string | undefined;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={DIALOG_SECTION_CLASS_NAME}>
      <CollapsibleTrigger className="group focus-ring -mx-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-xs font-medium text-foreground transition-colors duration-(--duration-fast) hover:bg-accent">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 text-muted-foreground transition-transform duration-(--duration-fast) ease-out group-data-[panel-open]:rotate-90"
        />
        Advanced
        {props.customizedCount > 0 ? (
          <span className="font-normal text-subtle-foreground tabular-nums">
            · {props.customizedCount} customized
          </span>
        ) : null}
      </CollapsibleTrigger>
      {/* The panel clips its height animation; the horizontal and bottom
          padding keeps input focus rings inside that clip. */}
      <CollapsiblePanel className="-mx-1 px-1">
        <div className="grid animate-enter-rise gap-4 pt-3 pb-1">
          <div className="flex min-w-0 items-center gap-1">
            <p className="text-xs text-muted-foreground">
              Saving these reloads the account and can end active chats.
            </p>
            {props.reloadDetail ? (
              <InfoTip label="About reloading">{props.reloadDetail}</InfoTip>
            ) : null}
          </div>
          {props.children}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

interface ProviderInstanceCardProps {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driverOption: DriverOption | undefined;
  readonly liveProvider: ServerProvider | undefined;
  readonly isSettingsOpen: boolean;
  readonly onSettingsOpenChange: (open: boolean) => void;
  /**
   * Whether this instance is the global default provider for new chats,
   * plus the toggle invoked from the header affordance (`true` sets this
   * instance as the default, `false` clears the default entirely).
   */
  readonly isDefaultProvider: boolean;
  readonly onSetDefaultProvider: (next: boolean) => void;
  readonly onUpdate: (nextInstance: ProviderInstanceConfig) => void;
  /**
   * Pass `undefined` to hide the delete button entirely. Built-in default
   * instance slots use `undefined` — they can't be deleted without losing
   * the slot, and their "reset to defaults" affordance lives on an outer
   * reset button instead. Explicit `| undefined` in the type accommodates
   * `exactOptionalPropertyTypes: true`, where an absent key and
   * `{ onDelete: undefined }` are treated as distinct shapes.
   */
  readonly onDelete?: (() => void) | undefined;
  /**
   * Optional outer reset button rendered next to the driver icon. Built-in
   * default slots supply a reset-to-factory control here; custom instances
   * omit it.
   */
  readonly headerAction?: ReactNode | undefined;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly favoriteModels: ReadonlyArray<string>;
  readonly modelOrder: ReadonlyArray<string>;
  readonly onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
  readonly onRunUpdate?: (() => void) | undefined;
  readonly isUpdating?: boolean | undefined;
  readonly onLogIn?: (() => void) | undefined;
  readonly isLoggingIn?: boolean | undefined;
  readonly onRestartRuntime?: (() => void) | undefined;
  readonly isRestartingRuntime?: boolean | undefined;
}

/**
 * A single configured provider-instance row in the Providers settings
 * section. Used for every row — both the built-in default instance for a
 * driver (rendered with `onDelete` omitted) and user-authored custom
 * instances (`onDelete` supplied). The only UI difference between the two
 * is whether the trash button is visible; every other field (display
 * name, config fields, models) behaves identically.
 *
 * Behavior notes:
 *   - `liveProvider` is matched by the caller via `instanceId`; when no
 *     match is available (e.g. the server hasn't probed yet, or the
 *     driver is not shipped by the current build) the card still renders
 *     with a neutral "checking" summary.
 *   - Unknown drivers (`driverOption === undefined`) get a read-only
 *     notice instead of editable fields, so fork instances round-trip
 *     without accidentally destroying their config.
 *   - The enabled Switch writes to the envelope's `instance.enabled`
 *     field; the server's registry consults this at `entry.enabled ?? true`
 *     before materializing the instance, and the probe also checks its
 *     driver-specific `config.enabled`. We treat the envelope flag as the
 *     single source of truth from the UI — built-in cards used to write
 *     the inner flag, but on the promotion-to-instance path every edit
 *     flows through the envelope.
 */
export function ProviderInstanceCard({
  instanceId,
  instance,
  driverOption,
  liveProvider,
  isSettingsOpen,
  onSettingsOpenChange,
  isDefaultProvider,
  onSetDefaultProvider,
  onUpdate,
  onDelete,
  headerAction,
  hiddenModels,
  favoriteModels,
  modelOrder,
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onModelOrderChange,
  onRunUpdate,
  isUpdating = false,
  onLogIn,
  isLoggingIn = false,
  onRestartRuntime,
  isRestartingRuntime = false,
}: ProviderInstanceCardProps) {
  const enabled = instance.enabled ?? true;
  // The server-reported status wins when present; otherwise fall back to
  // "disabled"/"checking" based on the local `enabled` flag so the dot
  // reflects the persisted intent even before the first probe completes.
  // "Checking" is a neutral pulse: no probe has reported a problem yet.
  const statusKey: ProviderStatusKey =
    (liveProvider?.status as ProviderStatusKey | undefined) ?? (enabled ? "checking" : "disabled");
  const statusStyle = PROVIDER_STATUS_STYLES[statusKey];
  const summary =
    !liveProvider && !enabled
      ? { headline: "Disabled", detail: null }
      : getProviderSummary(liveProvider);
  const authEmail = liveProvider?.auth.email;
  const hasSandboxFailure =
    instance.driver === "grok" && liveProvider?.sandbox?.status === "unavailable";
  const hasAuthenticatedEmail =
    !hasSandboxFailure &&
    liveProvider?.auth.status === "authenticated" &&
    Boolean(authEmail?.trim());
  const authenticatedDetail = hasAuthenticatedEmail
    ? (liveProvider?.auth.label ?? liveProvider?.auth.type ?? null)
    : null;
  const accountQuota = shouldSurfaceProviderAccountRateLimits(liveProvider)
    ? formatCodexRateLimitPresentation(liveProvider?.accountRateLimits)
    : null;
  const versionLabel = getProviderVersionLabel(liveProvider?.version);
  const versionAdvisory = getProviderVersionAdvisoryPresentation(liveProvider?.versionAdvisory);
  const updateCommand = versionAdvisory?.updateCommand ?? null;
  const FallbackIconComponent = driverOption?.icon;
  const displayName =
    instance.displayName?.trim() || driverOption?.label || String(instance.driver);
  const accentColor = normalizeProviderAccentColor(instance.accentColor);
  // A successful copy is confirmed inline by the button's check mark; only a
  // failure needs a toast.
  const { copyToClipboard, isCopied: isUpdateCommandCopied } = useCopyToClipboard<{
    providerName: string;
  }>({
    onError: (error, { providerName }) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not copy ${providerName} update command`,
          description: error.message,
        }),
      );
    },
  });

  // Narrow `instance.driver` for callers that key on the closed
  // `ProviderDriverKind` union (e.g. `normalizeModelSlug`'s alias table). Custom
  // fork drivers pass through as `null` and those callers fall back to
  // verbatim behaviour.
  const driverKind: ProviderDriverKind | null = isProviderDriverKind(instance.driver)
    ? instance.driver
    : null;

  const customModels = readConfigStringArray(instance.config, "customModels");
  // Server-returned models may lag behind settings writes. Treat probe
  // models as the source for built-ins only; custom rows come directly
  // from the current instance config so add/remove reflects immediately.
  const modelsForDisplay = deriveProviderModelsForDisplay({
    liveModels: liveProvider?.models,
    customModels,
  });

  const updateDisplayName = (value: string) => {
    const trimmed = value.trim();
    const { displayName: _omit, ...rest } = instance;
    onUpdate(
      trimmed.length > 0
        ? ({ ...rest, displayName: trimmed } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateEnabled = (value: boolean) => {
    onUpdate({ ...instance, enabled: value });
  };

  const updateAccentColor = (value: string) => {
    const normalized = normalizeProviderAccentColor(value);
    const { accentColor: _omit, ...rest } = instance;
    onUpdate(
      normalized
        ? ({ ...rest, accentColor: normalized } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateConfig = (nextConfig: Record<string, unknown> | undefined) => {
    const { config: _omit, ...rest } = instance;
    onUpdate(
      nextConfig !== undefined
        ? ({ ...rest, config: nextConfig } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateCustomModels = (next: ReadonlyArray<string>) => {
    const nextConfig = nextConfigBlobWithValue(instance.config, "customModels", [...next]);
    const { config: _omit, ...rest } = instance;
    onUpdate({ ...rest, config: nextConfig } as ProviderInstanceConfig);
  };

  const updateEnvironment = (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => {
    const cleaned = environment.filter((variable) => variable.name.trim().length > 0);
    const { environment: _omit, ...rest } = instance;
    onUpdate(
      cleaned.length > 0
        ? ({ ...rest, environment: cleaned } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateNewChatDefaults = (next: {
    readonly defaultModel: string | undefined;
    readonly defaultModelOptions: ReadonlyArray<ProviderInstanceDefaultOption> | undefined;
  }) => {
    const { defaultModel: _model, defaultModelOptions: _options, ...rest } = instance;
    onUpdate({
      ...rest,
      ...(next.defaultModel !== undefined ? { defaultModel: next.defaultModel } : {}),
      ...(next.defaultModelOptions !== undefined && next.defaultModelOptions.length > 0
        ? { defaultModelOptions: next.defaultModelOptions }
        : {}),
    } as ProviderInstanceConfig);
  };

  const hiddenSettingsFieldKeys = useHiddenProviderSettingsFieldKeys(instance.config);
  const settingsFields = useMemo(
    () => (driverOption ? deriveProviderSettingsFields(driverOption) : []),
    [driverOption],
  );
  // Advanced starts collapsed; this count keeps configured values discoverable.
  const advancedCustomizedCount =
    settingsFields.filter((field) => isProviderSettingCustomized(instance.config, field)).length +
    (instance.environment?.length ?? 0);

  const titleIconNode = driverKind ? (
    <ProviderInstanceIcon
      driverKind={driverKind}
      displayName={displayName}
      accentColor={accentColor}
      showBadge={Boolean(accentColor)}
      statusDotClassName={statusStyle.dot}
      className="size-5"
      iconClassName="size-4 text-foreground"
      badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 text-[7px]"
    />
  ) : FallbackIconComponent ? (
    <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
      <FallbackIconComponent className="size-4 text-foreground" aria-hidden />
      <span
        className={cn(
          "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
          statusStyle.dot,
        )}
        aria-hidden
      />
    </span>
  ) : (
    <span className={cn("size-2 shrink-0 rounded-full", statusStyle.dot)} />
  );

  const titleHeadNode = (
    <>
      {titleIconNode}
      <h3 className="max-w-full truncate text-ui font-semibold text-foreground">{displayName}</h3>
      {/* An unnamed extra instance shares its driver's label, so its ID is the
          only thing telling two cards apart. Named instances show it in their
          settings dialog instead. */}
      {String(instanceId) !== String(instance.driver) && !instance.displayName?.trim() ? (
        <code className="max-w-full truncate rounded-sm bg-muted px-1 py-0.5 font-mono text-2xs text-muted-foreground">
          {instanceId}
        </code>
      ) : null}
      {driverOption?.badgeLabel ? (
        <Badge variant="warning" size="sm" className="shrink-0">
          {driverOption.badgeLabel}
        </Badge>
      ) : null}
    </>
  );

  const titleTailNode = (
    <>
      {headerAction ? (
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
          {headerAction}
        </span>
      ) : null}
      {onDelete ? (
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 rounded-sm p-0 text-muted-foreground hover:text-destructive"
                  onClick={onDelete}
                  aria-label={`Delete provider instance ${instanceId}`}
                >
                  <Trash2Icon className="size-3" />
                </Button>
              }
            />
            <TooltipPopup side="top">Delete</TooltipPopup>
          </Tooltip>
        </span>
      ) : null}
    </>
  );

  const authRowNode = (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
      {hasAuthenticatedEmail ? (
        <>
          <span>Authenticated as</span>
          <ProviderAuthEmail email={authEmail} />
          {authenticatedDetail ? <span>· {authenticatedDetail}</span> : null}
        </>
      ) : (
        <>
          <span>{summary.headline}</span>
          <ProviderAuthEmail email={authEmail} separator prefix="Email" />
        </>
      )}
      {summary.detail ? <span>· {summary.detail}</span> : null}
    </p>
  );

  const versionCodeNode = versionLabel ? (
    <code className="max-w-full text-xs text-muted-foreground [overflow-wrap:anywhere]">
      {versionLabel}
    </code>
  ) : null;

  return (
    <div
      className="@container/provider-card min-w-0 border-t border-border-subtle first:border-t-0"
      data-provider-card
    >
      <div className="px-4 py-3.5 sm:px-5">
        {/* Actions belong to the identity header, never the variable-height
            quota body. Query the card's own width so a narrow settings column
            stacks controls even in a large desktop window. */}
        <div
          className="grid min-w-0 items-start gap-x-3 gap-y-2 @min-[32rem]/provider-card:grid-cols-[minmax(0,1fr)_auto]"
          data-provider-card-header
        >
          <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {titleHeadNode}
            {versionCodeNode}
            {versionAdvisory ? (
              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className={cn(
                        "size-5 rounded-sm p-0",
                        versionAdvisory.emphasis === "strong"
                          ? "text-warning hover:text-warning"
                          : "text-primary hover:text-primary",
                      )}
                      aria-label="Update available — view details"
                    >
                      <ArrowUpCircleIcon className="size-3.5 animate-bounce [--cafe-bounce-duration:2.4s] [--cafe-bounce-steps:72] motion-reduce:animate-none" />
                    </Button>
                  }
                />
                <PopoverPopup
                  side="bottom"
                  align="start"
                  className="w-[min(21rem,calc(100vw-1.5rem))] [--popup-width:min(21rem,calc(100vw-1.5rem))]"
                >
                  <div className="grid min-w-0 gap-3">
                    <div className="grid gap-0.5">
                      <p className="text-ui font-semibold text-foreground">Update available</p>
                      <p
                        className={cn(
                          "text-xs leading-snug",
                          versionAdvisory.emphasis === "strong"
                            ? "text-warning"
                            : "text-muted-foreground",
                        )}
                      >
                        {versionAdvisory.detail}
                      </p>
                    </div>
                    {onRunUpdate ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="default"
                        className="w-full"
                        disabled={isUpdating}
                        onClick={onRunUpdate}
                      >
                        {isUpdating ? <Spinner aria-hidden="true" /> : <DownloadIcon />}
                        {isUpdating ? "Updating…" : "Update now"}
                      </Button>
                    ) : null}
                    {onRunUpdate && updateCommand ? (
                      <div className="flex items-center gap-2 text-2xs text-subtle-foreground">
                        <span aria-hidden className="h-px flex-1 bg-border-subtle" />
                        or update manually
                        <span aria-hidden className="h-px flex-1 bg-border-subtle" />
                      </div>
                    ) : null}
                    {updateCommand ? (
                      <div className="flex min-w-0 items-center gap-1 rounded-lg border border-border-subtle bg-muted/40 py-0.5 pr-0.5 pl-2">
                        <ScrollArea scrollFade className="h-8 min-w-0 flex-1 rounded-none">
                          <code className="flex h-full w-max items-center whitespace-nowrap pr-3 font-mono text-2xs text-foreground">
                            {updateCommand}
                          </code>
                        </ScrollArea>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                type="button"
                                size="icon-xs"
                                variant="ghost"
                                className="size-6 shrink-0 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                                onClick={() =>
                                  copyToClipboard(updateCommand, {
                                    providerName: displayName,
                                  })
                                }
                                aria-label="Copy update command"
                              >
                                {isUpdateCommandCopied ? (
                                  <CheckIcon className="size-3 text-success" />
                                ) : (
                                  <CopyIcon className="size-3" />
                                )}
                              </Button>
                            }
                          />
                          <TooltipPopup side="top">
                            {isUpdateCommandCopied ? "Copied" : "Copy command"}
                          </TooltipPopup>
                        </Tooltip>
                      </div>
                    ) : null}
                  </div>
                </PopoverPopup>
              </Popover>
            ) : null}
            {titleTailNode}
          </div>
          <div
            className="flex min-w-0 flex-wrap items-center justify-end gap-2"
            data-provider-card-actions
          >
            {onLogIn ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="h-7 gap-1.5 px-2 text-xs"
                disabled={isLoggingIn}
                onClick={onLogIn}
              >
                {isLoggingIn ? (
                  <Spinner aria-hidden="true" className="size-3.5" />
                ) : (
                  <LogInIcon className="size-3.5" />
                )}
                Log in
              </Button>
            ) : null}
            {/* Keep the optional reset alongside the existing controls. A
                standalone quota action row would push all usage facts down
                whenever a reset becomes available, leaving a blank strip. */}
            {accountQuota ? (
              <ProviderUsageResetButton
                provider={liveProvider}
                request={(input) => ensureWorkspaceApi().server.usageReset(input)}
              />
            ) : null}
            {onRestartRuntime ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className="size-7 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                      disabled={isRestartingRuntime}
                      onClick={onRestartRuntime}
                      aria-label={`Restart ${displayName} runtime`}
                    >
                      {isRestartingRuntime ? (
                        <Spinner aria-hidden="true" className="size-3.5" />
                      ) : (
                        <RotateCcwIcon className="size-3.5" />
                      )}
                    </Button>
                  }
                />
                <TooltipPopup side="top">Restart provider</TooltipPopup>
              </Tooltip>
            ) : null}
            {isDefaultProvider ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      className="focus-ring inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md bg-primary/10 px-1.5 text-2xs font-medium text-primary transition-colors duration-(--duration-fast) hover:bg-primary/15"
                      onClick={() => onSetDefaultProvider(false)}
                      aria-label={`Clear ${displayName} as default provider`}
                    >
                      <PinIcon className="size-3" aria-hidden />
                      Default
                    </button>
                  }
                />
                <TooltipPopup side="top">
                  New chats start on this provider. Click to clear.
                </TooltipPopup>
              </Tooltip>
            ) : enabled ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className="size-7 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                      onClick={() => onSetDefaultProvider(true)}
                      aria-label={`Set ${displayName} as default provider`}
                    >
                      <PinIcon className="size-3.5" />
                    </Button>
                  }
                />
                <TooltipPopup side="top">Use for new chats by default</TooltipPopup>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="size-7 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    onClick={() => onSettingsOpenChange(true)}
                    aria-label={`Open ${displayName} settings`}
                  >
                    <Settings2Icon className="size-3.5" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Settings</TooltipPopup>
            </Tooltip>
            <Switch
              checked={enabled}
              onCheckedChange={(checked) => updateEnabled(Boolean(checked))}
              aria-label={`Enable ${displayName}`}
            />
          </div>
        </div>
        {/* Details use the whole card independently of its header controls.
            Reserve the quota scrollbar's gutter so longer bucket lists do
            not change the available width and unexpectedly rewrap rows. */}
        <div className="mt-2 min-w-0 space-y-2" data-provider-card-details>
          {authRowNode}
          {accountQuota ? (
            <div className="w-full [&_[data-account-quota-scroll]]:[scrollbar-gutter:stable]">
              <ProviderAccountQuotaDetails presentation={accountQuota} layout="settings" />
            </div>
          ) : null}
        </div>
      </div>

      {driverKind === "grok" ? (
        <GrokSandboxSettings
          placement="card"
          instance={instance}
          displayName={displayName}
          sandbox={liveProvider?.sandbox}
          onUpdate={onUpdate}
        />
      ) : null}

      <Dialog open={isSettingsOpen} onOpenChange={onSettingsOpenChange}>
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              {titleIconNode}
              <span className="truncate">{displayName} settings</span>
            </DialogTitle>
            {String(instanceId) !== String(instance.driver) ? (
              <p className="truncate font-mono text-2xs text-subtle-foreground">{instanceId}</p>
            ) : null}
          </DialogHeader>
          <DialogPanel className="px-0 pb-4">
            <div>
              <div className={DIALOG_SECTION_CLASS_NAME}>
                <div className="grid gap-4">
                  <div className="grid gap-1.5">
                    <label
                      htmlFor={`provider-instance-${instanceId}-display-name`}
                      className="text-xs font-medium text-foreground"
                    >
                      Display name
                    </label>
                    <DraftInput
                      id={`provider-instance-${instanceId}-display-name`}
                      value={instance.displayName ?? ""}
                      onCommit={updateDisplayName}
                      placeholder={driverOption?.label ?? "Instance label"}
                      spellCheck={false}
                    />
                  </div>
                  <ProviderAccentColorPicker
                    label="Accent color"
                    customColorLabel={`Custom accent color for ${displayName}`}
                    value={accentColor}
                    onCommit={updateAccentColor}
                  />
                </div>
              </div>

              {driverOption !== undefined ? (
                <div className={DIALOG_SECTION_CLASS_NAME}>
                  <ProviderInstanceDefaultsSection
                    instanceId={instanceId}
                    models={modelsForDisplay}
                    hiddenModels={hiddenModels}
                    defaultModel={instance.defaultModel}
                    defaultModelOptions={instance.defaultModelOptions ?? []}
                    driver={driverKind}
                    defaultMaxConcurrentSubagents={instance.defaultMaxConcurrentSubagents}
                    onConcurrencyDefaultChange={(limit) => {
                      const { defaultMaxConcurrentSubagents: _previous, ...rest } = instance;
                      onUpdate({
                        ...rest,
                        ...(limit !== undefined ? { defaultMaxConcurrentSubagents: limit } : {}),
                      });
                    }}
                    onChange={updateNewChatDefaults}
                  />
                </div>
              ) : null}

              {driverOption !== undefined ? (
                <ProviderModelsSection
                  instanceId={instanceId}
                  driverKind={driverKind}
                  models={modelsForDisplay}
                  customModels={customModels}
                  hiddenModels={hiddenModels}
                  favoriteModels={favoriteModels}
                  modelOrder={modelOrder}
                  onChange={updateCustomModels}
                  onHiddenModelsChange={onHiddenModelsChange}
                  onFavoriteModelsChange={onFavoriteModelsChange}
                  onModelOrderChange={onModelOrderChange}
                />
              ) : (
                <div className={DIALOG_SECTION_CLASS_NAME}>
                  <p className="text-xs text-muted-foreground">
                    This provider (
                    <code className="text-foreground">{String(instance.driver)}</code>) isn&apos;t
                    in this version of Cafe Code. Its settings are kept but can&apos;t be edited
                    here.
                  </p>
                </div>
              )}

              <ProviderAdvancedSection
                customizedCount={advancedCustomizedCount}
                reloadDetail={
                  driverKind && subagentLimitKey(driverKind)
                    ? "To change the subagent limit without a reload, use the default subagent limit above or the per-chat control."
                    : undefined
                }
              >
                {driverOption ? (
                  <ProviderSettingsForm
                    definition={driverOption}
                    value={instance.config}
                    idPrefix={`provider-instance-${instanceId}`}
                    variant="card"
                    hiddenFieldKeys={hiddenSettingsFieldKeys}
                    onChange={updateConfig}
                  />
                ) : null}
                <ProviderEnvironmentSection
                  environment={instance.environment ?? []}
                  onChange={updateEnvironment}
                />
                {driverKind === "grok" ? (
                  <GrokSandboxSettings
                    placement="dialog"
                    instance={instance}
                    displayName={displayName}
                    sandbox={liveProvider?.sandbox}
                    onUpdate={onUpdate}
                  />
                ) : null}
              </ProviderAdvancedSection>
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
