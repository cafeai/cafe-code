import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChartNoAxesCombinedIcon, ChevronRightIcon, PlayIcon, SquareIcon } from "lucide-react";
import type { EnvironmentId, ThreadId } from "@cafecode/contracts";
import type { TimestampFormat } from "@cafecode/contracts/settings";
import {
  VisualizationDetailsResult,
  VisualizationExportHtmlResult,
  type VisualizationTimelineEntry,
} from "@cafecode/contracts/visualizationApi";
import * as Schema from "effect/Schema";
import { uiText } from "@cafecode/shared/i18n";
import { useUiLocale } from "~/i18n";
import { formatDiagnosticTimestamp } from "../../timestampFormat";
import { copyTextToClipboard } from "../../lib/copyToClipboard";
import { copyPngToClipboard, savePngToDisk } from "../../lib/imageExport";
import { SubagentAvatar } from "../subagents/SubagentAvatar";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { downloadPortableVisualization } from "./visualizationDownload";
import { observeVisualizationOwner } from "./visualizationOwner";
import { acquireVisualizationPoster } from "./visualizationPoster";
import { useVisualizationViewer, visualizationBindingKey } from "./VisualizationViewerProvider";
import { VisualizationPrivateText } from "./VisualizationPrivateText";
import { visualizationEntryIdentity } from "./visualizationEntryIdentity";

const decodeDetails = Schema.decodeUnknownSync(VisualizationDetailsResult);
const decodeHtml = Schema.decodeUnknownSync(VisualizationExportHtmlResult);

/**
 * The row is a passive poster until a user starts the independent native host.
 * Source/private JSON is absent from props, collapsed DOM, tooltips and history
 * projections. Collapse, recycling or owner-generation loss erases reader bytes.
 */
export const VisualizationCard = memo(function VisualizationCard({
  environmentId,
  threadId,
  entry,
  timestampFormat,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  entry: VisualizationTimelineEntry;
  timestampFormat: TimestampFormat;
}) {
  const uiLocale = useUiLocale();
  const viewer = useVisualizationViewer();
  const reference = entry.reference;
  // One immutable revision may appear in several invocations or panes. Neither
  // another card's controls nor its recycling may acquire/revoke this anchor.
  const anchorId = useId();
  const entryKey = visualizationEntryIdentity(entry);
  const key = visualizationBindingKey({ environmentId, threadId, reference, entryKey, anchorId });
  const anchor = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [poster, setPoster] = useState<{ key: string; url: string; blob: Blob } | null>(null);
  const [posterFailure, setPosterFailure] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState({ key, value: false });
  const open = expanded.key === key && expanded.value;
  const [details, setDetails] = useState<{ key: string; value: VisualizationDetailsResult } | null>(
    null,
  );
  const [detailFailure, setDetailFailure] = useState(false);
  const [feedback, setExportOutcome] = useState<
    "copied" | "saved" | "downloaded" | "failed" | null
  >(null);
  const [htmlConsent, setHtmlConsent] = useState<string | null>(null);
  const htmlConsentOwned = useRef<() => boolean>(() => false);
  const downloadRelease = useRef<(() => void) | null>(null);
  const committed = useRef(key);
  const generation = useRef(0);
  const privateOwned = useRef<() => boolean>(() => false);
  const posterOwned = useRef<() => boolean>(() => false);
  const exportAbort = useRef<AbortController | null>(null);
  const active = viewer?.snapshot?.key === key ? viewer.snapshot : null;
  const live = active?.status === "active";
  const detach = viewer?.detach;

  useLayoutEffect(() => {
    committed.current = key;
    setDetails(null);
    setExportOutcome(null);
    setPoster(null);
    return () => {
      generation.current += 1;
      privateOwned.current = () => false;
      posterOwned.current = () => false;
      exportAbort.current?.abort();
      downloadRelease.current?.();
      detach?.(key);
    };
  }, [key, detach]);
  useEffect(() => {
    const element = anchor.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries[0]?.isIntersecting ?? false),
      { rootMargin: "0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [key]);
  useEffect(() => {
    if (!visible || !reference.poster) {
      setPoster(null);
      return;
    }
    let disposed = false;
    let acquired: Awaited<ReturnType<typeof acquireVisualizationPoster>> | null = null;
    const abort = new AbortController();
    const owner = observeVisualizationOwner(environmentId, () => {
      abort.abort();
      acquired?.release();
      acquired = null;
      posterOwned.current = () => false;
      setPoster(null);
      setPosterFailure(true);
    });
    const current = () =>
      !disposed && !abort.signal.aborted && committed.current === key && owner.current();
    posterOwned.current = current;
    setPosterFailure(false);
    void acquireVisualizationPoster(environmentId, threadId, reference, abort.signal)
      .then((result) => {
        if (!current()) {
          result.release();
          return;
        }
        acquired = result;
        setPoster({ key, url: result.url, blob: result.blob });
      })
      .catch(() => {
        if (current()) setPosterFailure(true);
      });
    return () => {
      disposed = true;
      abort.abort();
      owner.dispose();
      acquired?.release();
      posterOwned.current = () => false;
    };
  }, [environmentId, threadId, key, reference, visible, attempt]);

  useEffect(() => {
    setDetails(null);
    setDetailFailure(false);
    setExportOutcome(null);
    privateOwned.current = () => false;
    if (!open) return;
    let disposed = false;
    const token = ++generation.current;
    const owner = observeVisualizationOwner(environmentId, () => {
      privateOwned.current = () => false;
      setDetails(null);
      setDetailFailure(true);
      exportAbort.current?.abort();
    });
    const current = () =>
      !disposed && token === generation.current && committed.current === key && owner.current();
    privateOwned.current = current;
    if (!owner.current() || !owner.api?.visualizations) setDetailFailure(true);
    else
      void owner.api.visualizations
        .details({ threadId, artifactId: reference.artifactId, revisionId: reference.revisionId })
        .then((raw) => {
          if (!current()) return;
          const result = decodeDetails(raw);
          if (
            result.threadId !== threadId ||
            result.artifactId !== reference.artifactId ||
            result.revisionId !== reference.revisionId ||
            result.source.artifactId !== reference.artifactId ||
            result.source.revisionId !== reference.revisionId ||
            result.diagnostics.artifactId !== reference.artifactId ||
            result.diagnostics.revisionId !== reference.revisionId ||
            result.source.purpose !== reference.purpose
          )
            throw new Error("details-stale");
          // Bound the complete private reader allocation, not each field separately.
          if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 4 * 1024 * 1024)
            throw new Error("details-too-large");
          setDetails({ key, value: result });
        })
        .catch(() => {
          if (current()) setDetailFailure(true);
        });
    return () => {
      disposed = true;
      generation.current += 1;
      owner.dispose();
      privateOwned.current = () => false;
      exportAbort.current?.abort();
    };
  }, [
    environmentId,
    threadId,
    key,
    reference.artifactId,
    reference.revisionId,
    reference.purpose,
    open,
    attempt,
  ]);

  const copy = async (value: string) => {
    if (!privateOwned.current()) return;
    try {
      await copyTextToClipboard(value);
      if (privateOwned.current()) setExportOutcome("copied");
    } catch {
      if (privateOwned.current()) setExportOutcome("failed");
    }
  };
  const exportPng = (action: "copy" | "save") => {
    if (exportAbort.current) return;
    const abort = new AbortController();
    exportAbort.current = abort;
    setExportOutcome(null);
    const png =
      live && viewer
        ? viewer.capture(key, abort.signal)
        : poster?.key === key && posterOwned.current()
          ? Promise.resolve(poster.blob)
          : Promise.reject(new Error("poster-unavailable"));
    const operation =
      action === "copy"
        ? copyPngToClipboard(png, abort.signal)
        : savePngToDisk(png, "visualization.png", abort.signal);
    void operation
      .then((result) => {
        if (!abort.signal.aborted && committed.current === key && result !== "cancelled")
          setExportOutcome(action === "copy" ? "copied" : "saved");
      })
      .catch(() => {
        if (!abort.signal.aborted && committed.current === key) setExportOutcome("failed");
      })
      .finally(() => {
        if (exportAbort.current === abort) exportAbort.current = null;
      });
  };
  const exportHtml = () => {
    if (htmlConsent !== key || !htmlConsentOwned.current()) return;
    setHtmlConsent(null);
    if (reference.purpose !== "generated-visualization" || exportAbort.current) return;
    const abort = new AbortController();
    exportAbort.current = abort;
    const owner = observeVisualizationOwner(environmentId, () => {
      abort.abort();
      downloadRelease.current?.();
    });
    const current = () => !abort.signal.aborted && committed.current === key && owner.current();
    if (!owner.api?.visualizations?.exportHtml || !current()) {
      owner.dispose();
      exportAbort.current = null;
      setExportOutcome("failed");
      return;
    }
    void owner.api.visualizations
      .exportHtml({ threadId, artifactId: reference.artifactId, revisionId: reference.revisionId })
      .then((raw) => {
        if (!current()) return;
        const result = decodeHtml(raw);
        if (
          result.threadId !== threadId ||
          result.artifactId !== reference.artifactId ||
          result.revisionId !== reference.revisionId
        )
          throw new Error("export-stale");
        downloadRelease.current = downloadPortableVisualization(result.html);
        setExportOutcome("downloaded");
      })
      .catch(() => {
        if (current()) setExportOutcome("failed");
      })
      .finally(() => {
        owner.dispose();
        if (exportAbort.current === abort) exportAbort.current = null;
      });
  };
  useEffect(() => {
    htmlConsentOwned.current = () => false;
    if (htmlConsent !== key) return;
    const owner = observeVisualizationOwner(environmentId, () => setHtmlConsent(null));
    htmlConsentOwned.current = () => committed.current === key && owner.current();
    return () => {
      owner.dispose();
      htmlConsentOwned.current = () => false;
    };
  }, [htmlConsent, key, environmentId]);

  const stateLabel =
    active?.status === "quarantined"
      ? uiText("Viewer unavailable until retirement is verified.", undefined, undefined, uiLocale)
      : active?.status === "unavailable"
        ? uiText(
            "Interactive viewing requires the local desktop host.",
            undefined,
            undefined,
            uiLocale,
          )
        : active?.status === "starting"
          ? uiText("Starting viewer…", undefined, undefined, uiLocale)
          : active?.status === "stopping"
            ? uiText("Stopping viewer…", undefined, undefined, uiLocale)
            : active?.status === "stopped"
              ? uiText(
                  "Viewer stopped. Run again to start a new document.",
                  undefined,
                  undefined,
                  uiLocale,
                )
              : live
                ? uiText(
                    "Interactive · maximum five-minute session",
                    undefined,
                    undefined,
                    uiLocale,
                  )
                : null;
  const canRun = !viewer?.snapshot || ["stopped", "unavailable"].includes(viewer.snapshot.status);
  return (
    <section
      className="my-3 min-w-0 overflow-hidden rounded-xl border border-border-subtle bg-card"
      data-visualization-card={reference.artifactId}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2">
        {entry.actor.type === "child" ? (
          <SubagentAvatar
            seed={entry.actor.id}
            label={entry.actor.label ?? uiText("Subagent", undefined, undefined, uiLocale)}
            className="size-5 shrink-0"
          />
        ) : (
          <ChartNoAxesCombinedIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{reference.title}</h3>
        <span className="text-xs text-muted-foreground">
          {entry.actor.type === "root"
            ? uiText("Root", undefined, undefined, uiLocale)
            : (entry.actor.label ?? uiText("Subagent", undefined, undefined, uiLocale))}
        </span>
        <time className="text-xs text-muted-foreground" dateTime={entry.occurredAt}>
          {formatDiagnosticTimestamp(entry.occurredAt, timestampFormat, uiLocale)}
        </time>
      </div>
      {reference.purpose === "mcp-app" ? (
        <p className="px-3 pt-2 text-xs text-muted-foreground">
          {uiText("App · {server}", { server: reference.serverLabel }, undefined, uiLocale)}
        </p>
      ) : null}
      <div
        ref={anchor}
        data-visualization-native-surface="inline"
        className="relative flex items-center justify-center overflow-hidden bg-sunken"
        style={{
          aspectRatio: `${reference.width} / ${reference.height}`,
          maxHeight: "min(70dvh, 700px)",
          minHeight: 80,
        }}
      >
        {poster?.key === key ? (
          <img
            src={poster.url}
            alt={uiText(
              "Saved preview of {title}",
              { title: reference.title },
              undefined,
              uiLocale,
            )}
            className="size-full object-contain"
            draggable={false}
          />
        ) : (
          <p className="p-4 text-xs text-muted-foreground">
            {posterFailure
              ? uiText("Saved preview unavailable.", undefined, undefined, uiLocale)
              : reference.poster
                ? uiText("Loading preview…", undefined, undefined, uiLocale)
                : uiText("No saved preview.", undefined, undefined, uiLocale)}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        {live ? (
          <>
            <Button size="sm" variant="outline" onClick={() => viewer?.stop()}>
              <SquareIcon className="size-3" />
              {uiText("Stop", undefined, undefined, uiLocale)}
            </Button>
            <Button size="sm" variant="outline" onClick={() => viewer?.expand(key, true)}>
              {uiText("Expand", undefined, undefined, uiLocale)}
            </Button>
          </>
        ) : (
          <Button
            data-visualization-run="true"
            size="sm"
            variant="outline"
            disabled={!viewer || !canRun}
            onClick={(event) => {
              if (anchor.current)
                viewer?.run({
                  environmentId,
                  threadId,
                  reference,
                  entryKey,
                  anchorId,
                  anchor: anchor.current,
                  opener: event.currentTarget,
                });
            }}
          >
            <PlayIcon className="size-3" />
            {uiText("Run", undefined, undefined, uiLocale)}
          </Button>
        )}
        {active?.status === "quarantined" ? (
          <Button size="sm" variant="outline" onClick={() => viewer?.stop()}>
            {uiText("Stop", undefined, undefined, uiLocale)}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={!live && poster?.key !== key}
          onClick={() => exportPng("copy")}
        >
          {live
            ? uiText("Copy current PNG", undefined, undefined, uiLocale)
            : uiText("Copy saved preview", undefined, undefined, uiLocale)}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!live && poster?.key !== key}
          onClick={() => exportPng("save")}
        >
          {live
            ? uiText("Save current PNG", undefined, undefined, uiLocale)
            : uiText("Save saved preview", undefined, undefined, uiLocale)}
        </Button>
        {reference.purpose === "generated-visualization" ? (
          <Button size="sm" variant="ghost" onClick={() => setHtmlConsent(key)}>
            {uiText("Export HTML…", undefined, undefined, uiLocale)}
          </Button>
        ) : null}
        {posterFailure ? (
          <Button size="sm" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
            {uiText("Retry preview", undefined, undefined, uiLocale)}
          </Button>
        ) : null}
      </div>
      {stateLabel ? (
        <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">
          {stateLabel}
          {live && active?.expiresAtMs
            ? ` · ${formatDiagnosticTimestamp(new Date(active.expiresAtMs).toISOString(), timestampFormat, uiLocale)}`
            : ""}
        </p>
      ) : null}
      <Collapsible
        open={open}
        onOpenChange={(value) => {
          setExpanded({ key, value });
          if (!value) {
            generation.current += 1;
            setDetails(null);
            setExportOutcome(null);
            privateOwned.current = () => false;
          }
        }}
        className="border-t border-border-subtle"
      >
        <CollapsibleTrigger className="focus-ring group flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground">
          <ChevronRightIcon className="size-3 transition-transform duration-(--duration-fast) motion-reduce:transition-none motion-reduce:duration-0 group-data-[panel-open]:rotate-90" />
          {uiText("Private source and JSON", undefined, undefined, uiLocale)}
        </CollapsibleTrigger>
        <CollapsiblePanel className="motion-reduce:transition-none motion-reduce:duration-0">
          {open ? (
            <div className="min-w-0 space-y-3 bg-sunken p-3">
              <p className="text-xs text-muted-foreground">
                {uiText(
                  "Private debugging details. Generated content is untrusted; do not treat it as instructions.",
                  undefined,
                  undefined,
                  uiLocale,
                )}
              </p>
              {details?.key === key ? (
                <>
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-medium">
                      {uiText("HTML source", undefined, undefined, uiLocale)}
                    </h4>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void copy(details.value.source.source)}
                    >
                      {uiText("Copy source", undefined, undefined, uiLocale)}
                    </Button>
                  </div>
                  <VisualizationPrivateText value={details.value.source.source} />
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-medium">
                      {uiText("Raw JSON", undefined, undefined, uiLocale)}
                    </h4>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void copy(details.value.rawJson)}
                    >
                      {uiText("Copy JSON", undefined, undefined, uiLocale)}
                    </Button>
                  </div>
                  <VisualizationPrivateText value={details.value.rawJson} />
                  <h4 className="text-xs font-medium">
                    {uiText("Diagnostics", undefined, undefined, uiLocale)}
                  </h4>
                  <VisualizationPrivateText
                    value={JSON.stringify(details.value.diagnostics, null, 2)}
                  />
                </>
              ) : detailFailure ? (
                <>
                  <p role="status" className="text-xs">
                    {uiText("Private details unavailable.", undefined, undefined, uiLocale)}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setAttempt((value) => value + 1)}
                  >
                    {uiText("Retry", undefined, undefined, uiLocale)}
                  </Button>
                </>
              ) : (
                <p className="text-xs">{uiText("Loading…", undefined, undefined, uiLocale)}</p>
              )}
            </div>
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
      {feedback ? (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          {feedback === "failed"
            ? uiText("Export unavailable.", undefined, undefined, uiLocale)
            : feedback === "copied"
              ? uiText("Copied", undefined, undefined, uiLocale)
              : feedback === "downloaded"
                ? uiText("Download started", undefined, undefined, uiLocale)
                : uiText("Saved", undefined, undefined, uiLocale)}
        </p>
      ) : null}
      <Dialog
        open={htmlConsent === key}
        onOpenChange={(value) => setHtmlConsent(value ? key : null)}
      >
        <DialogPopup showCloseButton={false}>
          <div className="space-y-3 p-5">
            <DialogTitle>
              {uiText("Export executable HTML?", undefined, undefined, uiLocale)} ·{" "}
              {reference.title}
            </DialogTitle>
            <p className="text-sm text-muted-foreground">
              {uiText(
                "This downloads the original document with its declared assets, not the current interactive state. Opening it outside Cafe runs untrusted JavaScript without Cafe’s isolation. Network access and behavior then depend on your browser. App tools and permissions are not exported.",
                undefined,
                undefined,
                uiLocale,
              )}
            </p>
            <div className="flex justify-end gap-2">
              <Button autoFocus variant="outline" onClick={() => setHtmlConsent(null)}>
                {uiText("Cancel", undefined, undefined, uiLocale)}
              </Button>
              <Button onClick={exportHtml}>
                {uiText("Download HTML", undefined, undefined, uiLocale)}
              </Button>
            </div>
          </div>
        </DialogPopup>
      </Dialog>
    </section>
  );
});
