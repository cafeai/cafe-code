import { useLayoutEffect, useRef, useState } from "react";
import type { EnvironmentId, ThreadId } from "@cafecode/contracts";
import type { VisualizationInlineResult } from "@cafecode/contracts/visualizationApi";
import {
  McpAppPrepareResult,
  McpAppReply,
  type VisualizationReference,
} from "@cafecode/contracts/mcpApps";
import { encodeBoundedMcpAppJson, readBoundedMcpAppJson } from "@cafecode/shared/mcpAppJson";
import { admittedMcpAppLink } from "@cafecode/shared/mcpAppProtocol";
import { uiText } from "@cafecode/shared/i18n";
import * as Schema from "effect/Schema";
import { useUiLocale } from "~/i18n";
import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { VisualizationPrivateText } from "./VisualizationPrivateText";
import { observeVisualizationOwner } from "./visualizationOwner";

const decodePrepare = Schema.decodeUnknownSync(McpAppPrepareResult);
const decodeReply = Schema.decodeUnknownSync(McpAppReply);
const MAX_WAITING = 8;
type Consent = { operationId: string; method: string; name?: string; deadline: number };

/**
 * The App protocol uses an exact browser frame and a short server-owned action
 * grant. Neither the frame nor this message channel contains privileged code:
 * unsandboxed same-origin HTML is allowed only under Full access. This broker
 * still limits ordinary SDK operations to the originating configured server and
 * one-use approvals; it never mistakes a browser ID for native process proof.
 */
export function InlineMcpAppBridge({
  environmentId,
  threadId,
  reference,
  payload,
  frame,
  current,
  onDisplayMode,
  onClose,
  onReady,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  reference: VisualizationReference;
  payload: VisualizationInlineResult;
  frame: HTMLIFrameElement;
  current: () => boolean;
  onDisplayMode: (mode: "inline" | "fullscreen") => Promise<boolean>;
  onClose: () => void;
  onReady?: () => void;
}) {
  const uiLocale = useUiLocale();
  const callbacks = useRef({ current, onDisplayMode, onClose, onReady });
  callbacks.current = { current, onDisplayMode, onClose, onReady };
  const [consent, setConsent] = useState<Consent | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [privateJson, setPrivateJson] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [detailFailure, setDetailFailure] = useState(false);
  const resolve = useRef<(decision: "approve" | "deny") => void>(() => undefined);
  const inspect = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    let disposed = false;
    let closed = false;
    let busy = false;
    let pending: Consent | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    const waiting: string[] = [];
    const target = frame.contentWindow;
    const owner = observeVisualizationOwner(environmentId, close);
    const input = {
      threadId,
      artifactId: reference.artifactId,
      revisionId: reference.revisionId,
      leaseId: payload.frameId,
      ticket: payload.ticket,
    };
    function live() {
      return (
        !disposed &&
        !closed &&
        target !== null &&
        frame.isConnected &&
        frame.contentWindow === target &&
        owner.current() &&
        callbacks.current.current()
      );
    }
    function close() {
      if (disposed || closed) return;
      closed = true;
      clearInterval(timer);
      timer = undefined;
      waiting.length = 0;
      pending = null;
      setConsent(null);
      setPrivateJson(null);
      callbacks.current.onClose();
    }
    function forward(json: string, additional: readonly string[] = []) {
      for (const text of [...(json ? [json] : []), ...additional]) {
        if (!live()) return;
        const decoded = readBoundedMcpAppJson(text);
        if (!decoded.ok) throw new Error("App reply unavailable.");
        // Only the captured exact WindowProxy receives this bounded JSON. The
        // wildcard supports custom desktop origins; it is not a broadcast.
        target!.postMessage(decoded.value, "*");
      }
    }
    async function receive(json: string) {
      if (!live() || pending) return;
      if (busy) {
        if (waiting.length >= MAX_WAITING) close();
        else waiting.push(json);
        return;
      }
      busy = true;
      try {
        if (!owner.api?.mcpApps || payload.purpose !== "mcp-app")
          throw new Error("App unavailable.");
        const result = decodePrepare(
          await owner.api.mcpApps.prepare({ ...input, requestJson: json }),
        );
        if (!live()) return;
        if (result.kind === "reply") {
          if (result.displayMode && !(await callbacks.current.onDisplayMode(result.displayMode)))
            throw new Error("App display unavailable.");
          if (live()) forward(result.json, result.messages);
        } else {
          // Browser execution is not suspended or falsely declared safe. The
          // server independently fences this one finite pending operation.
          if (result.expiresAtMs <= Date.now()) throw new Error("App permission expired.");
          pending = { ...result, deadline: result.expiresAtMs };
          setRemaining(Math.max(0, Math.ceil((result.expiresAtMs - Date.now()) / 1000)));
          // Only a pending one-use permission needs a countdown. Ordinary
          // initialized Apps have no extra polling timer or execution limit.
          timer = setInterval(() => {
            if (!pending || !live()) return;
            const seconds = Math.max(0, Math.ceil((pending.deadline - Date.now()) / 1000));
            setRemaining(seconds);
            if (!seconds) close();
          }, 1_000);
          waiting.length = 0;
          setPrivateJson(null);
          setExpanded(false);
          setDetailFailure(false);
          setConsent(pending);
        }
      } catch {
        if (live()) close();
      } finally {
        busy = false;
        const next = waiting.shift();
        if (next && live() && !pending) void receive(next);
      }
    }
    const listener = (event: MessageEvent) => {
      if (!event.isTrusted || event.source !== target || !live() || event.origin !== window.origin)
        return;
      // An ordinary navigation must not silently acquire this document's App
      // broker even if its WindowProxy stays the same. This is routing hygiene,
      // not containment of the deliberately same-origin privileged source.
      if (frame.contentDocument?.URL !== "about:srcdoc") return;
      const json =
        typeof event.data === "string"
          ? readBoundedMcpAppJson(event.data).ok
            ? event.data
            : undefined
          : encodeBoundedMcpAppJson(event.data);
      if (json !== undefined) void receive(json);
    };
    resolve.current = (decision) => {
      const operation = pending;
      if (!operation || busy || !live()) return;
      if (Date.now() >= operation.deadline) {
        close();
        return;
      }
      busy = true;
      setPrivateJson(null);
      setExpanded(false);
      void (async () => {
        try {
          const reply = decodeReply(
            await owner.api!.mcpApps!.resolve({ operationId: operation.operationId, decision }),
          );
          if (!live() || pending !== operation || Date.now() >= operation.deadline) return;
          pending = null;
          clearInterval(timer);
          timer = undefined;
          setConsent(null);
          forward(reply.json);
          if (reply.openUrl) {
            const url = admittedMcpAppLink(reply.openUrl);
            const local = readLocalApi();
            if (!url || !local || !live()) throw new Error("App link unavailable.");
            await local.shell.openExternal(url);
          }
        } catch {
          if (live()) close();
        } finally {
          busy = false;
        }
      })();
    };
    inspect.current = () => {
      const operation = pending;
      if (!operation || !live()) return;
      setPrivateJson(null);
      setDetailFailure(false);
      void owner
        .api!.mcpApps!.details({ operationId: operation.operationId })
        .then((value) => {
          if (live() && pending === operation) setPrivateJson(decodeReply(value).json);
        })
        .catch(() => {
          if (live() && pending === operation) setDetailFailure(true);
        });
    };
    window.addEventListener("message", listener);
    callbacks.current.onReady?.();
    return () => {
      disposed = true;
      pending = null;
      waiting.length = 0;
      clearInterval(timer);
      window.removeEventListener("message", listener);
      owner.dispose();
      resolve.current = () => undefined;
      inspect.current = () => undefined;
    };
  }, [
    environmentId,
    threadId,
    reference.artifactId,
    reference.revisionId,
    payload.frameId,
    payload.ticket,
    payload.purpose,
    frame,
  ]);

  return (
    <Dialog
      open={consent !== null}
      onOpenChange={(open) => {
        if (!open) resolve.current("deny");
      }}
    >
      <DialogPopup
        data-visualization-consent="true"
        showCloseButton={false}
        className="[app-region:no-drag]"
      >
        <div className="space-y-3 p-5">
          <DialogTitle>{uiText("App permission", undefined, undefined, uiLocale)}</DialogTitle>
          <p className="text-sm">
            {uiText("Allow this one App operation?", undefined, undefined, uiLocale)}
          </p>
          <p className="text-sm text-muted-foreground">
            {consent?.method}
            {consent?.name ? ` · ${consent.name}` : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            {uiText(
              "Permission expires in {seconds}s",
              { seconds: remaining },
              undefined,
              uiLocale,
            )}
          </p>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={expanded}
            onClick={(event) => {
              if (!event.isTrusted) return;
              setExpanded(!expanded);
              if (!expanded) inspect.current();
              else setPrivateJson(null);
            }}
          >
            {uiText("Private details", undefined, undefined, uiLocale)}
          </Button>
          {expanded ? (
            <VisualizationPrivateText
              value={privateJson ?? uiText("Loading…", undefined, undefined, uiLocale)}
            />
          ) : null}
          {detailFailure ? (
            <p role="status" className="text-xs">
              {uiText("Private details unavailable.", undefined, undefined, uiLocale)}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              autoFocus
              variant="outline"
              onClick={(event) => {
                if (event.isTrusted) resolve.current("deny");
              }}
            >
              {uiText("Deny", undefined, undefined, uiLocale)}
            </Button>
            <Button
              onClick={(event) => {
                if (event.isTrusted) resolve.current("approve");
              }}
            >
              {uiText("Allow once", undefined, undefined, uiLocale)}
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
