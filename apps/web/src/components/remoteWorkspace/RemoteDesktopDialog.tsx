import { useEffect, useRef, useState } from "react";
import { useRemoteDesktopViewer } from "./remoteViewerState";
import type { EnvironmentId } from "@cafecode/contracts";
import { DESKTOP_PREVIEW_MAX_BYTES, DESKTOP_PREVIEW_PATH } from "@cafecode/contracts";
import { fileRequest, readBounded } from "../../attachments/fileAttachments";
import { requireEnvironmentConnection } from "../../environments/runtime";
import { readWorkspaceEnvironmentDescriptor } from "../../environments/workspace";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { workspaceRequest } from "./api";
export function RemoteDesktopViewerHost() {
  const target = useRemoteDesktopViewer((s) => s.target);
  return target ? (
    <RemoteDesktopDialog
      key={`${target.environmentId}:${target.id}`}
      {...target}
      onClose={() => useRemoteDesktopViewer.setState({ target: null })}
    />
  ) : null;
}
function RemoteDesktopDialog({
  environmentId,
  id,
  onClose,
}: {
  environmentId: EnvironmentId;
  id: string;
  onClose: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [lease, setLease] = useState<string | null>(null);
  const leaseRef = useRef<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resolution, setResolution] = useState<{ width: number; height: number } | null>(null);
  const requests = useRef(Promise.resolve());
  const inputController = useRef(new AbortController());
  useEffect(() => {
    if (!lease) return;
    const timer = setInterval(() => {
      void workspaceRequest(environmentId, {
        operation: "desktop-viewer",
        id,
        command: "heartbeat",
        lease,
      }).catch(() => {
        leaseRef.current = null;
        setLease(null);
        setError("Control expired. Take control again before sending input.");
      });
    }, 10_000);
    return () => clearInterval(timer);
  }, [environmentId, id, lease]);
  const host = readWorkspaceEnvironmentDescriptor(environmentId)?.label ?? "server";
  useEffect(() => {
    const controller = new AbortController();
    const inputSession = new AbortController();
    inputController.current = inputSession;
    let timer: ReturnType<typeof setTimeout> | undefined, objectUrl: string | undefined;
    void requireEnvironmentConnection(environmentId)
      .client.server.virtualDesktop({ operation: "status" })
      .then(
        (state) => {
          if (!controller.signal.aborted)
            setResolution(state.desktops.find((d) => d.id === id)?.resolution ?? null);
        },
        () => undefined,
      );
    async function poll() {
      if (controller.signal.aborted) return;
      try {
        if (!document.hidden) {
          const response = await fileRequest(environmentId, `${DESKTOP_PREVIEW_PATH}/${id}`, {
            signal: controller.signal,
            cache: "no-store",
          });
          const bytes = await readBounded(response, DESKTOP_PREVIEW_MAX_BYTES);
          if (response.headers.get("content-type")?.split(";", 1)[0] !== "image/png")
            throw new Error("image");
          if (controller.signal.aborted) return;
          const next = URL.createObjectURL(
            new Blob([new Uint8Array(bytes)], { type: "image/png" }),
          );
          const previous = objectUrl;
          objectUrl = next;
          setSrc(next);
          if (previous) URL.revokeObjectURL(previous);
        }
        timer = setTimeout(() => void poll(), document.hidden ? 1500 : 600);
      } catch {
        if (!controller.signal.aborted) {
          setError("Viewer disconnected. Close and reopen it after checking the server.");
          setLease(null);
        }
      }
    }
    void poll();
    return () => {
      controller.abort();
      inputSession.abort();
      clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      const captured = leaseRef.current;
      if (captured)
        void requests.current
          .catch(() => undefined)
          .then(() =>
            workspaceRequest(environmentId, {
              operation: "desktop-viewer",
              id,
              command: "return-control",
              lease: captured,
            }),
          )
          .catch(() => undefined);
    };
  }, [environmentId, id]);
  async function control() {
    if (busy) return;
    setBusy(true);
    setError(null);
    await requests.current.catch(() => undefined);
    requests.current = Promise.resolve();
    try {
      if (lease) {
        await workspaceRequest(environmentId, {
          operation: "desktop-viewer",
          id,
          command: "return-control",
          lease,
        });
        leaseRef.current = null;
        setLease(null);
      } else {
        const result = await workspaceRequest<{
          lease: string;
          resolution: { width: number; height: number };
        }>(environmentId, {
          operation: "desktop-viewer",
          id,
          command: "take-control",
        });
        setResolution(result.resolution);
        leaseRef.current = result.lease;
        setLease(result.lease);
      }
    } catch {
      leaseRef.current = null;
      setLease(null);
      setError("Control did not change. Check server access and refresh before trying again.");
    } finally {
      setBusy(false);
    }
  }
  function act(action: object) {
    if (!lease || busy) return;
    const captured = lease;
    const inputSignal = inputController.current.signal;
    requests.current = requests.current
      .then(() =>
        inputSignal.aborted
          ? undefined
          : workspaceRequest(
              environmentId,
              {
                operation: "desktop-viewer",
                id,
                command: "act",
                lease: captured,
                action,
              },
              inputSignal,
            ),
      )
      .then(() => undefined);
    void requests.current.catch(() => {
      leaseRef.current = null;
      setLease(null);
      setError(
        "Input did not complete or control changed. Take control again before sending more input. Input is never replayed.",
      );
    });
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-5xl max-h-[90dvh]">
        <DialogHeader>
          <DialogTitle>Desktop · {host}</DialogTitle>
          <DialogDescription>
            {lease
              ? "You have control. Agent input is paused until control is returned or reclaimed."
              : "Viewing the host desktop. Take control to send input."}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="px-6 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-auto bg-black">
          {src ? (
            <img
              src={src}
              alt={`Desktop on ${host}`}
              draggable={false}
              tabIndex={lease ? 0 : -1}
              className="mx-auto max-h-[55dvh] object-contain"
              onClick={(event) => {
                if (!resolution) return;
                const rect = event.currentTarget.getBoundingClientRect();
                act({
                  kind: "click",
                  x: Math.min(
                    resolution.width - 1,
                    Math.max(
                      0,
                      Math.floor(((event.clientX - rect.left) / rect.width) * resolution.width),
                    ),
                  ),
                  y: Math.min(
                    resolution.height - 1,
                    Math.max(
                      0,
                      Math.floor(((event.clientY - rect.top) / rect.height) * resolution.height),
                    ),
                  ),
                });
              }}
              onWheel={(event) => {
                act({
                  kind: "scroll",
                  amount: Math.max(-100, Math.min(100, Math.round(event.deltaY / 40))),
                });
              }}
              onKeyDown={(event) => {
                const names: Record<string, string> = {
                  Enter: "Return",
                  Escape: "Escape",
                  Backspace: "BackSpace",
                  Delete: "Delete",
                  Tab: "Tab",
                  ArrowUp: "Up",
                  ArrowDown: "Down",
                  ArrowLeft: "Left",
                  ArrowRight: "Right",
                };
                const key =
                  names[event.key] ?? (/^[a-zA-Z0-9]$/.test(event.key) ? event.key : null);
                if (!lease || !key) return;
                event.preventDefault();
                event.stopPropagation();
                act({
                  kind: "key",
                  keys: [
                    ...(event.ctrlKey ? ["Control_L"] : []),
                    ...(event.altKey ? ["Alt_L"] : []),
                    ...(event.shiftKey ? ["Shift_L"] : []),
                    key,
                  ],
                });
              }}
            />
          ) : (
            <p className="p-12 text-center text-sm text-white">Loading desktop…</p>
          )}
        </div>
        <DialogFooter className="flex-wrap">
          <Input
            aria-label="Text to type on host"
            disabled={!lease || busy}
            value={text}
            maxLength={4096}
            onChange={(event) => setText(event.target.value)}
            className="min-w-0 flex-1"
            placeholder="Type text on host"
          />
          <Button
            disabled={!lease || busy || !text}
            onClick={() => {
              act({ kind: "text", text });
              setText("");
            }}
          >
            Send text
          </Button>
          <Button disabled={busy} onClick={() => void control()}>
            {lease ? "Return control" : "Take control"}
          </Button>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
