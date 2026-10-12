import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { CopyIcon, DownloadIcon, MoreHorizontalIcon } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { useDelayedFlag } from "../hooks/useDelayedFlag";
import { copyPngToClipboard, savePngToDisk } from "../lib/imageExport";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface ImageExportMenuProps {
  /** Presentation copy only; filename/content identity are independently bound. */
  label: string;
  contentKey: unknown;
  createPng: (signal: AbortSignal) => Promise<Blob>;
  suggestedName: string;
  disabled?: boolean;
}

/** One explicit user gesture owns one frozen presentation snapshot. Retiring
 * the source cancels preparation and suppresses late feedback. A native save
 * dialog, once admitted, owns that snapshot until its user saves/cancels it;
 * it can never be rebound to another row, account or focused window. */
export function ImageExportMenu({
  label,
  contentKey,
  createPng,
  suggestedName,
  disabled = false,
}: ImageExportMenuProps) {
  const uiLocale = useUiLocale();

  const owner = useMemo(() => ({ contentKey, disabled }), [contentKey, disabled]);
  const currentOwner = useRef(owner);
  const mounted = useRef(false);
  const active = useRef<{ owner: typeof owner; controller: AbortController } | null>(null);
  const [busyOwner, setBusyOwner] = useState<typeof owner | null>(null);
  const busy = busyOwner === owner;
  const showBusy = useDelayedFlag(busy);
  useLayoutEffect(() => {
    currentOwner.current = owner;
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.controller.abort();
      active.current = null;
    };
  }, [owner]);

  const start = (action: "copy" | "save") => {
    if (disabled || !mounted.current || currentOwner.current !== owner || active.current) return;
    const controller = new AbortController();
    active.current = { owner, controller };
    setBusyOwner(owner);
    // Both raster creation and ClipboardItem/write start in this gesture's
    // stack. Wrapping creation in Promise.resolve().then loses activation.
    let png: Promise<Blob>;
    try {
      png = createPng(controller.signal);
    } catch {
      png = Promise.reject(new Error("Image export failed."));
    }
    void png.catch(() => undefined);
    const operation =
      action === "copy"
        ? copyPngToClipboard(png, controller.signal)
        : savePngToDisk(png, suggestedName, controller.signal);
    const isCurrent = () =>
      mounted.current &&
      currentOwner.current === owner &&
      active.current?.controller === controller &&
      !controller.signal.aborted;
    void operation
      .then(
        () => {
          if (action === "copy" && isCurrent()) {
            // The user explicitly requested a clipboard toast. Disk saves and
            // cancelled native dialogs deliberately emit no success notification.
            toastManager.add({
              type: "success",
              title: uiText("{value0} image copied", { value0: label }, undefined, uiLocale),
              timeout: 2000,
              data: { hideCopyButton: true },
            });
          }
        },
        () => {
          if (!isCurrent()) return;
          toastManager.add({
            type: "error",
            title:
              action === "copy"
                ? uiText("Couldn''t copy image", undefined, undefined, uiLocale)
                : uiText("Couldn''t save image", undefined, undefined, uiLocale),
            description:
              action === "copy"
                ? uiText(
                    "Try again, or use Save as PNG. Some browsers don''t allow image clipboard access.",
                    undefined,
                    undefined,
                    uiLocale,
                  )
                : uiText(
                    "Try again. Unsupported content or an unavailable destination can prevent image export.",
                    undefined,
                    undefined,
                    uiLocale,
                  ),
            data: { hideCopyButton: true },
          });
        },
      )
      .finally(() => {
        controller.abort();
        if (active.current?.controller === controller) active.current = null;
        if (mounted.current && currentOwner.current === owner) setBusyOwner(null);
      });
  };

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              aria-label={uiText("{value0} image actions", { value0: label }, undefined, uiLocale)}
              // Keep the trigger focusable while work is pending: menu close
              // must restore keyboard focus even before clipboard preparation
              // settles. Its actions are disabled and the single-flight guard
              // prevents a second operation or native picker.
              disabled={disabled}
              aria-busy={busy || undefined}
              render={<Button size="icon-xs" variant="ghost" data-cafe-window-no-drag="true" />}
            />
          }
        >
          {showBusy ? (
            <Spinner aria-label={uiText("Preparing image", undefined, undefined, uiLocale)} />
          ) : (
            <MoreHorizontalIcon />
          )}
        </TooltipTrigger>
        <TooltipPopup>{uiText("Copy or save image", undefined, undefined, uiLocale)}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="min-w-44" data-cafe-window-no-drag="true">
        <MenuItem disabled={disabled || busy} onClick={() => start("copy")}>
          <CopyIcon />
          {uiText("Copy image", undefined, undefined, uiLocale)}
        </MenuItem>
        <MenuItem disabled={disabled || busy} onClick={() => start("save")}>
          <DownloadIcon />
          {uiText("Save as PNG", undefined, undefined, uiLocale)}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
