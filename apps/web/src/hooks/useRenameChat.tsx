import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import type { ScopedThreadRef } from "@cafecode/contracts";
import { useCallback, useRef, useState } from "react";

import { renameThread } from "../threadRename";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";

/** Shared visible rename affordance for navigation surfaces. The dialog keeps
 * failed input editable rather than silently losing it when an environment is
 * temporarily unavailable. Only the server command changes the actual title.
 */
export function useRenameChat() {
  const uiLocale = useUiLocale();

  const [target, setTarget] = useState<{ ref: ScopedThreadRef; title: string } | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const openRenameChat = useCallback((ref: ScopedThreadRef, currentTitle: string) => {
    if (savingRef.current) return;
    setTarget({ ref, title: currentTitle });
    setTitle(currentTitle);
    setError(null);
  }, []);
  const close = useCallback(() => {
    if (!savingRef.current) setTarget(null);
  }, []);
  const save = async () => {
    if (!target || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await renameThread(target.ref, title, target.title);
      setTarget(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : uiText("Could not rename this chat.", undefined, undefined, uiLocale),
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return {
    openRenameChat,
    renameChatDialog: (
      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogPopup className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{uiText("Rename chat", undefined, undefined, uiLocale)}</DialogTitle>
            <DialogDescription>
              {uiText(
                "Change the title everywhere this chat appears.",
                undefined,
                undefined,
                uiLocale,
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="flex flex-col gap-2 text-sm">
              <UiMessage
                message={"Chat title<slot1></slot1>"}
                slots={{
                  slot1: (
                    <Input
                      autoFocus
                      value={title}
                      disabled={saving}
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => setTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void save();
                        }
                      }}
                    />
                  ),
                }}
              />
            </label>
            {error ? (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={close}>
              {uiText("Cancel", undefined, undefined, uiLocale)}
            </Button>
            <Button disabled={saving || title.trim().length === 0} onClick={() => void save()}>
              {saving
                ? uiText("Saving…", undefined, undefined, uiLocale)
                : uiText("Save", undefined, undefined, uiLocale)}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    ),
  };
}

// Finite source-owned labels/helpers only; no received or user data.
