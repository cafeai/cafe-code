import type { EnvironmentId, ProjectId, WorkspaceObservatoryTreeEntry } from "@cafecode/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ensureEnvironmentApi } from "~/environmentApi";
import { cn } from "~/lib/utils";
import { diffFileLines, type FileLineDiff } from "~/workspaceObservatoryDiff";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

/** Hard ceiling on simultaneously open preview panes, including pending ones. */
export const WORKSPACE_OBSERVATORY_MAX_PANES = 8;

/** Refresh bounds, in seconds. Refresh is opt-in and starts paused. */
export const WORKSPACE_OBSERVATORY_MIN_REFRESH_SECONDS = 2;
export const WORKSPACE_OBSERVATORY_MAX_REFRESH_SECONDS = 60;
const DEFAULT_REFRESH_SECONDS = 5;

/** Changed lines rendered per pane. The diff itself is already bounded. */
export const WORKSPACE_OBSERVATORY_VISIBLE_DIFF_LINES = 12;

interface FilePane {
  /**
   * Unique for the lifetime of the session, not derived from the path. Closing
   * and reopening the same file produces a new id, so a response in flight for
   * the closed pane cannot be applied to the reopened one.
   */
  readonly id: string;
  readonly relativePath: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly redacted: boolean;
  readonly lineDiff?: FileLineDiff;
  readonly refreshedAt: string;
  /** Set when the most recent refresh failed, so values are not current. */
  readonly staleReason?: string;
}

interface WorkspaceObservatoryProps {
  open: boolean;
  environmentId: EnvironmentId | null;
  projectId: ProjectId | null;
  projectName?: string | undefined;
  onOpenChange: (open: boolean) => void;
}

function errorMessageOf(cause: unknown): string {
  if (cause && typeof cause === "object" && "message" in cause) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return "The workspace observatory request was refused.";
}

function parentOf(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index < 0 ? "" : relativePath.slice(0, index);
}

/**
 * Read-only observatory over the selected project's working tree.
 *
 * The server resolves the workspace root from its own projection for
 * `projectId`; this component never sends a filesystem root. Everything shown
 * here is a bounded, best-effort-redacted preview and must not be treated as
 * proof that a file contains no secrets.
 *
 * Diffs describe what changed between two snapshots of one file. They never
 * claim an agent, a provider, or a person caused the change.
 *
 * The session body is mounted under a key built from the environment, the
 * project, and the open state. Changing any of those unmounts the body and
 * mounts a fresh one in the same commit, so pane and tree state are reset
 * synchronously: there is no frame in which the previous project's file
 * contents are still painted. A reset driven by `useEffect` could not offer
 * that, because the effect runs after the browser has already had the chance to
 * paint the old content against the new project.
 */
export function WorkspaceObservatory({
  open,
  environmentId,
  projectId,
  projectName,
  onOpenChange,
}: WorkspaceObservatoryProps) {
  const sessionKey = JSON.stringify([environmentId, projectId, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-5xl" data-testid="workspace-observatory">
        <DialogHeader>
          <DialogTitle>Workspace observatory</DialogTitle>
          <DialogDescription>
            Read-only previews of {projectName ?? "the selected project"}. Hidden, generated, and
            obvious credential paths are withheld, and text masking is best effort rather than a
            guarantee.
          </DialogDescription>
        </DialogHeader>
        {open && environmentId && projectId ? (
          <WorkspaceObservatorySession
            key={sessionKey}
            environmentId={environmentId}
            projectId={projectId}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

interface WorkspaceObservatorySessionProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

function WorkspaceObservatorySession({
  environmentId,
  projectId,
}: WorkspaceObservatorySessionProps) {
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<readonly WorkspaceObservatoryTreeEntry[]>([]);
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [treeRedacted, setTreeRedacted] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [paneError, setPaneError] = useState<string | null>(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const [panes, setPanes] = useState<readonly FilePane[]>([]);
  const [paused, setPaused] = useState(true);
  const [refreshSeconds, setRefreshSeconds] = useState(DEFAULT_REFRESH_SECONDS);

  const panesRef = useRef<readonly FilePane[]>(panes);
  useEffect(() => {
    panesRef.current = panes;
  }, [panes]);

  /**
   * Session liveness. Unmounting bumps it, so every response still in flight is
   * discarded instead of being written into a component that no longer exists.
   * The cleanup is what covers unmount; a dependency-driven effect alone left
   * late responses free to resolve against a dead session.
   */
  const sessionRef = useRef(0);
  useEffect(
    () => () => {
      sessionRef.current += 1;
    },
    [],
  );

  /** Identity of the newest directory request, so older ones cannot win. */
  const directoryRequestRef = useRef(0);
  /** Monotonic pane generation, so reopened panes never reuse an id. */
  const paneGenerationRef = useRef(0);
  /** Paths with a read already in flight, to bound and deduplicate clicks. */
  const pendingPathsRef = useRef<Set<string>>(new Set());

  const observatory = useMemo(() => {
    try {
      return ensureEnvironmentApi(environmentId).workspaceObservatory ?? null;
    } catch {
      return null;
    }
  }, [environmentId]);

  /**
   * Load one directory. Directory responses can resolve out of order, so each
   * request takes an identity and only the newest one is allowed to write state.
   * Without that, a slow listing for a directory the user already navigated away
   * from would replace the newer listing and the breadcrumb would disagree with
   * the entries on screen.
   */
  const loadDirectory = useCallback(
    async (nextDirectory: string) => {
      if (!observatory) return;
      const session = sessionRef.current;
      directoryRequestRef.current += 1;
      const request = directoryRequestRef.current;
      setLoadingTree(true);
      try {
        const result = await observatory.tree({
          projectId,
          ...(nextDirectory === "" ? {} : { relativePath: nextDirectory }),
        });
        if (session !== sessionRef.current || request !== directoryRequestRef.current) return;
        setDirectory(result.relativePath);
        setEntries(result.entries);
        setTreeTruncated(result.truncated);
        setTreeRedacted(result.redacted);
        setTreeError(null);
      } catch (cause) {
        if (session !== sessionRef.current || request !== directoryRequestRef.current) return;
        setTreeError(errorMessageOf(cause));
      } finally {
        if (session === sessionRef.current && request === directoryRequestRef.current) {
          setLoadingTree(false);
        }
      }
    },
    [observatory, projectId],
  );

  useEffect(() => {
    if (!observatory) return;
    void loadDirectory("");
  }, [observatory, loadDirectory]);

  /**
   * Open one preview pane.
   *
   * Pending reads count against the pane ceiling and are deduplicated by path.
   * Checking only the rendered panes let a burst of clicks dispatch an unbounded
   * number of reads before any of them settled, because state had not caught up
   * yet.
   */
  const openFilePane = useCallback(
    async (relativePath: string) => {
      if (!observatory) return;
      const pending = pendingPathsRef.current;
      if (pending.has(relativePath)) return;
      if (panesRef.current.some((pane) => pane.relativePath === relativePath)) return;
      if (panesRef.current.length + pending.size >= WORKSPACE_OBSERVATORY_MAX_PANES) {
        setPaneError(
          `At most ${WORKSPACE_OBSERVATORY_MAX_PANES} panes can be open. Close one first.`,
        );
        return;
      }
      const session = sessionRef.current;
      pending.add(relativePath);
      try {
        const file = await observatory.readFile({ projectId, relativePath });
        if (session !== sessionRef.current) return;
        setPaneError(null);
        paneGenerationRef.current += 1;
        const paneId = `pane:${paneGenerationRef.current}:${file.relativePath}`;
        setPanes((current) => {
          if (current.length >= WORKSPACE_OBSERVATORY_MAX_PANES) return current;
          if (current.some((pane) => pane.relativePath === file.relativePath)) return current;
          const next = [
            ...current,
            {
              id: paneId,
              relativePath: file.relativePath,
              content: file.content,
              truncated: file.truncated,
              redacted: file.redacted,
              refreshedAt: new Date().toISOString(),
            } satisfies FilePane,
          ];
          panesRef.current = next;
          return next;
        });
      } catch (cause) {
        if (session !== sessionRef.current) return;
        setPaneError(errorMessageOf(cause));
      } finally {
        pending.delete(relativePath);
      }
    },
    [observatory, projectId],
  );

  const closePane = useCallback((paneId: string) => {
    setPanes((current) => {
      const next = current.filter((pane) => pane.id !== paneId);
      panesRef.current = next;
      return next;
    });
  }, []);

  /**
   * Bounded refresh. Opt-in, one timer, one read at a time, and fully torn down
   * when the dialog closes or the project changes.
   *
   * Reads are issued one after another rather than as a burst, so a full set of
   * panes cannot exceed the server's own concurrency budget and refuse itself.
   * A read that fails marks its pane stale instead of leaving the previous
   * values on screen looking freshly fetched.
   */
  useEffect(() => {
    if (paused || !observatory) return;
    const session = sessionRef.current;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const intervalMs =
      Math.min(
        WORKSPACE_OBSERVATORY_MAX_REFRESH_SECONDS,
        Math.max(WORKSPACE_OBSERVATORY_MIN_REFRESH_SECONDS, refreshSeconds),
      ) * 1_000;

    const schedule = () => {
      if (active) timer = setTimeout(() => void refresh(), intervalMs);
    };

    const refresh = async () => {
      if (!active || session !== sessionRef.current) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        schedule();
        return;
      }
      const results: {
        paneId: string;
        expectedPath: string;
        content?: string;
        truncated?: boolean;
        redacted?: boolean;
        failure?: string;
      }[] = [];
      for (const pane of panesRef.current) {
        if (!active || session !== sessionRef.current) return;
        try {
          const file = await observatory.readFile({
            projectId,
            relativePath: pane.relativePath,
          });
          results.push({
            paneId: pane.id,
            expectedPath: pane.relativePath,
            content: file.content,
            truncated: file.truncated,
            redacted: file.redacted,
          });
        } catch (cause) {
          results.push({
            paneId: pane.id,
            expectedPath: pane.relativePath,
            failure: errorMessageOf(cause),
          });
        }
      }
      if (!active || session !== sessionRef.current) return;
      const refreshedAt = new Date().toISOString();
      setPanes((current) => {
        const next = current.map((pane) => {
          // Pane ids are unique per open, so a result can only ever apply to the
          // exact pane it was requested for.
          const result = results.find((candidate) => candidate.paneId === pane.id);
          if (!result || pane.relativePath !== result.expectedPath) return pane;
          const { lineDiff: _previousDiff, staleReason: _previousStale, ...base } = pane;
          if (result.failure !== undefined) {
            return { ...base, staleReason: result.failure } satisfies FilePane;
          }
          const lineDiff = diffFileLines(pane.content, result.content ?? "");
          return {
            ...base,
            content: result.content ?? "",
            truncated: result.truncated ?? false,
            redacted: result.redacted ?? false,
            ...(lineDiff.changed ? { lineDiff } : {}),
            refreshedAt,
          } satisfies FilePane;
        });
        panesRef.current = next;
        return next;
      });
      schedule();
    };

    schedule();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [paused, observatory, projectId, refreshSeconds]);

  const breadcrumbs = useMemo(() => {
    const segments = directory.split("/").filter(Boolean);
    return segments.map((segment, index) => ({
      label: segment,
      path: segments.slice(0, index + 1).join("/"),
    }));
  }, [directory]);

  return (
    <DialogPanel className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <section className="min-w-0" aria-label="Workspace tree">
        <nav className="flex flex-wrap items-center gap-1 text-xs" aria-label="Breadcrumb">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void loadDirectory("")}
            data-testid="observatory-breadcrumb-root"
          >
            Project root
          </Button>
          {breadcrumbs.map((crumb) => (
            <Button
              key={crumb.path}
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void loadDirectory(crumb.path)}
            >
              {crumb.label}
            </Button>
          ))}
        </nav>
        {directory === "" ? null : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void loadDirectory(parentOf(directory))}
            data-testid="observatory-up"
          >
            Up one level
          </Button>
        )}
        {treeError ? (
          <p className="text-destructive text-xs" data-testid="observatory-tree-error">
            {treeError}
          </p>
        ) : null}
        {loadingTree ? <p className="text-muted-foreground text-xs">Loading...</p> : null}
        <ul className="mt-2 space-y-0.5" data-testid="observatory-entries">
          {entries.map((entry) => (
            <li key={entry.relativePath}>
              <button
                type="button"
                className="w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-muted"
                data-testid={`observatory-entry-${entry.relativePath}`}
                onClick={() => {
                  if (entry.kind === "directory") {
                    void loadDirectory(entry.relativePath);
                    return;
                  }
                  void openFilePane(entry.relativePath);
                }}
              >
                {entry.kind === "directory" ? "[dir] " : ""}
                {entry.name}
              </button>
            </li>
          ))}
        </ul>
        {treeTruncated ? (
          <p className="text-muted-foreground text-xs" data-testid="observatory-tree-truncated">
            Listing truncated at the entry limit.
          </p>
        ) : null}
        {treeRedacted ? (
          <p className="text-muted-foreground text-xs" data-testid="observatory-tree-redacted">
            Some entries were withheld as hidden, generated, or sensitive.
          </p>
        ) : null}
      </section>

      <section className="min-w-0" aria-label="Observatory panes">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span data-testid="observatory-pane-count">
            {panes.length}/{WORKSPACE_OBSERVATORY_MAX_PANES} panes
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="observatory-toggle-refresh"
            onClick={() => setPaused((current) => !current)}
          >
            {paused ? "Start refresh" : "Pause refresh"}
          </Button>
          <label className="flex items-center gap-1">
            <span>Every</span>
            <input
              type="number"
              className="w-16 rounded border border-border bg-background px-1 py-0.5"
              data-testid="observatory-refresh-seconds"
              min={WORKSPACE_OBSERVATORY_MIN_REFRESH_SECONDS}
              max={WORKSPACE_OBSERVATORY_MAX_REFRESH_SECONDS}
              value={refreshSeconds}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                if (Number.isNaN(parsed)) return;
                setRefreshSeconds(
                  Math.min(
                    WORKSPACE_OBSERVATORY_MAX_REFRESH_SECONDS,
                    Math.max(WORKSPACE_OBSERVATORY_MIN_REFRESH_SECONDS, parsed),
                  ),
                );
              }}
            />
            <span>s</span>
          </label>
        </div>
        {paneError ? (
          <p className="text-destructive text-xs" data-testid="observatory-pane-error">
            {paneError}
          </p>
        ) : null}
        <div
          className={cn("mt-2 grid gap-2", panes.length > 1 ? "xl:grid-cols-2" : "")}
          data-testid="observatory-panes"
        >
          {panes.map((pane) => (
            <article
              key={pane.id}
              className="min-w-0 rounded-xl border border-border/70 p-2"
              data-testid={`observatory-pane-${pane.relativePath}`}
            >
              <header className="flex items-center justify-between gap-2">
                <span className="truncate text-xs">{pane.relativePath}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  data-testid={`observatory-close-${pane.relativePath}`}
                  onClick={() => closePane(pane.id)}
                >
                  Close
                </Button>
              </header>
              {pane.staleReason ? (
                <p
                  className="text-destructive text-xs"
                  data-testid={`observatory-stale-${pane.relativePath}`}
                >
                  Refresh failed, so this preview is stale: {pane.staleReason}
                </p>
              ) : null}
              {pane.redacted ? (
                <p className="text-muted-foreground text-xs">Parts of this preview were masked.</p>
              ) : null}
              {pane.truncated ? (
                <p className="text-muted-foreground text-xs">
                  Preview truncated at the size limit.
                </p>
              ) : null}
              {pane.lineDiff?.changed ? <ObservatoryDiffDetails pane={pane} /> : null}
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[11px]">
                {pane.content}
              </pre>
            </article>
          ))}
        </div>
      </section>
    </DialogPanel>
  );
}

/** Longest single changed line rendered before it is clipped for display. */
const MAX_DIFF_LINE_CHARACTERS = 200;

function clipDiffLine(value: string): string {
  return value.length <= MAX_DIFF_LINE_CHARACTERS
    ? value
    : `${value.slice(0, MAX_DIFF_LINE_CHARACTERS)}...`;
}

/**
 * Bounded before/after detail for one pane's latest snapshot comparison.
 *
 * The diff already computes concrete before and after text for every changed
 * line, and showing only a count made the observatory hard to use: a reader
 * could see that something moved but not what. The rendered slice is bounded
 * twice over, by the number of change entries and by the length of each line, so
 * a large edit cannot turn one pane into an unbounded render.
 *
 * The wording deliberately describes the file, not a cause. The observatory
 * cannot know what wrote the file, and it must not imply that an agent did.
 */
function ObservatoryDiffDetails({ pane }: { readonly pane: FilePane }) {
  const diff = pane.lineDiff;
  if (!diff?.changed) return null;
  const visible = diff.changes.slice(0, WORKSPACE_OBSERVATORY_VISIBLE_DIFF_LINES);
  const hidden = diff.changes.length - visible.length;

  return (
    <div className="mt-1" data-testid={`observatory-diff-wrapper-${pane.relativePath}`}>
      <p
        className="text-muted-foreground text-xs"
        data-testid={`observatory-diff-${pane.relativePath}`}
      >
        {diff.changes.length} line
        {diff.changes.length === 1 ? "" : "s"} changed since the previous snapshot
        {diff.truncated ? " (diff truncated)" : ""}. Cause is not attributed.
      </p>
      <ul
        className="mt-1 space-y-0.5 font-mono text-[10px]"
        data-testid={`observatory-diff-lines-${pane.relativePath}`}
      >
        {visible.map((change) => (
          <li key={`${change.kind}:${change.line}`} className="min-w-0">
            {change.kind === "added" ? (
              <span className="block truncate text-emerald-600 dark:text-emerald-400">
                {`+ ${change.line}: ${clipDiffLine(change.after)}`}
              </span>
            ) : null}
            {change.kind === "removed" ? (
              <span className="block truncate text-destructive">
                {`- ${change.line}: ${clipDiffLine(change.before)}`}
              </span>
            ) : null}
            {change.kind === "changed" ? (
              <>
                <span className="block truncate text-destructive">
                  {`- ${change.line}: ${clipDiffLine(change.before)}`}
                </span>
                <span className="block truncate text-emerald-600 dark:text-emerald-400">
                  {`+ ${change.line}: ${clipDiffLine(change.after)}`}
                </span>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <p
          className="text-muted-foreground text-xs"
          data-testid={`observatory-diff-more-${pane.relativePath}`}
        >
          {hidden} more changed line{hidden === 1 ? "" : "s"} not shown.
        </p>
      ) : null}
    </div>
  );
}
