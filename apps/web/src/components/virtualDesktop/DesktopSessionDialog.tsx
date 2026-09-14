import { useState } from "react";
import {
  DEFAULT_DESKTOP_RESOLUTION,
  type EnvironmentId,
  type ThreadId,
  type VirtualDesktopSnapshot,
} from "@cafecode/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { useVirtualDesktops } from "./useVirtualDesktops";
import {
  DesktopResolutionFields,
  draftResolution,
  readResolutionDraft,
} from "./DesktopResolutionFields";

/** Mount only while open so each creation starts from the latest environment defaults. */
export function DesktopSessionDialog({
  environmentId,
  threadId,
  desktop,
  onClose,
}: {
  environmentId: EnvironmentId | null;
  threadId?: ThreadId | null;
  desktop?: VirtualDesktopSnapshot;
  onClose: () => void;
}) {
  const controls = useVirtualDesktops(environmentId, threadId);
  const [name, setName] = useState("");
  const [draft, setDraft] = useState(() =>
    draftResolution(
      desktop?.resolution ?? controls.data?.defaultResolution ?? DEFAULT_DESKTOP_RESOLUTION,
    ),
  );
  const resolution = readResolutionDraft(draft);
  const current = desktop && controls.data?.desktops.find((d) => d.id === desktop.id);
  const canSubmit =
    resolution &&
    controls.data?.enabled &&
    controls.data.available &&
    (desktop ? current?.state === "ready" && current.canResize : Boolean(name.trim()));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !controls.busy) onClose();
      }}
    >
      <DialogPopup showCloseButton={!controls.busy} bottomStickOnMobile={false}>
        <DialogHeader>
          <DialogTitle>{desktop ? "Display settings" : "New desktop"}</DialogTitle>
          <DialogDescription>
            {desktop
              ? `Change the resolution of ${desktop.name} for this session.`
              : "Choose a name and display size for this temporary desktop."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5 overflow-y-auto px-6 pb-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit || !resolution || controls.busy) return;
            void controls
              .change(
                desktop
                  ? { operation: "set-display", id: desktop.id, resolution }
                  : {
                      operation: "create",
                      name: name.trim(),
                      resolution,
                      ...(threadId ? { threadId } : {}),
                    },
              )
              .then((ok) => {
                if (ok) onClose();
              });
          }}
        >
          {!desktop && (
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Name</span>
              <Input
                autoFocus
                required
                maxLength={80}
                value={name}
                placeholder="e.g. Browser testing"
                disabled={controls.busy}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          )}
          <DesktopResolutionFields value={draft} onChange={setDraft} disabled={controls.busy} />
          <p className="text-xs text-muted-foreground">
            {desktop
              ? "Changing resolution pauses input until a fresh screenshot is available. Defaults for new desktops stay the same."
              : "Closing the viewer keeps apps running. Ending this desktop or restarting your computer closes its apps and removes it. Saved files remain; unsaved work can be lost."}
          </p>
          {controls.error && (
            <p role="alert" className="text-xs text-destructive">
              {controls.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={controls.busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={controls.busy || !canSubmit}>
              {controls.busy
                ? desktop
                  ? "Applying…"
                  : "Creating…"
                : desktop
                  ? "Apply resolution"
                  : "Create desktop"}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
