"use client";

import { CheckIcon } from "lucide-react";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_LM_STUDIO_BASE_URL,
  ProviderInstanceId,
  ProviderDriverKind,
  validateLmStudioBaseUrl,
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
import { ProviderSettingsForm, deriveProviderSettingsFields } from "./ProviderSettingsForm";
import { AnimatedHeight } from "../AnimatedHeight";
import {
  buildProviderCreationConfig,
  deriveProviderCreationInstanceId,
  LM_STUDIO_LOCAL_DISPLAY_NAME,
  LM_STUDIO_PROVIDER_TEMPLATE_ID,
  type ProviderCreationTemplateId,
  validateProviderCreationInstanceId,
} from "./providerInstanceCreation";

const PROVIDER_ACCENT_SWATCHES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
] as const;

/**
 * Provider creation rules live in `providerInstanceCreation.ts` so the UI
 * and pure regression tests use the same behavior.
 */
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const DEFAULT_DRIVER_OPTION = DRIVER_OPTIONS[0]!;
const EMPTY_CONFIG_DRAFT: Record<string, unknown> = {};
const PROVIDER_CREATION_OPTIONS = [
  { ...DEFAULT_DRIVER_OPTION, templateId: DEFAULT_DRIVER_KIND },
  {
    ...DEFAULT_DRIVER_OPTION,
    templateId: LM_STUDIO_PROVIDER_TEMPLATE_ID,
    label: LM_STUDIO_LOCAL_DISPLAY_NAME,
    badgeLabel: "Local",
  },
  ...DRIVER_OPTIONS.slice(1).map((option) =>
    Object.assign({}, option, { templateId: option.value }),
  ),
] as const;

/**
 * Dialog state stays local until the final settings update.
 */
interface AddProviderInstanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTemplateId?: ProviderCreationTemplateId | undefined;
}

export function AddProviderInstanceDialog({
  open,
  onOpenChange,
  initialTemplateId,
}: AddProviderInstanceDialogProps) {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

  const [wizardStep, setWizardStep] = useState(0);
  const [templateId, setTemplateId] = useState<ProviderCreationTemplateId>(DEFAULT_DRIVER_KIND);
  const [driver, setDriver] = useState<ProviderDriverKind>(DEFAULT_DRIVER_KIND);
  const [label, setLabel] = useState("");
  const [accentColor, setAccentColor] = useState<string>("");
  const [instanceId, setInstanceId] = useState("");
  const [instanceIdDirty, setInstanceIdDirty] = useState(false);
  // Driver-specific config drafts keyed by driver so toggling between drivers
  // during the same dialog session does not lose in-progress input.
  const [configByTemplate, setConfigByTemplate] = useState<Record<string, Record<string, unknown>>>(
    {},
  );
  // Errors are suppressed until the user has tried to submit once. After that
  // they update live so fixing the problem clears the message in place.
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const wasOpenRef = useRef(false);

  const existingIds = useMemo(
    () => new Set(Object.keys(settings.providerInstances ?? {})),
    [settings.providerInstances],
  );

  // Reset the form every time the dialog opens so each creation starts
  // from a clean slate. A dedicated LM Studio setup action opens directly
  // on its endpoint step; Back still exposes identity and accent settings.
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    const nextTemplateId = initialTemplateId ?? DEFAULT_DRIVER_KIND;
    setTemplateId(nextTemplateId);
    setDriver(DEFAULT_DRIVER_KIND);
    setLabel("");
    setAccentColor("");
    setInstanceId("");
    setWizardStep(
      nextTemplateId === LM_STUDIO_PROVIDER_TEMPLATE_ID && !existingIds.has("lmstudio") ? 2 : 0,
    );
    setInstanceIdDirty(false);
    setConfigByTemplate({});
    setHasAttemptedSubmit(false);
  }, [existingIds, initialTemplateId, open]);

  // Auto-derive the instance id from driver + label until the user types
  // in the Instance ID field directly (after which they own its value).
  useEffect(() => {
    if (instanceIdDirty) return;
    setInstanceId(deriveProviderCreationInstanceId(templateId, driver, label));
  }, [driver, label, instanceIdDirty, templateId]);

  const driverOption = DRIVER_OPTION_BY_VALUE[driver] ?? DEFAULT_DRIVER_OPTION;
  const driverSettingsFields = useMemo(
    () => deriveProviderSettingsFields(driverOption),
    [driverOption],
  );
  const instanceIdError = validateProviderCreationInstanceId(instanceId, existingIds);
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;
  const previewLabel =
    label.trim() ||
    (templateId === LM_STUDIO_PROVIDER_TEMPLATE_ID
      ? LM_STUDIO_LOCAL_DISPLAY_NAME
      : `${driverOption.label} Workspace`);
  const wizardSteps = ["Driver", "Identity", "Config"] as const;
  const wizardStepSummaries = [
    templateId === LM_STUDIO_PROVIDER_TEMPLATE_ID
      ? LM_STUDIO_LOCAL_DISPLAY_NAME
      : driverOption.label,
    previewLabel,
    null,
  ] as const;

  const configDraft = configByTemplate[templateId] ?? EMPTY_CONFIG_DRAFT;
  const lmStudioBaseUrl =
    typeof configDraft.ossBaseUrl === "string"
      ? configDraft.ossBaseUrl
      : DEFAULT_LM_STUDIO_BASE_URL;
  const lmStudioBaseUrlError =
    templateId === LM_STUDIO_PROVIDER_TEMPLATE_ID ? validateLmStudioBaseUrl(lmStudioBaseUrl) : null;
  const showLmStudioBaseUrlError = hasAttemptedSubmit && lmStudioBaseUrlError !== null;
  const setConfigDraft = useCallback(
    (config: Record<string, unknown> | undefined) => {
      setConfigByTemplate((existing) => {
        const next = { ...existing };
        if (config === undefined || Object.keys(config).length === 0) {
          delete next[templateId];
        } else {
          next[templateId] = config;
        }
        return next;
      });
    },
    [templateId],
  );

  const handleSave = useCallback(() => {
    setHasAttemptedSubmit(true);
    if (instanceIdError !== null || lmStudioBaseUrlError !== null) return;

    const nextInstance = buildProviderCreationConfig({
      templateId,
      driver,
      label,
      accentColor,
      config: configByTemplate[templateId] ?? {},
    });
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
      toastManager.add({
        type: "success",
        title: "Provider instance added",
        description: `${previewLabel} instance '${instanceId}' was added.`,
      });
      onOpenChange(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not add provider instance",
        description: error instanceof Error ? error.message : "Update failed.",
      });
    }
  }, [
    driver,
    templateId,
    configByTemplate,
    instanceId,
    instanceIdError,
    lmStudioBaseUrlError,
    label,
    accentColor,
    previewLabel,
    onOpenChange,
    settings.providerInstances,
    updateSettings,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl overflow-hidden">
        <div className="flex min-h-0 flex-col overflow-hidden border-foreground/10 bg-background shadow-2xl">
          <DialogHeader className="border-b border-border/70 bg-background">
            <DialogTitle>Add provider instance</DialogTitle>
            <DialogDescription>
              Add a Codex, Claude, OpenCode, or LM Studio Local provider. Each provider has separate
              settings and routing.
            </DialogDescription>
            <div className="grid grid-cols-3 gap-2">
              {wizardSteps.map((step, index) => (
                <button
                  key={step}
                  type="button"
                  className={cn(
                    "grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-2 rounded-lg border px-3 py-2 text-left",
                    index === wizardStep
                      ? "border-primary bg-primary/10 ring-1 ring-primary/25"
                      : index < wizardStep
                        ? "border-border bg-background"
                        : "border-border bg-muted/40",
                  )}
                  onClick={() => setWizardStep(index)}
                >
                  <span
                    className={cn(
                      "row-span-2 mt-0.5 grid size-4 place-items-center rounded-full border",
                      index < wizardStep
                        ? "border-primary bg-primary text-primary-foreground"
                        : index === wizardStep
                          ? "border-primary bg-background"
                          : "border-muted-foreground/35 bg-background",
                    )}
                    aria-hidden
                  >
                    {index < wizardStep ? <CheckIcon className="size-3" /> : null}
                  </span>
                  <span className="text-[10px] font-medium uppercase text-muted-foreground">
                    Step {index + 1}
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

          <div
            data-slot="dialog-panel"
            className="space-y-4 border-b border-border/70 bg-muted/20 px-6 py-5"
          >
            <AnimatedHeight>
              <div className={cn("grid gap-2", wizardStep !== 0 && "hidden")}>
                <span
                  id="add-instance-driver-label"
                  className="text-xs font-medium text-foreground"
                >
                  Driver
                </span>
                <RadioGroup
                  value={templateId}
                  onValueChange={(value) => {
                    const nextTemplate = value as ProviderCreationTemplateId;
                    setTemplateId(nextTemplate);
                    setDriver(
                      nextTemplate === LM_STUDIO_PROVIDER_TEMPLATE_ID
                        ? DEFAULT_DRIVER_KIND
                        : ProviderDriverKind.make(value),
                    );
                  }}
                  aria-labelledby="add-instance-driver-label"
                  className="grid grid-cols-2 gap-2.5"
                >
                  {PROVIDER_CREATION_OPTIONS.map((option) => {
                    const IconComponent = option.icon;
                    const isSelected = option.templateId === templateId;
                    return (
                      <RadioPrimitive.Root
                        key={option.templateId}
                        value={option.templateId}
                        className={cn(
                          "relative flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-left outline-none transition-[background-color,border-color,box-shadow]",
                          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                          isSelected
                            ? "border-primary bg-background shadow-sm ring-2 ring-primary/35"
                            : "border-border bg-background hover:border-foreground/20 hover:bg-muted/50",
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
                <span className="text-xs font-medium text-foreground">Label</span>
                <Input
                  className="bg-background"
                  placeholder="e.g. Work"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
                <span className="text-[11px] text-muted-foreground">
                  Shown in the provider list. Optional.
                </span>
              </label>

              <label className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
                <span className="text-xs font-medium text-foreground">Instance ID</span>
                <Input
                  className="bg-background"
                  placeholder={
                    templateId === LM_STUDIO_PROVIDER_TEMPLATE_ID ? "lmstudio" : `${driver}_work`
                  }
                  value={instanceId}
                  onChange={(event) => {
                    setInstanceIdDirty(true);
                    setInstanceId(event.target.value);
                  }}
                  aria-invalid={showInstanceIdError}
                />
                {showInstanceIdError ? (
                  <span className="text-[11px] text-destructive">{instanceIdError}</span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">
                    Routing key used by threads and sessions. Letters, digits, '-', or '_'.
                  </span>
                )}
              </label>

              <div className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
                <span className="text-xs font-medium text-foreground">Accent color</span>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <input
                    type="color"
                    value={normalizeProviderAccentColor(accentColor) ?? PROVIDER_ACCENT_SWATCHES[0]}
                    onChange={(event) => setAccentColor(event.target.value)}
                    aria-label="Provider instance accent color"
                    className="h-8 w-10 cursor-pointer rounded-xl border border-input bg-background p-0.5"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {PROVIDER_ACCENT_SWATCHES.map((swatch) => {
                      const selected = accentColor.toLowerCase() === swatch;
                      return (
                        <button
                          key={swatch}
                          type="button"
                          className={cn(
                            "size-6 cursor-pointer rounded-full border transition",
                            selected
                              ? "scale-110 border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                              : "border-black/10 hover:scale-105 dark:border-white/20",
                          )}
                          style={{ backgroundColor: swatch }}
                          onClick={() => setAccentColor(swatch)}
                          aria-label={`Use ${swatch} accent`}
                        />
                      );
                    })}
                  </div>
                  {accentColor ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-muted-foreground"
                      onClick={() => setAccentColor("")}
                    >
                      Clear
                    </Button>
                  ) : null}
                </div>
                <span className="text-[11px] text-muted-foreground">
                  Optional marker shown in the picker.
                </span>
              </div>

              {templateId === LM_STUDIO_PROVIDER_TEMPLATE_ID && wizardStep === 2 ? (
                <div className="grid gap-4">
                  <div className="grid gap-2 rounded-lg border border-primary/25 bg-primary/5 p-3">
                    <p className="text-sm font-medium text-foreground">
                      LM Studio Local through Codex OSS
                    </p>
                    <p className="text-xs text-muted-foreground">
                      This creates a separate local provider. Start LM Studio&apos;s
                      OpenAI-compatible server. Load a chat model before you refresh the provider.
                    </p>
                  </div>
                  <label className="grid gap-1.5">
                    <span className="text-xs font-medium text-foreground">
                      LM Studio server URL
                    </span>
                    <Input
                      className="bg-background"
                      value={lmStudioBaseUrl}
                      onChange={(event) =>
                        setConfigDraft({ ...configDraft, ossBaseUrl: event.target.value })
                      }
                      placeholder={DEFAULT_LM_STUDIO_BASE_URL}
                      spellCheck={false}
                      aria-invalid={showLmStudioBaseUrlError}
                      aria-describedby={
                        showLmStudioBaseUrlError ? "add-lm-studio-base-url-error" : undefined
                      }
                    />
                    {showLmStudioBaseUrlError ? (
                      <span
                        id="add-lm-studio-base-url-error"
                        className="text-[11px] text-destructive"
                      >
                        {lmStudioBaseUrlError}
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">
                        Use loopback on this computer, a literal private LAN address, or an HTTPS
                        hostname. Cafe Code sends workspace context to this endpoint. Codex cannot
                        send an LM Studio API token.
                      </span>
                    )}
                  </label>
                </div>
              ) : driverSettingsFields.length > 0 ? (
                <div className={cn("grid gap-4", wizardStep !== 2 && "hidden")}>
                  <ProviderSettingsForm
                    definition={driverOption}
                    value={configDraft}
                    idPrefix={`add-provider-${driver}`}
                    variant="dialog"
                    onChange={setConfigDraft}
                  />
                </div>
              ) : wizardStep === 2 ? (
                <div className="grid gap-2">
                  <p className="text-sm text-muted-foreground">
                    This driver has no required configuration. You can add the instance now.
                  </p>
                </div>
              ) : null}
            </AnimatedHeight>
          </div>

          <DialogFooter className="border-t bg-background">
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
              {wizardStep === 0 ? "Cancel" : "Back"}
            </Button>
            {wizardStep < wizardSteps.length - 1 ? (
              <Button size="sm" onClick={() => setWizardStep((step) => Math.min(2, step + 1))}>
                Next
              </Button>
            ) : (
              <Button size="sm" onClick={handleSave}>
                Add instance
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
