import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import { useId, useState } from "react";
import type {
  ApprovalRequestId,
  ProviderInteraction,
  ProviderInteractionResponse,
} from "@cafecode/contracts";
import {
  getSafeInteractionUrl,
  validateInteractionResponse,
} from "@cafecode/shared/providerInteraction";
import { Button } from "../ui/button";
import { InfoTip } from "../ui/info-tip";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const PERMISSION_SCOPE_LABELS = {
  get turn() {
    return uiText("This turn only");
  },
  get session() {
    return uiText("This provider session");
  },
} as const;

export interface ComposerInteractionCallbacks {
  onRespondToInteraction?: (
    requestId: ApprovalRequestId,
    response: ProviderInteractionResponse,
  ) => Promise<void>;
  onResolveInteractionUrl?: (requestId: ApprovalRequestId) => Promise<string>;
}

/**
 * A deliberately small, non-recursive form renderer. Values stay in this
 * request-keyed component, never composer drafts, localStorage or timeline
 * commands. Provider text is plain React text, not Markdown/HTML or a URL.
 */
export function ComposerInteractionCard({
  requestId,
  interaction,
  onRespondToInteraction,
  onResolveInteractionUrl,
}: ComposerInteractionCallbacks & {
  requestId: ApprovalRequestId;
  interaction: ProviderInteraction;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const formId = useId();
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const [grantIds, setGrantIds] = useState<string[]>([]);
  const [scope, setScope] = useState<"turn" | "session">("turn");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const submit = async (action: ProviderInteractionResponse["action"]) => {
    if (busy || !onRespondToInteraction) return;
    let response: ProviderInteractionResponse = { action, content: null };
    if (action === "accept") {
      if (interaction.kind === "permissions") response = { action, grantIds, scope };
      else if (interaction.mode === "form") {
        const content: Record<string, string | number | boolean | string[]> = {};
        for (const field of interaction.fields) {
          const value = values[field.id];
          if (
            value === undefined ||
            (value === "" &&
              (field.type === "number" || field.type === "integer" || field.type === "boolean"))
          )
            continue;
          content[field.id] =
            field.type === "number" || field.type === "integer"
              ? Number(value)
              : field.type === "boolean"
                ? value === "true"
                : value;
        }
        response = { action, content };
      }
    }
    const validated = validateInteractionResponse(interaction, { __cafeInteraction: response });
    if (!validated) {
      setError(
        uiText(
          "Complete the required fields using the requested values and limits.",
          undefined,
          undefined,
          uiLocale,
        ),
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onRespondToInteraction(requestId, validated);
    } catch {
      setError(
        uiText(
          "The response was not confirmed. You can retry the same response while this request is active.",
          undefined,
          undefined,
          uiLocale,
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  const resolveUrl = async () => {
    if (
      busy ||
      !onResolveInteractionUrl ||
      interaction.kind !== "elicitation" ||
      interaction.mode !== "url"
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const resolved = getSafeInteractionUrl(await onResolveInteractionUrl(requestId));
      if (!resolved || new URL(resolved).origin !== interaction.urlOrigin)
        throw new Error("invalid");
      // A second explicit click follows a real anchor, avoiding async popup
      // blockers and keeping external navigation user-driven. The bearer URL
      // exists only in this mounted live card and is never shown as text.
      setUrl(resolved);
    } catch {
      setError(
        uiText(
          "The authorization link is unavailable. It may have expired or been cancelled.",
          undefined,
          undefined,
          uiLocale,
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  const inputClass =
    "focus-ring w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm text-foreground";
  return (
    <section
      className="space-y-3 px-4 py-3 sm:px-5"
      aria-label={uiText("Provider interaction", undefined, undefined, uiLocale)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" && event.target instanceof HTMLInputElement)
          event.preventDefault();
      }}
    >
      <h3 className="text-sm font-medium text-foreground">
        {interaction.kind === "permissions"
          ? uiText("Additional permissions requested", undefined, undefined, uiLocale)
          : uiText("MCP server: {value0}", { value0: interaction.serverName }, undefined, uiLocale)}
      </h3>
      <p className="whitespace-pre-wrap break-words text-sm">{interaction.message}</p>
      {interaction.kind === "permissions" ? (
        <>
          <p className="break-all text-xs text-muted-foreground">
            <UiMessage
              message={"Working directory: <slot1></slot1><slot3></slot3>"}
              slots={{
                slot1: <span className="font-mono">{interaction.cwd}</span>,
                slot3: interaction.environment
                  ? uiText(
                      " · Environment: {value0}",
                      { value0: interaction.environment },
                      undefined,
                      uiLocale,
                    )
                  : "",
              }}
            />
          </p>
          <fieldset disabled={busy} className="space-y-2">
            <legend className="mb-1 text-xs text-muted-foreground">
              {uiText("Choose the permissions to grant", undefined, undefined, uiLocale)}
            </legend>
            {interaction.grants.map((grant) => (
              <label key={grant.id} className="flex items-start gap-2 break-all text-sm">
                <input
                  type="checkbox"
                  checked={grantIds.includes(grant.id)}
                  onChange={(event) =>
                    setGrantIds((prior) =>
                      event.target.checked
                        ? [...prior, grant.id]
                        : prior.filter((id) => id !== grant.id),
                    )
                  }
                />
                {grant.label}
              </label>
            ))}
            <div className="space-y-1 text-sm">
              <span aria-hidden="true">
                {uiText("Permission duration", undefined, undefined, uiLocale)}
              </span>
              <Select
                value={scope}
                disabled={busy}
                onValueChange={(next) => setScope(next === "session" ? "session" : "turn")}
              >
                <SelectTrigger
                  aria-label={uiText("Permission duration", undefined, undefined, uiLocale)}
                >
                  <SelectValue>{uiPresentation.PERMISSION_SCOPE_LABELS[scope]}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="turn">
                    {uiPresentation.PERMISSION_SCOPE_LABELS.turn}
                  </SelectItem>
                  <SelectItem hideIndicator value="session">
                    {uiPresentation.PERMISSION_SCOPE_LABELS.session}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>
          </fieldset>
        </>
      ) : interaction.mode === "url" ? (
        <div className="space-y-2">
          <p className="break-all text-sm">
            <UiMessage
              message={
                "External destination: <slot1></slot1>. Open only if you trust this server and destination."
              }
              slots={{ slot1: <strong>{interaction.urlOrigin}</strong> }}
            />
          </p>
          {url ? (
            <a
              className="focus-ring rounded-sm text-sm text-primary underline underline-offset-4"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              {uiText("Open authorization page", undefined, undefined, uiLocale)}
            </a>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled={busy || !onResolveInteractionUrl}
              onClick={() => void resolveUrl()}
            >
              {uiText("Get authorization link", undefined, undefined, uiLocale)}
            </Button>
          )}
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <UiMessage
              message={"After completing the external step, confirm below.<slot1></slot1>"}
              slots={{
                slot1: (
                  <InfoTip
                    label={uiText("About the external step", undefined, undefined, uiLocale)}
                  >
                    {uiText(
                      "Cafe doesn’t load or verify this page.",
                      undefined,
                      undefined,
                      uiLocale,
                    )}
                  </InfoTip>
                ),
              }}
            />
          </p>
        </div>
      ) : (
        <fieldset disabled={busy} className="space-y-3">
          {interaction.fields.map((field, index) => {
            const id = `${formId}-${index}`;
            const value = values[field.id] ?? "";
            const set = (next: string | string[]) =>
              setValues((prior) => ({ ...prior, [field.id]: next }));
            return (
              <div key={field.id} className="space-y-1">
                <label htmlFor={id} className="text-sm font-medium">
                  {field.title}
                  {field.required
                    ? uiText(" (required)", undefined, undefined, uiLocale)
                    : uiText(" (optional)", undefined, undefined, uiLocale)}
                </label>
                {field.description ? (
                  <p className="text-xs text-muted-foreground">{field.description}</p>
                ) : null}
                {field.type === "array" ? (
                  <div id={id} role="group" aria-label={field.title}>
                    {field.options?.map((option) => (
                      <label key={option.value} className="flex gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={Array.isArray(value) && value.includes(option.value)}
                          onChange={(event) =>
                            set(
                              event.target.checked
                                ? [...(Array.isArray(value) ? value : []), option.value]
                                : (Array.isArray(value) ? value : []).filter(
                                    (item) => item !== option.value,
                                  ),
                            )
                          }
                        />
                        {option.label}
                      </label>
                    ))}
                  </div>
                ) : field.options || field.type === "boolean" ? (
                  (() => {
                    // Option indexes, not provider values, are the Select keys so
                    // arbitrary provider strings never become DOM identifiers.
                    const choices = (
                      field.options ?? [
                        { value: "true", label: uiText("Yes", undefined, undefined, uiLocale) },
                        { value: "false", label: uiText("No", undefined, undefined, uiLocale) },
                      ]
                    ).map((option, index) => ({
                      key: field.options ? String(index) : option.value,
                      label: option.label,
                    }));
                    const selectedKey = field.options
                      ? Object.hasOwn(values, field.id)
                        ? String(field.options.findIndex((option) => option.value === value))
                        : ""
                      : typeof value === "string"
                        ? value
                        : "";
                    return (
                      <Select
                        value={selectedKey}
                        onValueChange={(nextKey) => {
                          const selection = field.options
                            ? field.options[Number(nextKey)]?.value
                            : typeof nextKey === "string"
                              ? nextKey
                              : undefined;
                          if (nextKey === "" || nextKey === null || selection === undefined)
                            setValues((prior) => {
                              const next = { ...prior };
                              delete next[field.id];
                              return next;
                            });
                          else set(selection);
                        }}
                      >
                        <SelectTrigger id={id}>
                          <SelectValue>
                            {choices.find((choice) => choice.key === selectedKey)?.label ?? (
                              <span className="text-muted-foreground">
                                {uiText("Choose a value", undefined, undefined, uiLocale)}
                              </span>
                            )}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup alignItemWithTrigger={false}>
                          <SelectItem hideIndicator value="">
                            <span className="text-muted-foreground">
                              {uiText("Choose a value", undefined, undefined, uiLocale)}
                            </span>
                          </SelectItem>
                          {choices.map((choice) => (
                            <SelectItem hideIndicator key={choice.key} value={choice.key}>
                              {choice.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    );
                  })()
                ) : (
                  <input
                    id={id}
                    className={inputClass}
                    type={field.type === "number" || field.type === "integer" ? "number" : "text"}
                    step={field.type === "integer" ? 1 : "any"}
                    min={field.minimum}
                    max={field.maximum}
                    maxLength={field.maxLength ?? 8192}
                    autoComplete="off"
                    spellCheck={false}
                    value={typeof value === "string" ? value : ""}
                    onChange={(event) => set(event.target.value)}
                  />
                )}
                {field.minimum !== undefined || field.maximum !== undefined ? (
                  <p className="text-xs text-muted-foreground">
                    <UiMessage
                      message={"Allowed range: <slot1></slot1> to <slot3></slot3>"}
                      slots={{
                        slot1: field.minimum ?? uiText("unbounded", undefined, undefined, uiLocale),
                        slot3: field.maximum ?? uiText("unbounded", undefined, undefined, uiLocale),
                      }}
                    />
                  </p>
                ) : null}
                {field.minLength !== undefined || field.maxLength !== undefined ? (
                  <p className="text-xs text-muted-foreground">
                    <UiMessage
                      message={"Length: <slot1></slot1>–<slot3></slot3> characters"}
                      slots={{ slot1: field.minLength ?? 0, slot3: field.maxLength ?? 8192 }}
                    />
                  </p>
                ) : null}
                {field.minItems !== undefined || field.maxItems !== undefined ? (
                  <p className="text-xs text-muted-foreground">
                    <UiMessage
                      message={"Choose <slot1></slot1>–<slot3></slot3> values"}
                      slots={{ slot1: field.minItems ?? 0, slot3: field.maxItems ?? 64 }}
                    />
                  </p>
                ) : null}
              </div>
            );
          })}
        </fieldset>
      )}
      {!onRespondToInteraction ? (
        <p role="alert" className="text-sm">
          {uiText(
            "This environment does not support private interaction responses. Reconnect to an updated backend.",
            undefined,
            undefined,
            uiLocale,
          )}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={busy || !onRespondToInteraction}
          onClick={() => void submit("cancel")}
        >
          {uiText("Cancel request", undefined, undefined, uiLocale)}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || !onRespondToInteraction}
          onClick={() => void submit("decline")}
        >
          {uiText("Decline", undefined, undefined, uiLocale)}
        </Button>
        <Button
          type="button"
          disabled={busy || !onRespondToInteraction}
          onClick={() => void submit("accept")}
        >
          {interaction.kind === "permissions"
            ? uiText("Grant selected permissions", undefined, undefined, uiLocale)
            : interaction.mode === "url"
              ? uiText("I completed the external step", undefined, undefined, uiLocale)
              : uiText("Submit response", undefined, undefined, uiLocale)}
        </Button>
      </div>
    </section>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { PERMISSION_SCOPE_LABELS };
