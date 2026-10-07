"use client";

import { useMemo } from "react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type {
  ProviderSettingsFormAnnotation,
  ProviderSettingsFormControl,
  ProviderSettingsFormOption,
  ProviderSettingsFormSchemaAnnotation,
} from "@cafecode/contracts";

import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { InfoTip } from "../ui/info-tip";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import type { ProviderClientDefinition } from "./providerDriverMeta";

export interface ProviderSettingsFieldModel {
  readonly key: string;
  readonly control: ProviderSettingsFormControl;
  readonly label: string;
  readonly description?: string | undefined;
  /**
   * Secondary detail from the schema's `documentation` annotation: environment
   * variable names, version requirements and caveats. Rendered in an InfoTip
   * beside the label so the visible description stays one short line.
   */
  readonly detail?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly options?: ReadonlyArray<ProviderSettingsFormOption> | undefined;
  readonly clearWhenEmpty: "omit" | "persist";
  readonly defaultBooleanValue?: boolean | undefined;
  readonly defaultStringValue?: string | undefined;
  readonly defaultNumberValue?: number | undefined;
  readonly step?: number | undefined;
  readonly minimum?: number | undefined;
  readonly maximum?: number | undefined;
  readonly integerOnly?: boolean | undefined;
}

function titleizeFieldKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (char) => char.toUpperCase());
}

function readFieldAnnotations(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
) {
  return Schema.resolveAnnotationsKey(fieldSchema) ?? Schema.resolveAnnotations(fieldSchema);
}

function readFieldAnnotationString(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
  key: "title" | "description" | "documentation",
): string | undefined {
  const annotations = readFieldAnnotations(fieldSchema);
  const value = annotations?.[key];
  return typeof value === "string" ? value : undefined;
}

function readProviderSettingsFormAnnotation(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
): ProviderSettingsFormAnnotation {
  const annotation = readFieldAnnotations(fieldSchema)?.providerSettingsForm;
  return annotation ?? {};
}

function readProviderSettingsFormSchemaAnnotation(
  definition: ProviderClientDefinition,
): ProviderSettingsFormSchemaAnnotation {
  return Schema.resolveAnnotations(definition.settingsSchema)?.providerSettingsFormSchema ?? {};
}

function readFieldBooleanDefault(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
): boolean | undefined {
  const decodeDefault = Schema.decodeUnknownOption(fieldSchema as Schema.Decoder<unknown>);
  const decoded = decodeDefault(undefined);
  return Option.isSome(decoded) && typeof decoded.value === "boolean" ? decoded.value : undefined;
}

function readFieldStringDefault(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
): string | undefined {
  const decodeDefault = Schema.decodeUnknownOption(fieldSchema as Schema.Decoder<unknown>);
  const decoded = decodeDefault(undefined);
  return Option.isSome(decoded) && typeof decoded.value === "string" ? decoded.value : undefined;
}

function readFieldNumberDefault(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
): number | undefined {
  const decodeDefault = Schema.decodeUnknownOption(fieldSchema as Schema.Decoder<unknown>);
  const decoded = decodeDefault(undefined);
  return Option.isSome(decoded) && typeof decoded.value === "number" ? decoded.value : undefined;
}

export function deriveProviderSettingsFields(
  definition: ProviderClientDefinition,
): ReadonlyArray<ProviderSettingsFieldModel> {
  const schemaAnnotation = readProviderSettingsFormSchemaAnnotation(definition);
  const orderedKeys = new Map(
    (schemaAnnotation.order ?? []).map((key, index) => [key, index] as const),
  );
  const orderFallbackOffset = orderedKeys.size;

  return Object.keys(definition.settingsSchema.fields)
    .map((key, index) => ({ key, index }))
    .toSorted((left, right) => {
      return (
        (orderedKeys.get(left.key) ?? orderFallbackOffset + left.index) -
        (orderedKeys.get(right.key) ?? orderFallbackOffset + right.index)
      );
    })
    .flatMap(({ key }) => {
      const fieldSchema = definition.settingsSchema.fields[key]!;
      const formAnnotation = readProviderSettingsFormAnnotation(fieldSchema);
      if (formAnnotation.hidden) return [];

      const annotatedTitle = readFieldAnnotationString(fieldSchema, "title");
      const annotatedDescription = readFieldAnnotationString(fieldSchema, "description");
      const annotatedDetail = readFieldAnnotationString(fieldSchema, "documentation");
      const control = formAnnotation.control ?? "text";
      return [
        {
          key,
          control,
          label: annotatedTitle ?? titleizeFieldKey(key),
          ...(annotatedDescription !== undefined ? { description: annotatedDescription } : {}),
          ...(annotatedDetail !== undefined ? { detail: annotatedDetail } : {}),
          ...(formAnnotation.placeholder !== undefined
            ? { placeholder: formAnnotation.placeholder }
            : {}),
          ...(formAnnotation.options !== undefined ? { options: formAnnotation.options } : {}),
          clearWhenEmpty: formAnnotation.clearWhenEmpty ?? "omit",
          ...(formAnnotation.control === "switch"
            ? { defaultBooleanValue: readFieldBooleanDefault(fieldSchema) }
            : {}),
          // Text defaults are read only to tell customized values apart from
          // decoded defaults (e.g. a binary path of "codex"); writes still
          // treat select defaults alone as "empty".
          ...(control === "select" || control === "text"
            ? { defaultStringValue: readFieldStringDefault(fieldSchema) }
            : {}),
          ...(formAnnotation.control === "number"
            ? {
                defaultNumberValue: readFieldNumberDefault(fieldSchema),
                ...(formAnnotation.step !== undefined ? { step: formAnnotation.step } : {}),
                ...(formAnnotation.minimum !== undefined
                  ? { minimum: formAnnotation.minimum }
                  : {}),
                ...(formAnnotation.maximum !== undefined
                  ? { maximum: formAnnotation.maximum }
                  : {}),
                ...(formAnnotation.integerOnly !== undefined
                  ? { integerOnly: formAnnotation.integerOnly }
                  : {}),
              }
            : {}),
        } satisfies ProviderSettingsFieldModel,
      ];
    });
}

export function readProviderConfigString(config: unknown, key: string): string {
  if (config === null || typeof config !== "object") return "";
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

export function readProviderConfigBoolean(
  config: unknown,
  key: string,
  defaultValue = false,
): boolean {
  if (config === null || typeof config !== "object") return defaultValue;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : defaultValue;
}

export function readProviderConfigNumber(
  config: unknown,
  key: string,
  defaultValue: number,
): number {
  if (config === null || typeof config !== "object") return defaultValue;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : defaultValue;
}

function readOptionalProviderConfigNumber(config: unknown, key: string): number | undefined {
  if (config === null || typeof config !== "object") return undefined;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function nextProviderConfigWithFieldValue(
  config: unknown,
  field: ProviderSettingsFieldModel,
  value: string | boolean,
): Record<string, unknown> | undefined {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};

  if (typeof value === "boolean") {
    const emptyBooleanValue = field.defaultBooleanValue ?? false;
    if (field.clearWhenEmpty === "omit" && value === emptyBooleanValue) {
      delete base[field.key];
    } else {
      base[field.key] = value;
    }
    return Object.keys(base).length > 0 ? base : undefined;
  }

  if (field.control === "number") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      if (field.clearWhenEmpty === "omit") {
        delete base[field.key];
      }
      return Object.keys(base).length > 0 ? base : undefined;
    }

    const parsed = Number(trimmed);
    // Safe integers are required here, rather than merely integral numbers,
    // so browser input cannot silently round an out-of-range integer setting
    // before it crosses the settings persistence boundary.
    const violatesIntegerConstraint = field.integerOnly === true && !Number.isSafeInteger(parsed);
    const violatesMinimum = field.minimum !== undefined && parsed < field.minimum;
    const violatesMaximum = field.maximum !== undefined && parsed > field.maximum;
    if (
      !Number.isFinite(parsed) ||
      violatesIntegerConstraint ||
      violatesMinimum ||
      violatesMaximum
    ) {
      // Reject values that violate this field's schema-derived form
      // constraints; leave any prior stored value untouched.
      return Object.keys(base).length > 0 ? base : undefined;
    }

    if (
      field.clearWhenEmpty === "omit" &&
      field.defaultNumberValue !== undefined &&
      parsed === field.defaultNumberValue
    ) {
      delete base[field.key];
    } else {
      base[field.key] = parsed;
    }
    return Object.keys(base).length > 0 ? base : undefined;
  }

  const trimmed = value.trim();
  const redactedFlag = `${field.key}Redacted`;
  if (field.control === "password" && trimmed.length > 0) {
    base[field.key] = value;
    base[redactedFlag] = false;
    return base;
  }
  if (field.control === "password" && base[redactedFlag] === true) {
    return base;
  }
  if (
    field.clearWhenEmpty === "omit" &&
    (trimmed.length === 0 ||
      (field.control === "select" &&
        field.defaultStringValue !== undefined &&
        trimmed === field.defaultStringValue))
  ) {
    delete base[field.key];
  } else {
    base[field.key] = value;
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

function clearProviderConfigPassword(
  config: unknown,
  field: ProviderSettingsFieldModel,
): Record<string, unknown> | undefined {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};
  delete base[field.key];
  base[`${field.key}Redacted`] = false;
  return Object.keys(base).length > 0 ? base : undefined;
}

/**
 * Whether `config` stores a value for `field` that differs from its decoded
 * default. Collapsed runtime sections use this to say how many values are
 * customized, so configured settings stay discoverable without expanding.
 */
export function isProviderSettingCustomized(
  config: unknown,
  field: ProviderSettingsFieldModel,
): boolean {
  if (config === null || typeof config !== "object") return false;
  const record = config as Record<string, unknown>;
  const value = record[field.key];
  switch (field.control) {
    case "switch":
      return typeof value === "boolean" && value !== (field.defaultBooleanValue ?? false);
    case "number":
      return (
        typeof value === "number" && Number.isFinite(value) && value !== field.defaultNumberValue
      );
    case "password":
      return (
        record[`${field.key}Redacted`] === true ||
        (typeof value === "string" && value.trim().length > 0)
      );
    default: {
      if (typeof value !== "string") return false;
      const trimmed = value.trim();
      return trimmed.length > 0 && trimmed !== (field.defaultStringValue ?? "");
    }
  }
}

interface ProviderSettingsFormProps {
  readonly definition: ProviderClientDefinition;
  readonly value: unknown;
  readonly idPrefix: string;
  readonly variant: "card" | "dialog";
  /**
   * Field keys to leave out of the form, e.g. a platform-specific setting the
   * current server cannot use. Hidden fields keep their stored values.
   */
  readonly hiddenFieldKeys?: ReadonlySet<string> | undefined;
  readonly onChange: (nextConfig: Record<string, unknown> | undefined) => void;
}

interface ProviderSettingsFieldRowProps {
  readonly field: ProviderSettingsFieldModel;
  readonly value: unknown;
  readonly idPrefix: string;
  readonly variant: ProviderSettingsFormProps["variant"];
  readonly onChange: ProviderSettingsFormProps["onChange"];
}

const FIELD_LABEL_CLASS_NAME = "text-xs font-medium text-foreground";

/**
 * Field label plus an optional InfoTip for the schema's secondary detail. The
 * InfoTip sits outside the `<label>` (or labelling span) on purpose: a button
 * inside it would otherwise become part of the control's accessible name.
 */
function FieldLabel(props: {
  readonly field: ProviderSettingsFieldModel;
  readonly htmlFor?: string | undefined;
  readonly id?: string | undefined;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      {props.htmlFor !== undefined ? (
        <label htmlFor={props.htmlFor} className={FIELD_LABEL_CLASS_NAME}>
          {props.field.label}
        </label>
      ) : (
        <span id={props.id} className={FIELD_LABEL_CLASS_NAME}>
          {props.field.label}
        </span>
      )}
      {props.field.detail ? (
        <InfoTip label={`About ${props.field.label}`}>{props.field.detail}</InfoTip>
      ) : null}
    </div>
  );
}

function ProviderSettingsFieldRow({
  field,
  value,
  idPrefix,
  variant,
  onChange,
}: ProviderSettingsFieldRowProps) {
  const inputId = `${idPrefix}-${field.key}`;
  const descriptionId = field.description ? `${inputId}-description` : undefined;
  // The add dialog sits on a muted panel, so its inputs need their own surface.
  const inputClassName = variant === "dialog" ? "bg-background" : undefined;
  const description = field.description ? (
    <p id={descriptionId} className="text-xs text-muted-foreground">
      {field.description}
    </p>
  ) : null;

  if (field.control === "switch") {
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="grid min-w-0 gap-0.5">
          <FieldLabel field={field} />
          {description}
        </div>
        <Switch
          checked={readProviderConfigBoolean(value, field.key, field.defaultBooleanValue)}
          onCheckedChange={(checked) =>
            onChange(nextProviderConfigWithFieldValue(value, field, Boolean(checked)))
          }
          aria-label={field.label}
          aria-describedby={descriptionId}
        />
      </div>
    );
  }

  if (field.control === "textarea") {
    return (
      <div className="grid gap-1.5">
        <FieldLabel field={field} htmlFor={inputId} />
        <Textarea
          id={inputId}
          className={inputClassName}
          aria-describedby={descriptionId}
          value={readProviderConfigString(value, field.key)}
          onChange={(event) =>
            onChange(nextProviderConfigWithFieldValue(value, field, event.target.value))
          }
          placeholder={field.placeholder}
          spellCheck={false}
        />
        {description}
      </div>
    );
  }

  if (field.control === "number") {
    const currentValue = String(
      readOptionalProviderConfigNumber(value, field.key) ?? field.defaultNumberValue ?? "",
    );

    return (
      <div className="grid gap-1.5">
        <FieldLabel field={field} htmlFor={inputId} />
        {variant === "card" ? (
          <DraftInput
            id={inputId}
            type="number"
            step={field.step ?? 1}
            min={field.minimum}
            max={field.maximum}
            aria-describedby={descriptionId}
            value={currentValue}
            onCommit={(next) => onChange(nextProviderConfigWithFieldValue(value, field, next))}
            placeholder={field.placeholder}
          />
        ) : (
          <Input
            id={inputId}
            className={inputClassName}
            type="number"
            step={field.step ?? 1}
            min={field.minimum}
            max={field.maximum}
            aria-describedby={descriptionId}
            value={currentValue}
            onChange={(event) =>
              onChange(nextProviderConfigWithFieldValue(value, field, event.target.value))
            }
            placeholder={field.placeholder}
          />
        )}
        {description}
      </div>
    );
  }

  if (field.control === "select") {
    const options = field.options ?? [];
    const currentValue =
      readProviderConfigString(value, field.key) ||
      field.defaultStringValue ||
      options[0]?.value ||
      "";

    return (
      <div className="grid gap-1.5">
        <FieldLabel field={field} id={inputId} />
        <Select
          modal={false}
          value={currentValue}
          onValueChange={(next) => {
            if (next !== null) {
              onChange(nextProviderConfigWithFieldValue(value, field, next));
            }
          }}
          items={options}
        >
          <SelectTrigger
            aria-labelledby={inputId}
            aria-describedby={descriptionId}
            className={inputClassName}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate">{option.label}</span>
                  {option.description ? (
                    <span className="whitespace-normal text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {description}
      </div>
    );
  }

  const type = field.control === "password" ? "password" : undefined;
  const passwordRedacted =
    field.control === "password" && readProviderConfigBoolean(value, `${field.key}Redacted`);
  const placeholder = passwordRedacted
    ? "Saved. Type a new value to replace it."
    : field.placeholder;
  return (
    <div className="grid gap-1.5">
      <FieldLabel field={field} htmlFor={inputId} />
      {variant === "card" ? (
        <DraftInput
          id={inputId}
          type={type}
          autoComplete={field.control === "password" ? "off" : undefined}
          aria-describedby={descriptionId}
          value={readProviderConfigString(value, field.key)}
          onCommit={(next) => onChange(nextProviderConfigWithFieldValue(value, field, next))}
          placeholder={placeholder}
          spellCheck={false}
        />
      ) : (
        <Input
          id={inputId}
          className={inputClassName}
          type={type}
          autoComplete={field.control === "password" ? "off" : undefined}
          aria-describedby={descriptionId}
          value={readProviderConfigString(value, field.key)}
          onChange={(event) =>
            onChange(nextProviderConfigWithFieldValue(value, field, event.target.value))
          }
          placeholder={placeholder}
          spellCheck={false}
        />
      )}
      {description}
      {passwordRedacted ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="justify-self-start text-muted-foreground"
          onClick={() => onChange(clearProviderConfigPassword(value, field))}
        >
          Clear saved password
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Schema-driven provider config fields. Renders the fields as siblings so the
 * caller owns their layout: the instance dialog stacks them inside its
 * collapsed Advanced section, the add dialog inside its wizard step.
 */
export function ProviderSettingsForm({
  definition,
  value,
  idPrefix,
  variant,
  hiddenFieldKeys,
  onChange,
}: ProviderSettingsFormProps) {
  const fields = useMemo(() => deriveProviderSettingsFields(definition), [definition]);
  const visibleFields = hiddenFieldKeys
    ? fields.filter((field) => !hiddenFieldKeys.has(field.key))
    : fields;

  if (visibleFields.length === 0) {
    return null;
  }

  return (
    <>
      {visibleFields.map((field) => (
        <ProviderSettingsFieldRow
          key={field.key}
          field={field}
          value={value}
          idPrefix={idPrefix}
          variant={variant}
          onChange={onChange}
        />
      ))}
    </>
  );
}
