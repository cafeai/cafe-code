import { useUiLocale, useUiPresentation } from "~/i18n";
("use client");

import { uiText } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import { CheckIcon } from "lucide-react";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  defaultInstanceIdForDriver,
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderInstanceConfig,
} from "@cafecode/contracts";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS } from "./providerDriverMeta";
import {
  ProviderAccentColorPicker,
  useHiddenProviderSettingsFieldKeys,
} from "./ProviderInstanceCard";
import { ProviderSettingsForm, deriveProviderSettingsFields } from "./ProviderSettingsForm";
import { AnimatedHeight } from "../AnimatedHeight";

function OptionalMark() {
  const uiLocale = useUiLocale();

  return (
    <span className="font-normal text-subtle-foreground">
      {uiText("(optional)", undefined, undefined, uiLocale)}
    </span>
  );
}

/**
 * Normalize a user-provided label into a slug suffix for the instance id.
 * Named accounts prefix the label with the driver slug — e.g. label "Work"
 * on driver "codex" becomes `codex_work`. Output is trimmed to 48 chars so the
 * final composed id stays under the 64-char slug cap enforced by
 * `ProviderInstanceId` in `@cafecode/contracts`.
 */
function slugifyLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function deriveInstanceId(
  driver: ProviderDriverKind,
  label: string,
  existing: ReadonlySet<string>,
): string {
  const slug = slugifyLabel(label);
  const base = (slug ? `${driver}_${slug}` : String(driver)).slice(0, 64);
  let candidate = base;
  for (let index = 2; existing.has(candidate); index += 1) {
    const suffix = `_${index}`;
    candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
  }
  return candidate;
}

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const DEFAULT_DRIVER_OPTION = DRIVER_OPTIONS[0]!;
const EMPTY_CONFIG_DRAFT: Record<string, unknown> = {};

/**
 * Validate an instance id against the same slug rules the server applies in
 * `ProviderInstanceId` (see `packages/contracts/src/providerInstance.ts`).
 * Returns a user-facing error string, or `null` if valid.
 */
function validateInstanceId(id: string, existing: ReadonlySet<string>): string | null {
  if (id.length === 0) return uiText("Instance ID is required.");
  if (id.length > 64) return uiText("Instance ID must be 64 characters or fewer.");
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return uiText(
      "Instance ID must start with a letter and use only letters, digits, ''-'', or ''_''.",
    );
  }
  if (existing.has(id)) return uiText("An instance named ''{id}'' already exists.", { id });
  return null;
}

interface AddProviderInstanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddProviderInstanceDialog({ open, onOpenChange }: AddProviderInstanceDialogProps) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

  const [wizardStep, setWizardStep] = useState(0);
  const [driver, setDriver] = useState<ProviderDriverKind>(DEFAULT_DRIVER_KIND);
  const [label, setLabel] = useState("");
  const [accentColor, setAccentColor] = useState<string>("");
  const [instanceIdDraft, setInstanceIdDraft] = useState("");
  const [instanceIdDirty, setInstanceIdDirty] = useState(false);
  const instanceIdInputRef = useRef<HTMLInputElement>(null);
  // Driver-specific config drafts keyed by driver so toggling between drivers
  // during the same dialog session does not lose in-progress input.
  const [configByDriver, setConfigByDriver] = useState<Record<string, Record<string, unknown>>>({});
  // Errors are suppressed until the user has tried to submit once. After that
  // they update live so fixing the problem clears the message in place.
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);

  const existingIds = useMemo(
    () =>
      new Set([
        ...Object.keys(settings.providers).map((driver) =>
          String(defaultInstanceIdForDriver(ProviderDriverKind.make(driver))),
        ),
        ...Object.keys(settings.providerInstances ?? {}),
      ]),
    [settings.providerInstances, settings.providers],
  );
  const instanceId = instanceIdDirty
    ? instanceIdDraft
    : deriveInstanceId(driver, label, existingIds);

  // Reset the form every time the dialog opens so each creation starts
  // from a clean slate.
  useEffect(() => {
    if (!open) return;
    setDriver(DEFAULT_DRIVER_KIND);
    setLabel("");
    setAccentColor("");
    setInstanceIdDraft("");
    setWizardStep(0);
    setInstanceIdDirty(false);
    setConfigByDriver({});
    setHasAttemptedSubmit(false);
  }, [open]);

  const driverOption =
    uiPresentation.DRIVER_OPTION_BY_VALUE[driver] ?? uiPresentation.DEFAULT_DRIVER_OPTION;
  const driverSettingsFields = useMemo(
    () => deriveProviderSettingsFields(driverOption),
    [driverOption],
  );
  const instanceIdError = uiPresentation.validateInstanceId(instanceId, existingIds);
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;
  useEffect(() => {
    if (showInstanceIdError && wizardStep === 1) instanceIdInputRef.current?.focus();
  }, [showInstanceIdError, wizardStep]);

  const goToStep = (step: number) => {
    if (step > 1 && instanceIdError !== null) {
      setHasAttemptedSubmit(true);
      setWizardStep(1);
      instanceIdInputRef.current?.focus();
      return;
    }
    setWizardStep(step);
  };
  const previewLabel =
    label.trim() ||
    uiText("{provider} Workspace", { provider: driverOption.label }, undefined, uiLocale);
  const wizardSteps = [
    uiText("Provider", undefined, undefined, uiLocale),
    uiText("Identity", undefined, undefined, uiLocale),
    uiText("Config", undefined, undefined, uiLocale),
  ] as const;
  const wizardStepSummaries = [driverOption.label, previewLabel, null] as const;

  const configDraft = configByDriver[driver] ?? EMPTY_CONFIG_DRAFT;
  const hiddenSettingsFieldKeys = useHiddenProviderSettingsFieldKeys(configDraft);
  const setConfigDraft = useCallback(
    (config: Record<string, unknown> | undefined) => {
      setConfigByDriver((existing) => {
        const next = { ...existing };
        if (config === undefined || Object.keys(config).length === 0) {
          delete next[driver];
        } else {
          next[driver] = config;
        }
        return next;
      });
    },
    [driver],
  );

  const handleSave = useCallback(() => {
    setHasAttemptedSubmit(true);
    if (instanceIdError !== null) {
      setWizardStep(1);
      return;
    }

    const config = configByDriver[driver] ?? {};
    const hasConfig = Object.keys(config).length > 0;
    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);

    const nextInstance: ProviderInstanceConfig = {
      driver,
      enabled: true,
      ...(label.trim().length > 0 ? { displayName: label.trim() } : {}),
      ...(normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      ...(hasConfig ? { config } : {}),
    };
    // `ProviderInstanceId.make` revalidates the slug; we've already checked
    // it via `validateInstanceId`, but going through the brand constructor
    // keeps the type boundary honest and guards against any future drift in
    // the slug rules.
    const brandedId = ProviderInstanceId.make(instanceId);
    const nextMap = {
      ...settings.providerInstances,
      [brandedId]: nextInstance,
    };
    try {
      updateSettings({ providerInstances: nextMap });
      // The new card appearing in the list confirms the addition; toasts are
      // reserved for failures (docs/style-guide.md §10).
      onOpenChange(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: uiText("Could not add provider", undefined, undefined, uiLocale),
        description:
          error instanceof Error
            ? error.message
            : uiText("Update failed.", undefined, undefined, uiLocale),
      });
    }
  }, [
    driver,
    configByDriver,
    instanceId,
    instanceIdError,
    label,
    accentColor,
    onOpenChange,
    settings.providerInstances,
    updateSettings,
    uiLocale,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl overflow-hidden">
        <div className="flex min-h-0 flex-col overflow-hidden">
          <DialogHeader className="border-b border-border-subtle">
            <DialogTitle>{uiText("Add provider", undefined, undefined, uiLocale)}</DialogTitle>
            <DialogDescription>
              {uiText(
                "Add another account or install of a provider.",
                undefined,
                undefined,
                uiLocale,
              )}
            </DialogDescription>
            <div className="grid grid-cols-3 gap-2">
              {wizardSteps.map((step, index) => (
                <button
                  key={index}
                  type="button"
                  className={cn(
                    "focus-ring grid min-w-0 cursor-pointer grid-cols-[1rem_minmax(0,1fr)] gap-x-2 rounded-lg border px-3 py-2 text-left transition-colors duration-(--duration-fast)",
                    index === wizardStep
                      ? "border-primary bg-primary/10"
                      : index < wizardStep
                        ? "border-border bg-background hover:bg-accent"
                        : "border-border bg-muted/40 hover:bg-accent",
                  )}
                  onClick={() => goToStep(index)}
                >
                  <span
                    className={cn(
                      "row-span-2 mt-0.5 grid size-4 place-items-center rounded-full border",
                      index < wizardStep
                        ? "border-primary bg-primary text-primary-foreground"
                        : index === wizardStep
                          ? "border-primary bg-background"
                          : "border-border-strong bg-background",
                    )}
                    aria-hidden
                  >
                    {index < wizardStep ? <CheckIcon className="size-3" /> : null}
                  </span>
                  <span className="text-2xs text-subtle-foreground">
                    <UiMessage message={"Step <slot1></slot1>"} slots={{ slot1: index + 1 }} />
                  </span>
                  <span className="truncate text-xs font-semibold text-foreground">
                    {step}
                    {index < wizardStep && wizardStepSummaries[index]
                      ? `: ${wizardStepSummaries[index]}`
                      : ""}
                  </span>
                </button>
              ))}
            </div>
          </DialogHeader>

          <div data-slot="dialog-panel" className="space-y-4 px-6 py-5">
            <AnimatedHeight>
              <div className={cn("grid gap-2", wizardStep !== 0 && "hidden")}>
                <span
                  id="add-instance-driver-label"
                  className="text-xs font-medium text-foreground"
                >
                  {uiText("Provider", undefined, undefined, uiLocale)}
                </span>
                <RadioGroup
                  value={driver}
                  onValueChange={(value) => setDriver(ProviderDriverKind.make(value))}
                  aria-labelledby="add-instance-driver-label"
                  className="grid grid-cols-2 gap-2.5"
                >
                  {uiPresentation.DRIVER_OPTIONS.map((option) => {
                    const IconComponent = option.icon;
                    const isSelected = option.value === driver;
                    return (
                      <RadioPrimitive.Root
                        key={option.value}
                        value={option.value}
                        className={cn(
                          "relative flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-left outline-none transition-[background-color,border-color,box-shadow]",
                          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                          isSelected
                            ? "border-primary bg-background shadow-sm ring-2 ring-primary/35"
                            : "border-border bg-background hover:border-border-strong hover:bg-accent",
                        )}
                      >
                        <IconComponent className="size-5 shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                          {option.label}
                        </span>
                        {option.badgeLabel ? (
                          <Badge variant="warning" size="sm">
                            {option.badgeLabel}
                          </Badge>
                        ) : null}
                      </RadioPrimitive.Root>
                    );
                  })}
                </RadioGroup>
              </div>

              <label className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
                <span className="text-xs font-medium text-foreground">
                  <UiMessage
                    message={"Display name <slot1></slot1>"}
                    slots={{ slot1: <OptionalMark /> }}
                  />
                </span>
                <Input
                  className="bg-background"
                  placeholder={uiText("e.g. Work", undefined, undefined, uiLocale)}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>

              <label className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
                <span className="text-xs font-medium text-foreground">
                  {uiText("Instance ID", undefined, undefined, uiLocale)}
                </span>
                <Input
                  ref={instanceIdInputRef}
                  className="bg-background"
                  placeholder={uiText("{value0}_work", { value0: driver }, undefined, uiLocale)}
                  value={instanceId}
                  onChange={(event) => {
                    setInstanceIdDirty(true);
                    setInstanceIdDraft(event.target.value);
                  }}
                  aria-invalid={showInstanceIdError}
                  aria-describedby={
                    showInstanceIdError ? "add-provider-instance-id-error" : undefined
                  }
                />
                {showInstanceIdError ? (
                  <span
                    id="add-provider-instance-id-error"
                    role="alert"
                    className="text-xs text-destructive-foreground"
                  >
                    {instanceIdError}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {uiText(
                      "Internal ID: letters, digits, - or _.",
                      undefined,
                      undefined,
                      uiLocale,
                    )}
                  </span>
                )}
              </label>

              <div className={cn(wizardStep !== 1 && "hidden")}>
                <ProviderAccentColorPicker
                  label={
                    <>
                      {uiText("Accent color ", undefined, undefined, uiLocale)}
                      <OptionalMark />
                    </>
                  }
                  customColorLabel={uiText(
                    "Custom provider accent color",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
                  value={accentColor}
                  onCommit={setAccentColor}
                />
              </div>

              {driverSettingsFields.length > 0 ? (
                <div className={cn("grid gap-4", wizardStep !== 2 && "hidden")}>
                  <ProviderSettingsForm
                    definition={driverOption}
                    value={configDraft}
                    idPrefix={`add-provider-${driver}`}
                    variant="dialog"
                    hiddenFieldKeys={hiddenSettingsFieldKeys}
                    onChange={setConfigDraft}
                  />
                </div>
              ) : wizardStep === 2 ? (
                <div className="grid gap-2">
                  <p className="text-sm text-muted-foreground">
                    {uiText("No other settings needed.", undefined, undefined, uiLocale)}
                  </p>
                </div>
              ) : null}
            </AnimatedHeight>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (wizardStep === 0) {
                  onOpenChange(false);
                  return;
                }
                setWizardStep((step) => Math.max(0, step - 1));
              }}
            >
              {wizardStep === 0
                ? uiText("Cancel", undefined, undefined, uiLocale)
                : uiText("Back", undefined, undefined, uiLocale)}
            </Button>
            {wizardStep < wizardSteps.length - 1 ? (
              <Button size="sm" onClick={() => goToStep(Math.min(2, wizardStep + 1))}>
                {uiText("Next", undefined, undefined, uiLocale)}
              </Button>
            ) : (
              <Button size="sm" onClick={handleSave}>
                {uiText("Add provider", undefined, undefined, uiLocale)}
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = {
  DEFAULT_DRIVER_OPTION,
  DRIVER_OPTIONS,
  DRIVER_OPTION_BY_VALUE,
  validateInstanceId,
};
