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
  const inputClass = "w-full rounded border border-border bg-background px-2 py-1 text-sm";
  return (
    <section
      className="space-y-3 p-4"
      aria-label="Provider interaction"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" && event.target instanceof HTMLInputElement)
          event.preventDefault();
      }}
    >
      <h3 className="text-sm font-semibold">
        {interaction.kind === "permissions"
          ? "Additional permissions requested"
          : `MCP server: ${interaction.serverName}`}
      </h3>
      <p className="whitespace-pre-wrap break-words text-sm">{interaction.message}</p>
      {interaction.kind === "permissions" ? (
        <>
          <p className="break-all text-xs">
            Working directory: {interaction.cwd}
            {interaction.environment ? ` · Environment: ${interaction.environment}` : ""}
          </p>
          <fieldset disabled={busy} className="space-y-2">
            <legend className="text-xs">Select only the permissions you want to grant</legend>
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
            <label className="block text-sm">
              Permission duration
              <select
                aria-label="Permission duration"
                value={scope}
                className={inputClass}
                onChange={(event) =>
                  setScope(event.target.value === "session" ? "session" : "turn")
                }
              >
                <option value="turn">This turn only</option>
                <option value="session">This provider session</option>
              </select>
            </label>
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
              className="text-sm underline"
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
          <p className="text-xs text-muted-foreground">
            After completing the external step, confirm below. Cafe does not fetch or verify the
            page.
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
                  <select
                    id={id}
                    className={inputClass}
                    value={
                      field.options
                        ? Object.hasOwn(values, field.id)
                          ? String(field.options.findIndex((option) => option.value === value))
                          : ""
                        : typeof value === "string"
                          ? value
                          : ""
                    }
                    onChange={(event) => {
                      const selection = field.options
                        ? field.options[Number(event.target.value)]?.value
                        : event.target.value;
                      if (event.target.value === "" || selection === undefined)
                        setValues((prior) => {
                          const next = { ...prior };
                          delete next[field.id];
                          return next;
                        });
                      else set(selection);
                    }}
                  >
                    <option value="">Choose a value</option>
                    {(
                      field.options ?? [
                        { value: "true", label: "Yes" },
                        { value: "false", label: "No" },
                      ]
                    ).map((option, index) => (
                      <option
                        key={option.value}
                        value={field.options ? String(index) : option.value}
                      >
                        {option.label}
                      </option>
                    ))}
                  </select>
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
                  <p className="text-xs">
                    Allowed range: {field.minimum ?? "unbounded"} to {field.maximum ?? "unbounded"}
                  </p>
                ) : null}
                {field.minLength !== undefined || field.maxLength !== undefined ? (
                  <p className="text-xs">
                    Length: {field.minLength ?? 0}–{field.maxLength ?? 8192} characters
                  </p>
                ) : null}
                {field.minItems !== undefined || field.maxItems !== undefined ? (
                  <p className="text-xs">
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
        <p role="alert" className="text-sm text-destructive">
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
