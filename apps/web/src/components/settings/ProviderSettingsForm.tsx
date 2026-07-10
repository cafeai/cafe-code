"use client";

import { useMemo, type ReactNode } from "react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type {
  ProviderSettingsFormAnnotation,
  ProviderSettingsFormControl,
  ProviderSettingsFormOption,
  ProviderSettingsFormSchemaAnnotation,
} from "@cafecode/contracts";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
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
  readonly placeholder?: string | undefined;
  readonly options?: ReadonlyArray<ProviderSettingsFormOption> | undefined;
  readonly clearWhenEmpty: "omit" | "persist";
  readonly defaultBooleanValue?: boolean | undefined;
  readonly defaultStringValue?: string | undefined;
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
  key: "title" | "description",
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
      return [
        {
          key,
          control: formAnnotation.control ?? "text",
          label: annotatedTitle ?? titleizeFieldKey(key),
          ...(annotatedDescription !== undefined ? { description: annotatedDescription } : {}),
          ...(formAnnotation.placeholder !== undefined
            ? { placeholder: formAnnotation.placeholder }
            : {}),
          ...(formAnnotation.options !== undefined ? { options: formAnnotation.options } : {}),
          clearWhenEmpty: formAnnotation.clearWhenEmpty ?? "omit",
          ...(formAnnotation.control === "switch"
            ? { defaultBooleanValue: readFieldBooleanDefault(fieldSchema) }
            : {}),
          ...(formAnnotation.control === "select"
            ? { defaultStringValue: readFieldStringDefault(fieldSchema) }
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

interface ProviderSettingsFormProps {
  readonly definition: ProviderClientDefinition;
  readonly value: unknown;
  readonly idPrefix: string;
  readonly variant: "card" | "dialog";
  readonly onChange: (nextConfig: Record<string, unknown> | undefined) => void;
}

function FieldFrame(props: {
  readonly variant: ProviderSettingsFormProps["variant"];
  readonly children: ReactNode;
}) {
  if (props.variant === "card") {
    return <div className="border-t border-border/60 px-4 py-3 sm:px-5">{props.children}</div>;
  }
  return <div className="grid gap-1.5">{props.children}</div>;
}

interface ProviderSettingsFieldRowProps {
  readonly field: ProviderSettingsFieldModel;
  readonly value: unknown;
  readonly idPrefix: string;
  readonly variant: ProviderSettingsFormProps["variant"];
  readonly onChange: ProviderSettingsFormProps["onChange"];
}

function ProviderSettingsFieldRow({
  field,
  value,
  idPrefix,
  variant,
  onChange,
}: ProviderSettingsFieldRowProps) {
  const inputId = `${idPrefix}-${field.key}`;
  const descriptionClassName =
    variant === "card"
      ? "mt-1 block text-xs text-muted-foreground"
      : "text-[11px] text-muted-foreground";
  const label = <span className="text-xs font-medium text-foreground">{field.label}</span>;
  const description = field.description ? (
    <span className={descriptionClassName}>{field.description}</span>
  ) : null;

  if (field.control === "switch") {
    return (
      <FieldFrame variant={variant}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {label}
            {description}
          </div>
          <Switch
            checked={readProviderConfigBoolean(value, field.key, field.defaultBooleanValue)}
            onCheckedChange={(checked) =>
              onChange(nextProviderConfigWithFieldValue(value, field, Boolean(checked)))
            }
            aria-label={field.label}
          />
        </div>
      </FieldFrame>
    );
  }

  if (field.control === "textarea") {
    return (
      <FieldFrame variant={variant}>
        <label htmlFor={inputId} className={cn(variant === "card" && "block")}>
          {label}
          <Textarea
            id={inputId}
            className={cn(variant === "card" && "mt-1.5")}
            value={readProviderConfigString(value, field.key)}
            onChange={(event) =>
              onChange(nextProviderConfigWithFieldValue(value, field, event.target.value))
            }
            placeholder={field.placeholder}
            spellCheck={false}
          />
          {description}
        </label>
      </FieldFrame>
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
      <FieldFrame variant={variant}>
        <div className={cn(variant === "card" && "block")}>
          <span id={inputId}>{label}</span>
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
              className={cn(variant === "card" ? "mt-1.5" : "bg-background")}
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
      </FieldFrame>
    );
  }

  const type = field.control === "password" ? "password" : undefined;
  const passwordRedacted =
    field.control === "password" && readProviderConfigBoolean(value, `${field.key}Redacted`);
  const placeholder = passwordRedacted
    ? "Stored secret - enter a new value to replace"
    : field.placeholder;
  return (
    <FieldFrame variant={variant}>
      <div className={cn(variant === "card" && "block")}>
        <label htmlFor={inputId}>
          {label}
          {variant === "card" ? (
            <DraftInput
              id={inputId}
              className="mt-1.5"
              type={type}
              autoComplete={field.control === "password" ? "off" : undefined}
              value={readProviderConfigString(value, field.key)}
              onCommit={(next) => onChange(nextProviderConfigWithFieldValue(value, field, next))}
              placeholder={placeholder}
              spellCheck={false}
            />
          ) : (
            <Input
              id={inputId}
              className="bg-background"
              type={type}
              autoComplete={field.control === "password" ? "off" : undefined}
              value={readProviderConfigString(value, field.key)}
              onChange={(event) =>
                onChange(nextProviderConfigWithFieldValue(value, field, event.target.value))
              }
              placeholder={placeholder}
              spellCheck={false}
            />
          )}
        </label>
        {passwordRedacted ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="mt-1 h-6 px-1.5 text-[11px] text-muted-foreground"
            onClick={() => onChange(clearProviderConfigPassword(value, field))}
          >
            Clear stored password
          </Button>
        ) : null}
        {description}
      </div>
    </FieldFrame>
  );
}

export function ProviderSettingsForm({
  definition,
  value,
  idPrefix,
  variant,
  onChange,
}: ProviderSettingsFormProps) {
  const fields = useMemo(() => deriveProviderSettingsFields(definition), [definition]);

  if (fields.length === 0) {
    return null;
  }

  return (
    <>
      {fields.map((field) => (
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
