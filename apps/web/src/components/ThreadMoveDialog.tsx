import type { ProjectId } from "@cafecode/contracts";
import { uiText } from "@cafecode/shared/i18n";
import { useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useUiLocale } from "~/i18n";
import { readEnvironmentApi } from "../environmentApi";
import { supportsStandaloneChats } from "../lib/standaloneChats";
import { canMoveThread, threadMoveCandidates } from "../lib/threadMove";
import { newCommandId } from "../lib/utils";
import { selectProjectsForEnvironment, selectSidebarThreadSummaryByRef, useStore } from "../store";
import { useThreadMoveDialogStore, type ThreadMoveDialogTarget } from "../threadMoveDialogStore";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

export function ThreadMoveDialogHost() {
  const target = useThreadMoveDialogStore((state) => state.target);
  return <ThreadMoveDialog key={target?.id ?? "closed"} target={target} />;
}

function ThreadMoveDialog({ target }: { target: ThreadMoveDialogTarget | null }) {
  const close = () => {
    if (target) useThreadMoveDialogStore.getState().close(target);
  };
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {target ? <ThreadMoveDialogContent target={target} onClose={close} /> : null}
    </Dialog>
  );
}

function ThreadMoveDialogContent({
  target,
  onClose,
}: {
  target: ThreadMoveDialogTarget;
  onClose: () => void;
}) {
  const uiLocale = useUiLocale();
  const { threadRef } = target;
  const thread = useStore((state) => selectSidebarThreadSummaryByRef(state, threadRef));
  const projects = useStore(
    useShallow((state) => selectProjectsForEnvironment(state, threadRef.environmentId)),
  );
  const candidates = thread ? threadMoveCandidates(projects, thread) : [];
  const [sourceProjectId] = useState(thread?.projectId);
  const [openingApi] = useState(() => readEnvironmentApi(threadRef.environmentId));
  const [projectId, setProjectId] = useState<ProjectId | null>(() => candidates[0]?.id ?? null);
  const selected = candidates.find((project) => project.id === projectId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const currentTarget = useRef<ThreadMoveDialogTarget | null>(null);
  useLayoutEffect(() => {
    currentTarget.current = target;
    return () => {
      currentTarget.current = null;
    };
  }, [target]);
  const idle = canMoveThread(thread);
  const associationUnchanged = thread !== undefined && thread.projectId === sourceProjectId;
  const supported = thread?.projectId !== null || supportsStandaloneChats(threadRef.environmentId);

  const submit = async () => {
    if (inFlight.current) return;
    // Re-read after the native menu/chooser awaits. The selected chat, project
    // and transport are captured owners, independent of later route selection.
    const state = useStore.getState();
    const source = selectSidebarThreadSummaryByRef(state, threadRef);
    const destination =
      source &&
      threadMoveCandidates(
        selectProjectsForEnvironment(state, threadRef.environmentId),
        source,
      ).find((project) => project.id === projectId);
    const api = readEnvironmentApi(threadRef.environmentId);
    if (
      !source ||
      !canMoveThread(source) ||
      source.projectId !== sourceProjectId ||
      !destination ||
      !api ||
      api !== openingApi ||
      (source.projectId === null && !supportsStandaloneChats(threadRef.environmentId))
    ) {
      setError(
        uiText(
          "The chat or destination changed. Close this dialog and try again.",
          undefined,
          undefined,
          uiLocale,
        ),
      );
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: threadRef.threadId,
        projectId: destination.id,
        worktreePath: null,
      });
      // The projection moves the same chat; it does not copy its transcript,
      // open another tab, replay input or transfer workspace files.
      onClose();
    } catch {
      if (currentTarget.current === target)
        setError(
          uiText(
            "Could not move chat. Check its connection and current activity before trying again.",
            undefined,
            undefined,
            uiLocale,
          ),
        );
    } finally {
      inFlight.current = false;
      if (currentTarget.current === target) setSubmitting(false);
    }
  };

  return (
    <DialogPopup className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{uiText("Move chat", undefined, undefined, uiLocale)}</DialogTitle>
        <DialogDescription>
          {uiText(
            'Choose a project for "{title}".',
            { title: thread?.title ?? "" },
            undefined,
            uiLocale,
          )}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        <Select
          value={projectId ?? ""}
          onValueChange={(value) => {
            const next = candidates.find((candidate) => candidate.id === value);
            if (next) {
              setProjectId(next.id);
              setError(null);
            }
          }}
          disabled={submitting || candidates.length === 0}
        >
          <SelectTrigger
            className="w-full"
            aria-label={uiText("Destination project folder", undefined, undefined, uiLocale)}
          >
            <SelectValue>
              {selected?.name ?? uiText("Choose a project folder", undefined, undefined, uiLocale)}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {candidates.map((project) => (
              <SelectItem hideIndicator key={project.id} value={project.id}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{project.name}</span>
                  <span className="truncate text-xs text-subtle-foreground">{project.cwd}</span>
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <p className="text-xs text-muted-foreground">
          {uiText(
            "Future work uses the destination folder. Existing workspace files stay in place.",
            undefined,
            undefined,
            uiLocale,
          )}
        </p>
        {!idle || !associationUnchanged || !supported || candidates.length === 0 || error ? (
          <p role="status" className="text-xs text-muted-foreground">
            {error ??
              (!idle
                ? uiText(
                    "Wait until this chat is idle before moving it.",
                    undefined,
                    undefined,
                    uiLocale,
                  )
                : !associationUnchanged
                  ? uiText(
                      "This chat changed project. Close this dialog and try again.",
                      undefined,
                      undefined,
                      uiLocale,
                    )
                  : !supported
                    ? uiText(
                        "Update this environment to move standalone chats into projects.",
                        undefined,
                        undefined,
                        uiLocale,
                      )
                    : uiText(
                        "Add a project in this environment first.",
                        undefined,
                        undefined,
                        uiLocale,
                      ))}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {uiText("Cancel", undefined, undefined, uiLocale)}
        </Button>
        <Button
          disabled={submitting || !selected || !idle || !associationUnchanged || !supported}
          onClick={() => void submit()}
        >
          {submitting
            ? uiText("Moving…", undefined, undefined, uiLocale)
            : uiText("Move", undefined, undefined, uiLocale)}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}
