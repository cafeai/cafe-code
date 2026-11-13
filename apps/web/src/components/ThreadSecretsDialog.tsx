/**
 * Per-chat Cafe Secrets manager.
 *
 * Security boundary: the server list never returns values. A value enters
 * this component's local state only after an explicit Reveal, Copy or Edit
 * action, and is dropped when hidden, when the dialog closes, or when its
 * owner (exact environment/thread + open generation) changes. Values never go
 * to a global store, browser storage, logs or debug telemetry, and failure
 * text is fixed Cafe copy rather than received error prose.
 */
import type { ThreadSecretMetadata } from "@cafecode/contracts";
import { uiText } from "@cafecode/shared/i18n";
import {
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { readThreadSecretsApi, type ThreadSecretsApiHandle } from "~/cafeSecrets/cafeSecretsClient";
import { useThreadSecretsDialogStore } from "~/cafeSecrets/threadSecretsDialogStore";
import { notifyCafeSecretsChanged } from "~/cafeSecrets/changes";
import { useUiLocale } from "~/i18n";
import { copyTextToClipboard } from "~/lib/copyToClipboard";
import { readLocalApi } from "~/localApi";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type Target = NonNullable<ReturnType<typeof useThreadSecretsDialogStore.getState>["target"]>;

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "unsupported" }
  | { readonly phase: "error" }
  | { readonly phase: "ready"; readonly secrets: readonly ThreadSecretMetadata[] };

type Editor =
  | { readonly mode: "add" }
  | { readonly mode: "edit"; readonly secret: ThreadSecretMetadata }
  | null;

const MASK = "••••••••••";
const LABEL_MAX_LENGTH = 160;

type ConfirmDestructive = (message: string) => Promise<boolean>;
type WriteClipboardText = (value: string) => Promise<void>;

/**
 * Thrown inside an action when its owner retired across an await (dialog
 * closed/replaced, or the environment's connection-owned API changed). It is
 * swallowed silently: a retired continuation must not reveal, copy, write or
 * report anything.
 */
class RetiredSecretsAction extends Error {}

/** Native confirmation; an unavailable local API never confirms. */
const confirmWithLocalApi: ConfirmDestructive = async (message) =>
  (await readLocalApi()?.dialogs.confirm(message)) ?? false;

/** Mounted once in the app shell; renders nothing until a chat opens it. */
export function ThreadSecretsDialogHost({
  confirm = confirmWithLocalApi,
  copyText = copyTextToClipboard,
}: {
  readonly confirm?: ConfirmDestructive;
  readonly copyText?: WriteClipboardText;
} = {}) {
  const target = useThreadSecretsDialogStore((state) => state.target);
  const close = useThreadSecretsDialogStore((state) => state.close);
  if (!target) return null;
  // Keying by the open generation discards every revealed value and pending
  // continuation from a previous chat/opening.
  return (
    <ThreadSecretsDialog
      key={target.generation}
      target={target}
      onClose={close}
      confirm={confirm}
      copyText={copyText}
    />
  );
}

export function ThreadSecretsDialog({
  target,
  onClose,
  confirm = confirmWithLocalApi,
  copyText = copyTextToClipboard,
}: {
  readonly target: Target;
  readonly onClose: () => void;
  readonly confirm?: ConfirmDestructive;
  readonly copyText?: WriteClipboardText;
}) {
  const uiLocale = useUiLocale();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const api = readThreadSecretsApi(target.environmentId);
  const [state, setState] = useState<LoadState>(
    api ? { phase: "loading" } : { phase: "unsupported" },
  );
  const [revealed, setRevealed] = useState<ReadonlyMap<string, string>>(new Map());
  const [busyId, setBusyId] = useState<string | null>(null);
  // Synchronous reservation: two activations in one render tick both see the
  // same stale `busyId`, so only this ref can admit exactly one action.
  const busyRef = useRef<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor>(null);

  /**
   * True only while this exact dialog instance is mounted and the
   * environment still exposes the same connection-owned API that started the
   * operation. The host keys the dialog by open generation, so a different
   * chat/opening always unmounts this instance.
   */
  const ownsApi = useCallback(
    (owner: ThreadSecretsApiHandle) =>
      mountedRef.current && readThreadSecretsApi(target.environmentId) === owner,
    [target.environmentId],
  );

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const result = await api.list({ threadId: target.threadId });
      if (ownsApi(api)) setState({ phase: "ready", secrets: result.secrets });
    } catch {
      if (ownsApi(api)) setState({ phase: "error" });
    }
  }, [api, ownsApi, target.threadId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const forget = (id: string) =>
    setRevealed((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });

  /**
   * One action at a time per dialog. The action receives its exact API owner
   * and a `fence` it must call after every await, before any reveal,
   * clipboard, mutation or state side effect.
   */
  const runAction = async (
    id: string,
    action: (owner: ThreadSecretsApiHandle, fence: () => void) => Promise<void>,
    failure: string,
  ) => {
    const owner = api;
    if (!owner || busyRef.current !== null) return;
    busyRef.current = id;
    setBusyId(id);
    setActionError(null);
    const fence = () => {
      if (!ownsApi(owner)) throw new RetiredSecretsAction();
    };
    try {
      await action(owner, fence);
    } catch (error) {
      if (!(error instanceof RetiredSecretsAction) && ownsApi(owner)) setActionError(failure);
    } finally {
      if (busyRef.current === id) busyRef.current = null;
      if (mountedRef.current) setBusyId(null);
    }
  };

  const reveal = (secret: ThreadSecretMetadata) => {
    if (revealed.has(secret.id)) {
      forget(secret.id);
      return;
    }
    void runAction(
      secret.id,
      async (owner, fence) => {
        const { value } = await owner.reveal({ threadId: target.threadId, id: secret.id });
        fence();
        setRevealed((current) => new Map(current).set(secret.id, value));
      },
      uiText("The secret could not be revealed. Try again.", undefined, undefined, uiLocale),
    );
  };

  const copy = (secret: ThreadSecretMetadata) => {
    const shown = revealed.get(secret.id);
    void runAction(
      secret.id,
      async (owner, fence) => {
        // Copy fetches its own value and does not reveal it on screen.
        const value =
          shown ?? (await owner.reveal({ threadId: target.threadId, id: secret.id })).value;
        fence();
        await copyText(value);
        fence();
        setCopiedId(secret.id);
        window.setTimeout(() => {
          if (mountedRef.current)
            setCopiedId((current) => (current === secret.id ? null : current));
        }, 1500);
      },
      uiText("The secret could not be copied. Try again.", undefined, undefined, uiLocale),
    );
  };

  const remove = (secret: ThreadSecretMetadata) => {
    void runAction(
      secret.id,
      async (owner, fence) => {
        const confirmed = await confirm(
          uiText(
            "Remove this secret?\nMessages that already reference it will no longer resolve to its value.",
            undefined,
            undefined,
            uiLocale,
          ),
        );
        fence();
        if (!confirmed) return;
        await owner.remove({ threadId: target.threadId, id: secret.id });
        fence();
        notifyCafeSecretsChanged(target);
        forget(secret.id);
        setEditor((current) =>
          current?.mode === "edit" && current.secret.id === secret.id ? null : current,
        );
        await refresh();
      },
      uiText("The secret could not be removed. Try again.", undefined, undefined, uiLocale),
    );
  };

  const clearAll = () => {
    void runAction(
      "*",
      async (owner, fence) => {
        const confirmed = await confirm(
          uiText(
            "Remove every secret in this chat?\nMessages that already reference them will no longer resolve to their values.",
            undefined,
            undefined,
            uiLocale,
          ),
        );
        fence();
        if (!confirmed) return;
        await owner.clear({ threadId: target.threadId });
        fence();
        notifyCafeSecretsChanged(target);
        setRevealed(new Map());
        setEditor(null);
        await refresh();
      },
      uiText("The secrets could not be removed. Try again.", undefined, undefined, uiLocale),
    );
  };

  const secrets = state.phase === "ready" ? state.secrets : [];
  const anyBusy = busyId !== null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="no-drag max-w-xl" finalFocus={false}>
        <DialogHeader>
          <DialogTitle>{uiText("Secrets", undefined, undefined, uiLocale)}</DialogTitle>
          <DialogDescription>
            {uiText(
              "Values typed as [sec:VALUE] are stored for this chat only. The model sees a reference instead of the value.",
              undefined,
              undefined,
              uiLocale,
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {uiText(
              "Tools that print a secret can still show it to the model.",
              undefined,
              undefined,
              uiLocale,
            )}
          </p>

          {state.phase === "loading" ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Spinner aria-hidden="true" />
              {uiText("Loading secrets…", undefined, undefined, uiLocale)}
            </div>
          ) : state.phase === "unsupported" ? (
            <p className="py-6 text-sm text-muted-foreground">
              {uiText(
                "This server does not support Cafe Secrets. Update the server to use them.",
                undefined,
                undefined,
                uiLocale,
              )}
            </p>
          ) : state.phase === "error" ? (
            <div className="flex items-center justify-between gap-3 py-4">
              <p role="alert" className="text-sm text-destructive-foreground">
                {uiText("Secrets could not be loaded.", undefined, undefined, uiLocale)}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setState({ phase: "loading" });
                  void refresh();
                }}
              >
                {uiText("Retry", undefined, undefined, uiLocale)}
              </Button>
            </div>
          ) : secrets.length === 0 && editor?.mode !== "add" ? (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <KeyRoundIcon aria-hidden="true" className="size-5 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {uiText("No secrets in this chat.", undefined, undefined, uiLocale)}
              </p>
            </div>
          ) : (
            <ul
              className="divide-y divide-border overflow-hidden rounded-lg border border-border"
              aria-label={uiText("Secrets", undefined, undefined, uiLocale)}
            >
              {secrets.map((secret) =>
                editor?.mode === "edit" && editor.secret.id === secret.id ? (
                  <li key={secret.id} className="p-3">
                    <SecretEditorForm
                      key={secret.id}
                      initialLabel={secret.label}
                      editing
                      busy={busyId === secret.id}
                      onCancel={() => setEditor(null)}
                      onSubmit={(label, value) =>
                        api
                          ? runAction(
                              secret.id,
                              async (owner, fence) => {
                                // Keeping the value requires the stored one;
                                // it is read only for this explicit Save and
                                // written back only by the same owner.
                                let nextValue = value;
                                if (nextValue.length === 0) {
                                  nextValue = (
                                    await owner.reveal({
                                      threadId: target.threadId,
                                      id: secret.id,
                                    })
                                  ).value;
                                  fence();
                                }
                                await owner.set({
                                  threadId: target.threadId,
                                  id: secret.id,
                                  label,
                                  value: nextValue,
                                });
                                fence();
                                notifyCafeSecretsChanged(target);
                                forget(secret.id);
                                setEditor(null);
                                await refresh();
                              },
                              uiText(
                                "The secret could not be saved. Try again.",
                                undefined,
                                undefined,
                                uiLocale,
                              ),
                            )
                          : Promise.resolve()
                      }
                    />
                  </li>
                ) : (
                  <SecretRow
                    key={secret.id}
                    secret={secret}
                    value={revealed.get(secret.id)}
                    busy={busyId === secret.id}
                    disabled={anyBusy && busyId !== secret.id}
                    copied={copiedId === secret.id}
                    onReveal={() => reveal(secret)}
                    onCopy={() => copy(secret)}
                    onEdit={() => {
                      forget(secret.id);
                      setEditor({ mode: "edit", secret });
                    }}
                    onRemove={() => remove(secret)}
                  />
                ),
              )}
              {editor?.mode === "add" ? (
                <li className="p-3">
                  <SecretEditorForm
                    initialLabel=""
                    editing={false}
                    busy={busyId === "+"}
                    onCancel={() => setEditor(null)}
                    onSubmit={(label, value) =>
                      api
                        ? runAction(
                            "+",
                            async (owner, fence) => {
                              await owner.set({
                                threadId: target.threadId,
                                ...(label ? { label } : {}),
                                value,
                              });
                              fence();
                              notifyCafeSecretsChanged(target);
                              setEditor(null);
                              await refresh();
                            },
                            uiText(
                              "The secret could not be saved. Try again.",
                              undefined,
                              undefined,
                              uiLocale,
                            ),
                          )
                        : Promise.resolve()
                    }
                  />
                </li>
              ) : null}
            </ul>
          )}

          {actionError ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {actionError}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive-foreground"
              disabled={state.phase !== "ready" || secrets.length === 0 || anyBusy}
              onClick={clearAll}
            >
              {uiText("Clear all", undefined, undefined, uiLocale)}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>
                {uiText("Done", undefined, undefined, uiLocale)}
              </Button>
              <Button
                size="sm"
                disabled={state.phase !== "ready" || editor !== null || anyBusy}
                onClick={() => setEditor({ mode: "add" })}
              >
                <PlusIcon aria-hidden="true" />
                {uiText("Add secret", undefined, undefined, uiLocale)}
              </Button>
            </div>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function IconAction(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled: boolean;
  readonly destructive?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className={props.destructive ? "size-7 text-destructive-foreground" : "size-7"}
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup role="tooltip" className="no-drag pointer-events-none">
        {props.label}
      </TooltipPopup>
    </Tooltip>
  );
}

function SecretRow(props: {
  readonly secret: ThreadSecretMetadata;
  readonly value: string | undefined;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly copied: boolean;
  readonly onReveal: () => void;
  readonly onCopy: () => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const uiLocale = useUiLocale();
  const { secret, value } = props;
  const shown = value !== undefined;
  const lock = props.busy || props.disabled;
  return (
    <li className="flex min-w-0 items-center gap-3 px-3 py-2.5" data-testid="thread-secret-row">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate text-sm font-medium">
          {secret.label || (
            <span className="text-muted-foreground">
              {uiText("Unnamed secret", undefined, undefined, uiLocale)}
            </span>
          )}
        </p>
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <code
            className={
              shown ? "break-all font-mono text-foreground" : "select-none font-mono tracking-wider"
            }
            data-testid="thread-secret-value"
          >
            {shown ? value : MASK}
          </code>
          <code className="truncate font-mono text-[0.6875rem] text-subtle-foreground">
            {secret.reference}
          </code>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {props.busy ? <Spinner aria-hidden="true" className="mr-1 size-3.5" /> : null}
        <IconAction
          label={
            shown
              ? uiText("Hide value", undefined, undefined, uiLocale)
              : uiText("Reveal value", undefined, undefined, uiLocale)
          }
          onClick={props.onReveal}
          disabled={lock}
        >
          {shown ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
        </IconAction>
        <IconAction
          label={
            props.copied
              ? uiText("Copied", undefined, undefined, uiLocale)
              : uiText("Copy value", undefined, undefined, uiLocale)
          }
          onClick={props.onCopy}
          disabled={lock}
        >
          <CopyIcon aria-hidden="true" />
        </IconAction>
        <IconAction
          label={uiText("Edit secret", undefined, undefined, uiLocale)}
          onClick={props.onEdit}
          disabled={lock}
        >
          <PencilIcon aria-hidden="true" />
        </IconAction>
        <IconAction
          label={uiText("Remove secret", undefined, undefined, uiLocale)}
          onClick={props.onRemove}
          disabled={lock}
          destructive
        >
          <Trash2Icon aria-hidden="true" />
        </IconAction>
      </div>
    </li>
  );
}

function SecretEditorForm(props: {
  readonly initialLabel: string;
  readonly editing: boolean;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (label: string, value: string) => Promise<void>;
}) {
  const uiLocale = useUiLocale();
  const [label, setLabel] = useState(props.initialLabel);
  // Value lives only in this form's local state and is cleared on submit.
  const [value, setValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const canSubmit = !props.busy && (props.editing || value.length > 0);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    const submitted = value;
    setValue("");
    void props.onSubmit(label.trim(), submitted);
  };
  return (
    <form className="space-y-2" onSubmit={submit}>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted-foreground">
          {uiText("Label (optional)", undefined, undefined, uiLocale)}
        </span>
        <Input
          size="sm"
          value={label}
          maxLength={LABEL_MAX_LENGTH}
          autoComplete="off"
          onChange={(event) => setLabel(event.currentTarget.value)}
          placeholder={uiText("e.g. Staging API key", undefined, undefined, uiLocale)}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted-foreground">
          {props.editing
            ? uiText("New value (leave empty to keep)", undefined, undefined, uiLocale)
            : uiText("Value", undefined, undefined, uiLocale)}
        </span>
        <div className="flex items-center gap-1">
          <Input
            size="sm"
            type={showValue ? "text" : "password"}
            value={value}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            onChange={(event) => setValue(event.currentTarget.value)}
            className="font-mono"
          />
          <IconAction
            label={
              showValue
                ? uiText("Hide value", undefined, undefined, uiLocale)
                : uiText("Show value", undefined, undefined, uiLocale)
            }
            onClick={() => setShowValue((current) => !current)}
            disabled={false}
          >
            {showValue ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
          </IconAction>
        </div>
      </label>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onCancel}
          disabled={props.busy}
        >
          {uiText("Cancel", undefined, undefined, uiLocale)}
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {props.busy ? <Spinner aria-hidden="true" /> : null}
          {uiText("Save", undefined, undefined, uiLocale)}
        </Button>
      </div>
    </form>
  );
}
