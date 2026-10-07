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
  turn: "This turn only",
  session: "This provider session",
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
      setError("Complete the required fields using the requested values and limits.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onRespondToInteraction(requestId, validated);
    } catch {
      setError(
        "The response was not confirmed. You can retry the same response while this request is active.",
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
      setError("The authorization link is unavailable. It may have expired or been cancelled.");
    } finally {
      setBusy(false);
    }
  };
  const inputClass =
    "focus-ring w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm text-foreground";
  return (
    <section
      className="space-y-3 px-4 py-3 sm:px-5"
      aria-label="Provider interaction"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" && event.target instanceof HTMLInputElement)
          event.preventDefault();
      }}
    >
      <h3 className="text-sm font-medium text-foreground">
        {interaction.kind === "permissions"
          ? "Additional permissions requested"
          : `MCP server: ${interaction.serverName}`}
      </h3>
      <p className="whitespace-pre-wrap break-words text-sm">{interaction.message}</p>
      {interaction.kind === "permissions" ? (
        <>
          <p className="break-all text-xs text-muted-foreground">
            Working directory: <span className="font-mono">{interaction.cwd}</span>
            {interaction.environment ? ` · Environment: ${interaction.environment}` : ""}
          </p>
          <fieldset disabled={busy} className="space-y-2">
            <legend className="mb-1 text-xs text-muted-foreground">
              Choose the permissions to grant
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
              <span aria-hidden="true">Permission duration</span>
              <Select
                value={scope}
                disabled={busy}
                onValueChange={(next) => setScope(next === "session" ? "session" : "turn")}
              >
                <SelectTrigger aria-label="Permission duration">
                  <SelectValue>{PERMISSION_SCOPE_LABELS[scope]}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="turn">
                    {PERMISSION_SCOPE_LABELS.turn}
                  </SelectItem>
                  <SelectItem hideIndicator value="session">
                    {PERMISSION_SCOPE_LABELS.session}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>
          </fieldset>
        </>
      ) : interaction.mode === "url" ? (
        <div className="space-y-2">
          <p className="break-all text-sm">
            External destination: <strong>{interaction.urlOrigin}</strong>. Open only if you trust
            this server and destination.
          </p>
          {url ? (
            <a
              className="focus-ring rounded-sm text-sm text-primary underline underline-offset-4"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              Open authorization page
            </a>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled={busy || !onResolveInteractionUrl}
              onClick={() => void resolveUrl()}
            >
              Get authorization link
            </Button>
          )}
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            After completing the external step, confirm below.
            <InfoTip label="About the external step">
              Cafe doesn’t load or verify this page.
            </InfoTip>
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
                  {field.required ? " (required)" : " (optional)"}
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
                        { value: "true", label: "Yes" },
                        { value: "false", label: "No" },
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
                              <span className="text-muted-foreground">Choose a value</span>
                            )}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup alignItemWithTrigger={false}>
                          <SelectItem hideIndicator value="">
                            <span className="text-muted-foreground">Choose a value</span>
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
                    Allowed range: {field.minimum ?? "unbounded"} to {field.maximum ?? "unbounded"}
                  </p>
                ) : null}
                {field.minLength !== undefined || field.maxLength !== undefined ? (
                  <p className="text-xs text-muted-foreground">
                    Length: {field.minLength ?? 0}–{field.maxLength ?? 8192} characters
                  </p>
                ) : null}
                {field.minItems !== undefined || field.maxItems !== undefined ? (
                  <p className="text-xs text-muted-foreground">
                    Choose {field.minItems ?? 0}–{field.maxItems ?? 64} values
                  </p>
                ) : null}
              </div>
            );
          })}
        </fieldset>
      )}
      {!onRespondToInteraction ? (
        <p role="alert" className="text-sm">
          This environment does not support private interaction responses. Reconnect to an updated
          backend.
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
          Cancel request
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || !onRespondToInteraction}
          onClick={() => void submit("decline")}
        >
          Decline
        </Button>
        <Button
          type="button"
          disabled={busy || !onRespondToInteraction}
          onClick={() => void submit("accept")}
        >
          {interaction.kind === "permissions"
            ? "Grant selected permissions"
            : interaction.mode === "url"
              ? "I completed the external step"
              : "Submit response"}
        </Button>
      </div>
    </section>
  );
}
