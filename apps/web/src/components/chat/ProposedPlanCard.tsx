import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import { memo, useEffect, useState, useId } from "react";
import type { EnvironmentId } from "@cafecode/contracts";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../../proposedPlan";
import ChatMarkdown from "../ChatMarkdown";
import { EllipsisIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { readEnvironmentApi } from "~/environmentApi";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planMarkdown,
  environmentId,
  cwd,
  workspaceRoot,
}: {
  planMarkdown: string;
  environmentId: EnvironmentId;
  cwd: string | undefined;
  workspaceRoot: string | undefined;
}) {
  const uiLocale = useUiLocale();

  const [expanded, setExpanded] = useState(false);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [savePath, setSavePath] = useState("");
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  // Inline, transient confirmation of a workspace save (no success toast).
  const [savedRelativePath, setSavedRelativePath] = useState<string | null>(null);
  useEffect(() => {
    if (savedRelativePath === null) return;
    const timer = window.setTimeout(() => setSavedRelativePath(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [savedRelativePath]);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: uiText("Could not copy plan", undefined, undefined, uiLocale),
          description:
            error instanceof Error
              ? error.message
              : uiText("An error occurred while copying.", undefined, undefined, uiLocale),
        }),
      );
    },
  });
  const savePathInputId = useId();
  const title =
    proposedPlanTitle(planMarkdown) ?? uiText("Proposed plan", undefined, undefined, uiLocale);
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
    : null;
  const downloadFilename = buildProposedPlanMarkdownFilename(planMarkdown);
  const saveContents = normalizePlanMarkdownForExport(planMarkdown);

  const handleDownload = () => {
    downloadPlanAsTextFile(downloadFilename, saveContents);
  };

  const handleCopyPlan = () => {
    copyToClipboard(saveContents);
  };

  const openSaveDialog = () => {
    if (!workspaceRoot) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: uiText("Workspace path is unavailable", undefined, undefined, uiLocale),
          description: uiText(
            "This chat doesn''t have a workspace to save into.",
            undefined,
            undefined,
            uiLocale,
          ),
        }),
      );
      return;
    }
    setSavePath((existing) => (existing.length > 0 ? existing : downloadFilename));
    setIsSaveDialogOpen(true);
  };

  const handleSaveToWorkspace = () => {
    const api = readEnvironmentApi(environmentId);
    const relativePath = savePath.trim();
    if (!api || !workspaceRoot) {
      return;
    }
    if (!relativePath) {
      toastManager.add({
        type: "warning",
        title: uiText("Enter a workspace path", undefined, undefined, uiLocale),
      });
      return;
    }

    setIsSavingToWorkspace(true);
    void api.projects
      .writeFile({
        cwd: workspaceRoot,
        relativePath,
        contents: saveContents,
      })
      .then((result) => {
        setIsSaveDialogOpen(false);
        setSavedRelativePath(result.relativePath);
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText("Could not save plan", undefined, undefined, uiLocale),
            description:
              error instanceof Error
                ? error.message
                : uiText("An error occurred while saving.", undefined, undefined, uiLocale),
          }),
        );
      })
      .then(
        () => {
          setIsSavingToWorkspace(false);
        },
        () => {
          setIsSavingToWorkspace(false);
        },
      );
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">{uiText("Plan", undefined, undefined, uiLocale)}</Badge>
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
        </div>
        {savedRelativePath ? (
          <p
            role="status"
            className="ml-auto min-w-0 truncate text-2xs text-subtle-foreground animate-enter-fade"
            title={savedRelativePath}
          >
            <UiMessage message={"Saved to <slot1></slot1>"} slots={{ slot1: savedRelativePath }} />
          </p>
        ) : null}
        <Menu>
          <MenuTrigger
            render={
              <Button
                aria-label={uiText("Plan actions", undefined, undefined, uiLocale)}
                size="icon-xs"
                variant="outline"
              />
            }
          >
            <EllipsisIcon aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={handleCopyPlan}>
              {isCopied
                ? uiText("Copied", undefined, undefined, uiLocale)
                : uiText("Copy to clipboard", undefined, undefined, uiLocale)}
            </MenuItem>
            <MenuItem onClick={handleDownload}>
              {uiText("Download as markdown", undefined, undefined, uiLocale)}
            </MenuItem>
            <MenuItem onClick={openSaveDialog} disabled={!workspaceRoot || isSavingToWorkspace}>
              {uiText("Save to workspace", undefined, undefined, uiLocale)}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="mt-4">
        <div className={cn("relative", canCollapse && !expanded && "max-h-104 overflow-hidden")}>
          {canCollapse && !expanded ? (
            <ChatMarkdown text={collapsedPreview ?? ""} cwd={cwd} isStreaming={false} />
          ) : (
            <ChatMarkdown text={displayedPlanMarkdown} cwd={cwd} isStreaming={false} />
          )}
          {canCollapse && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded
                ? uiText("Collapse plan", undefined, undefined, uiLocale)
                : uiText("Expand plan", undefined, undefined, uiLocale)}
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog
        open={isSaveDialogOpen}
        onOpenChange={(open) => {
          if (!isSavingToWorkspace) {
            setIsSaveDialogOpen(open);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {uiText("Save plan to workspace", undefined, undefined, uiLocale)}
            </DialogTitle>
            <DialogDescription>
              <UiMessage
                message={"Enter a path relative to <slot1></slot1>."}
                slots={{
                  slot1: (
                    <code>
                      {workspaceRoot ?? uiText("the workspace", undefined, undefined, uiLocale)}
                    </code>
                  ),
                }}
              />
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <label htmlFor={savePathInputId} className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">
                {uiText("Workspace path", undefined, undefined, uiLocale)}
              </span>
              <Input
                id={savePathInputId}
                value={savePath}
                onChange={(event) => setSavePath(event.target.value)}
                placeholder={downloadFilename}
                spellCheck={false}
                disabled={isSavingToWorkspace}
              />
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsSaveDialogOpen(false)}
              disabled={isSavingToWorkspace}
            >
              {uiText("Cancel", undefined, undefined, uiLocale)}
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSaveToWorkspace()}
              disabled={isSavingToWorkspace}
            >
              {isSavingToWorkspace
                ? uiText("Saving…", undefined, undefined, uiLocale)
                : uiText("Save", undefined, undefined, uiLocale)}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});
