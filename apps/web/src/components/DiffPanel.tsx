import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useSearch } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Columns2Icon,
  ExternalLinkIcon,
  PilcrowIcon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { openInPreferredEditor } from "../editorPreferences";
import { refreshGitStatus, useGitStatus } from "~/lib/gitStatusState";
import { cn } from "~/lib/utils";
import { readLocalApi } from "../localApi";
import { readEnvironmentApi } from "../environmentApi";
import { resolvePathLinkTarget } from "../path-links";
import { parseDiffRouteSearch } from "../diffRouteSearch";
import { useTheme } from "../hooks/useTheme";
import { buildPatchCacheKey } from "../lib/diffRendering";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { selectProjectByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteRef } from "../threadRoutes";
import { useSettings } from "../hooks/useSettings";
import {
  type FileDiffRenderGuard,
  formatDiffMetric,
  resolveFileDiffRenderGuard,
} from "./DiffPanel.logic";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { ToggleGroup, Toggle } from "./ui/toggle-group";

type DiffRenderMode = "stacked" | "split";
type DiffThemeType = "light" | "dark";

const DIFF_PANEL_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 80%,
    var(--destructive)
  );

  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-bottom: 1px solid var(--border) !important;
}

[data-title] {
  cursor: pointer;
  transition:
    color 120ms ease,
    text-decoration-color 120ms ease;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
}

[data-title]:hover {
  color: color-mix(in srgb, var(--foreground) 84%, var(--primary)) !important;
  text-decoration-color: currentColor;
}
`;

type RenderablePatch =
  | {
      kind: "files";
      files: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };

function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  if (!patch) return null;
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return null;

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (files.length > 0) {
      return { kind: "files", files };
    }

    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

function getDiffCollapseIconClassName(fileDiff: FileDiffMetadata): string {
  switch (fileDiff.type) {
    case "new":
      return "text-[var(--diffs-addition-base)]";
    case "deleted":
      return "text-[var(--diffs-deletion-base)]";
    case "change":
    case "rename-pure":
    case "rename-changed":
      return "text-[var(--diffs-modified-base)]";
    default:
      return "text-muted-foreground/80";
  }
}

class DiffFileRenderBoundary extends Component<
  {
    readonly children: ReactNode;
    readonly filePath: string;
    readonly onOpenFile: () => void;
  },
  { readonly errorMessage: string | null }
> {
  override state = { errorMessage: null };

  static getDerivedStateFromError(error: unknown) {
    return {
      errorMessage: error instanceof Error ? error.message : "The file diff renderer failed.",
    };
  }

  override componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    console.warn("Diff file renderer failed.", {
      componentStack: errorInfo.componentStack,
      error,
      filePath: this.props.filePath,
    });
  }

  override render() {
    if (this.state.errorMessage) {
      return (
        <DiffFileFallback
          filePath={this.props.filePath}
          onOpenFile={this.props.onOpenFile}
          reason="The rich diff renderer failed for this file."
          details={this.state.errorMessage}
        />
      );
    }

    return this.props.children;
  }
}

function DiffFileFallback(props: {
  readonly details?: string;
  readonly filePath: string;
  readonly guard?: FileDiffRenderGuard;
  readonly onOpenFile: () => void;
  readonly reason: string;
}) {
  const { details, filePath, guard, onOpenFile, reason } = props;
  const metrics =
    guard && !guard.shouldRenderRichDiff
      ? [
          `${formatDiffMetric(guard.visualLineCount)} visual lines`,
          `${formatDiffMetric(guard.changedLineCount)} changed lines`,
          `${formatDiffMetric(guard.totalChangedChars)} changed chars`,
          `${formatDiffMetric(guard.maxChangedLineChars)} max line chars`,
        ]
      : [];

  return (
    <div className="my-2 rounded-md border border-border/70 bg-card/35 px-3 py-2 text-xs">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground">{filePath || "Unnamed file"}</div>
          <p className="mt-1 leading-5 text-muted-foreground">
            {reason} Cafe skipped rich rendering for this file to keep the chat window responsive.
          </p>
          {metrics.length > 0 ? (
            <p className="mt-1 text-[11px] text-muted-foreground/75">{metrics.join(" · ")}</p>
          ) : null}
          {details ? (
            <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground/75">{details}</p>
          ) : null}
        </div>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={onOpenFile}
        >
          <ExternalLinkIcon className="size-3" />
          Open
        </button>
      </div>
    </div>
  );
}

interface DiffPanelProps {
  mode?: DiffPanelMode;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

function DiffUpdatingOverlay() {
  return (
    <div
      className="cafe-diff-updating-overlay pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border border-border/60 bg-background/70 backdrop-blur-md"
      role="status"
      aria-live="polite"
      aria-label="Checking your current changes"
    >
      <div className="cafe-shutdown-card max-w-[260px] px-5 py-4 text-center">
        <div className="cafe-shutdown-spinner mx-auto mb-3" aria-hidden="true" />
        <p className="text-sm font-semibold text-foreground">Checking your changes...</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Fresh diff coming up <span className="text-[#49d3f2]">♥</span>
        </p>
      </div>
    </div>
  );
}

export default function DiffPanel({ mode = "inline" }: DiffPanelProps) {
  const { resolvedTheme } = useTheme();
  const settings = useSettings();
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [diffWordWrap, setDiffWordWrap] = useState(settings.diffWordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const [collapsedDiffFileKeys, setCollapsedDiffFileKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const previousDiffOpenRef = useRef(false);
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const diffSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const diffOpen = diffSearch.diff === "1";
  const activeThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeThread && activeProjectId
      ? selectProjectByRef(store, {
          environmentId: activeThread.environmentId,
          projectId: activeProjectId,
        })
      : undefined,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.cwd;
  const gitStatusQuery = useGitStatus({
    environmentId: diffOpen ? (activeThread?.environmentId ?? null) : null,
    cwd: diffOpen ? (activeCwd ?? null) : null,
  });
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const workingTreeFiles = gitStatusQuery.data?.workingTree.files ?? [];
  const activeWorkingTreeDiffQuery = useQuery({
    queryKey: [
      "vcs",
      "workingTreeDiff",
      activeThread?.environmentId ?? null,
      activeCwd ?? null,
      diffIgnoreWhitespace,
    ],
    enabled:
      diffOpen && isGitRepo && activeThread?.environmentId !== undefined && activeCwd !== undefined,
    queryFn: async () => {
      if (!activeThread?.environmentId || !activeCwd) {
        throw new Error("Cannot load working tree diff without an active workspace.");
      }
      const api = readEnvironmentApi(activeThread.environmentId);
      if (!api) {
        throw new Error(`Environment API not found for environment ${activeThread.environmentId}.`);
      }
      return await api.vcs.workingTreeDiff({
        cwd: activeCwd,
        ignoreWhitespace: diffIgnoreWhitespace,
      });
    },
  });
  const workingTreeDiffError =
    activeWorkingTreeDiffQuery.error instanceof Error
      ? activeWorkingTreeDiffQuery.error.message
      : activeWorkingTreeDiffQuery.error
        ? "Failed to load current changes."
        : null;

  const selectedFilePath = diffSearch.diffFilePath ?? null;
  const selectedPatch = activeWorkingTreeDiffQuery.data?.diff;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoTrackedPatch = hasResolvedPatch && selectedPatch.trim().length === 0;
  const isUpdatingChanges =
    diffOpen && (gitStatusQuery.isPending || activeWorkingTreeDiffQuery.isFetching);
  const renderablePatch = useMemo(
    () => getRenderablePatch(selectedPatch, `diff-panel:${resolvedTheme}`),
    [resolvedTheme, selectedPatch],
  );
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);

  useEffect(() => {
    if (renderableFiles.length === 0) {
      setCollapsedDiffFileKeys((current) => (current.size === 0 ? current : new Set()));
      return;
    }

    const visibleFileKeys = new Set(renderableFiles.map(buildFileDiffRenderKey));
    setCollapsedDiffFileKeys((current) => {
      const next = new Set([...current].filter((fileKey) => visibleFileKeys.has(fileKey)));
      return next.size === current.size ? current : next;
    });
  }, [renderableFiles]);

  useEffect(() => {
    if (diffOpen && !previousDiffOpenRef.current) {
      setDiffWordWrap(settings.diffWordWrap);
      setDiffIgnoreWhitespace(settings.diffIgnoreWhitespace);
      void refreshGitStatus({
        environmentId: activeThread?.environmentId ?? null,
        cwd: activeCwd ?? null,
      });
    }
    previousDiffOpenRef.current = diffOpen;
  }, [
    activeCwd,
    activeThread?.environmentId,
    diffOpen,
    settings.diffIgnoreWhitespace,
    settings.diffWordWrap,
  ]);

  useEffect(() => {
    if (!selectedFilePath || !patchViewportRef.current) {
      return;
    }
    const target = Array.from(
      patchViewportRef.current.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
    ).find((element) => element.dataset.diffFilePath === selectedFilePath);
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedFilePath, renderableFiles]);

  const openDiffFileInEditor = useCallback(
    (filePath: string) => {
      const api = readLocalApi();
      if (!api) return;
      const targetPath = activeCwd ? resolvePathLinkTarget(filePath, activeCwd) : filePath;
      void openInPreferredEditor(api, targetPath).catch((error) => {
        console.warn("Failed to open diff file in editor.", error);
      });
    },
    [activeCwd],
  );
  const toggleDiffFileCollapsed = useCallback((fileKey: string) => {
    setCollapsedDiffFileKeys((current) => {
      const next = new Set(current);
      if (next.has(fileKey)) {
        next.delete(fileKey);
      } else {
        next.add(fileKey);
      }
      return next;
    });
  }, []);

  const headerRow = (
    <>
      <div className="min-w-0 flex-1 [-webkit-app-region:no-drag]">
        <div className="truncate text-xs font-semibold text-foreground">Current changes</div>
        <div className="truncate text-[10px] text-muted-foreground/75">
          {workingTreeFiles.length === 0
            ? "No files changed"
            : `${workingTreeFiles.length} file${workingTreeFiles.length === 1 ? "" : "s"} changed`}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <ToggleGroup
          className="shrink-0"
          variant="outline"
          size="xs"
          value={[diffRenderMode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split") {
              setDiffRenderMode(next);
            }
          }}
        >
          <Toggle aria-label="Stacked diff view" value="stacked">
            <Rows3Icon className="size-3" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split">
            <Columns2Icon className="size-3" />
          </Toggle>
        </ToggleGroup>
        <Toggle
          aria-label={diffWordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
          title={diffWordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          variant="outline"
          size="xs"
          pressed={diffWordWrap}
          onPressedChange={(pressed) => {
            setDiffWordWrap(Boolean(pressed));
          }}
        >
          <TextWrapIcon className="size-3" />
        </Toggle>
        <Toggle
          aria-label={diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          title={diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          variant="outline"
          size="xs"
          pressed={diffIgnoreWhitespace}
          onPressedChange={(pressed) => {
            setDiffIgnoreWhitespace(Boolean(pressed));
          }}
        >
          <PilcrowIcon className="size-3" />
        </Toggle>
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect current changes.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Current changes are unavailable because this project is not a git repository.
        </div>
      ) : (
        <div className="relative min-h-0 min-w-0 flex-1">
          <div
            ref={patchViewportRef}
            className="diff-panel-viewport h-full min-h-0 min-w-0 overflow-hidden"
          >
            {workingTreeDiffError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-[11px] text-red-500/80">{workingTreeDiffError}</p>
              </div>
            )}
            {!renderablePatch ? (
              <div className="flex h-full items-center justify-center px-3 py-2 text-center text-xs text-muted-foreground/70">
                <p>
                  {hasNoTrackedPatch
                    ? workingTreeFiles.length > 0
                      ? "No tracked patch to show. Untracked files are visible in Git status but are not rendered as a patch here."
                      : "No uncommitted changes."
                    : "No patch available for the current working tree."}
                </p>
              </div>
            ) : renderablePatch.kind === "files" ? (
              <Virtualizer
                className="diff-render-surface h-full min-h-0 overflow-auto px-2 pb-2"
                config={{
                  overscrollSize: 600,
                  intersectionObserverMargin: 1200,
                }}
              >
                {renderableFiles.map((fileDiff) => {
                  const filePath = resolveFileDiffPath(fileDiff);
                  const fileKey = buildFileDiffRenderKey(fileDiff);
                  const themedFileKey = `${fileKey}:${resolvedTheme}`;
                  const collapsed = collapsedDiffFileKeys.has(fileKey);
                  const renderGuard = resolveFileDiffRenderGuard(fileDiff);
                  const onOpenFile = () => openDiffFileInEditor(filePath);
                  return (
                    <div
                      key={themedFileKey}
                      data-diff-file-path={filePath}
                      className="diff-render-file group/diff-file mb-2 rounded-md first:mt-2 last:mb-0"
                      onClickCapture={(event) => {
                        const nativeEvent = event.nativeEvent as MouseEvent;
                        const composedPath = nativeEvent.composedPath?.() ?? [];
                        const clickedHeader = composedPath.some((node) => {
                          if (!(node instanceof Element)) return false;
                          return node.hasAttribute("data-title");
                        });
                        if (!clickedHeader) return;
                        onOpenFile();
                      }}
                    >
                      {!renderGuard.shouldRenderRichDiff ? (
                        <DiffFileFallback
                          filePath={filePath}
                          guard={renderGuard}
                          onOpenFile={onOpenFile}
                          reason={renderGuard.reason ?? "This file diff is too large."}
                        />
                      ) : (
                        <DiffFileRenderBoundary filePath={filePath} onOpenFile={onOpenFile}>
                          <FileDiff
                            fileDiff={fileDiff}
                            renderHeaderPrefix={() => (
                              <button
                                type="button"
                                className={cn(
                                  "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors hover:bg-foreground/10 focus-visible:outline-hidden",
                                  getDiffCollapseIconClassName(fileDiff),
                                )}
                                aria-label={
                                  collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`
                                }
                                aria-expanded={!collapsed}
                                title={collapsed ? "Expand diff" : "Collapse diff"}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleDiffFileCollapsed(fileKey);
                                }}
                              >
                                {collapsed ? (
                                  <ChevronRightIcon className="size-4" />
                                ) : (
                                  <ChevronDownIcon className="size-4" />
                                )}
                              </button>
                            )}
                            options={{
                              collapsed,
                              diffStyle: diffRenderMode === "split" ? "split" : "unified",
                              lineDiffType: "none",
                              overflow: diffWordWrap ? "wrap" : "scroll",
                              theme: resolveDiffThemeName(resolvedTheme),
                              themeType: resolvedTheme as DiffThemeType,
                              unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
                            }}
                          />
                        </DiffFileRenderBoundary>
                      )}
                    </div>
                  );
                })}
              </Virtualizer>
            ) : (
              <div className="h-full overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
                  <pre
                    className={cn(
                      "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
                      diffWordWrap
                        ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                        : "overflow-auto",
                    )}
                  >
                    {renderablePatch.text}
                  </pre>
                </div>
              </div>
            )}
          </div>
          {isUpdatingChanges && <DiffUpdatingOverlay />}
        </div>
      )}
    </DiffPanelShell>
  );
}
