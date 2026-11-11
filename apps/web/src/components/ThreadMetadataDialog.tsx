import { useUiLocale } from "~/i18n";
import { uiText, type UiLocale } from "@cafecode/shared/i18n";
import {
  THREAD_DESCRIPTION_MAX_CHARS,
  type ScopedThreadRef,
  type ThreadCreationPath,
  type ThreadOriginClassification,
} from "@cafecode/contracts";
import { scopeThreadRef } from "@cafecode/client-runtime";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { retainThreadDetailSubscription } from "../environments/runtime/service";
import { useThreadActions } from "../hooks/useThreadActions";
import { cn } from "../lib/utils";
import {
  selectSidebarThreadSummaryByRef,
  selectSidebarThreadsForEnvironment,
  selectThreadOrganizationByRef,
  useStore,
} from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
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
import { SegmentedControl } from "./ui/segmented-control";
import { Textarea } from "./ui/textarea";
import { stackedThreadToast, toastManager } from "./ui/toast";

const DISALLOWED_DESCRIPTION_CHARS = /(?:(?![\n\t])[\p{Cc}\p{Bidi_Control}])/u;

export interface ThreadMetadataDialogTarget {
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
}

/** One dialog for every sidebar surface; opening it never changes a chat. */
export const useThreadMetadataDialogStore = create<{
  readonly target: ThreadMetadataDialogTarget | null;
  readonly open: (target: ThreadMetadataDialogTarget) => void;
  readonly close: () => void;
}>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

export function ThreadMetadataDialogHost() {
  const target = useThreadMetadataDialogStore((state) => state.target);
  const close = useThreadMetadataDialogStore((state) => state.close);
  return <ThreadMetadataDialog target={target} onClose={close} />;
}

/**
 * Edit a chat's origin label and description. The label is a correction a
 * person makes; the recorded provenance below it is a separate, immutable
 * server fact and is shown read-only. Neither grants any authority.
 * Sectioned so later metadata fields can join without reshaping the dialog.
 */
export function ThreadMetadataDialog({
  target,
  onClose,
}: {
  target: ThreadMetadataDialogTarget | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {target ? <ThreadMetadataDialogContent target={target} onClose={onClose} /> : null}
    </Dialog>
  );
}

function ThreadMetadataDialogContent({
  target,
  onClose,
}: {
  target: ThreadMetadataDialogTarget;
  onClose: () => void;
}) {
  const uiLocale = useUiLocale();
  const { updateThreadMetadata } = useThreadActions();
  const { environmentId, threadId } = target.threadRef;

  // Description and provenance are detail-only; retain the shared,
  // ref-counted detail subscription only while the dialog is open.
  useEffect(
    () => retainThreadDetailSubscription(environmentId, threadId),
    [environmentId, threadId],
  );
  const organization = useStore((state) => selectThreadOrganizationByRef(state, target.threadRef));
  const summary = useStore((state) => selectSidebarThreadSummaryByRef(state, target.threadRef));
  const environmentThreads = useStore(
    useShallow((state) => selectSidebarThreadsForEnvironment(state, environmentId)),
  );

  const recordedOrigin = organization?.origin ?? summary?.origin ?? null;
  // Null means "not edited": show the latest saved value until the person
  // changes a field, after which server updates never overwrite their input.
  const [editedClassification, setClassification] = useState<ThreadOriginClassification | null>(
    null,
  );
  const [editedDescription, setDescription] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const classification = editedClassification ?? organization?.origin?.classification ?? "unknown";
  const description = editedDescription ?? organization?.description ?? "";

  const loaded = organization !== undefined;
  const trimmed = description.trim();
  const descriptionTooLong = trimmed.length > THREAD_DESCRIPTION_MAX_CHARS;
  const descriptionInvalid = DISALLOWED_DESCRIPTION_CHARS.test(trimmed);
  const originalDescription = organization?.description ?? "";
  const originalClassification = organization?.origin?.classification ?? "unknown";
  const changed =
    loaded && (trimmed !== originalDescription || classification !== originalClassification);

  const provenance = organization?.provenance ?? null;
  const originThreadId = provenance?.originThreadId;
  const originThread = useMemo(
    () =>
      originThreadId
        ? environmentThreads.find((thread) => thread.id === originThreadId)
        : undefined,
    [environmentThreads, originThreadId],
  );
  const group = useMemo(() => {
    const groupId = summary?.groupId ?? organization?.groupId ?? null;
    if (!groupId) return null;
    for (const thread of environmentThreads) {
      const owned = thread.ownedGroups?.find((entry) => entry.id === groupId);
      if (owned) return { title: owned.title, ownerTitle: thread.title };
    }
    return null;
  }, [environmentThreads, organization?.groupId, summary?.groupId]);

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(uiLocale, { dateStyle: "medium", timeStyle: "short" }),
    [uiLocale],
  );

  const save = async () => {
    if (!changed || descriptionTooLong || descriptionInvalid) return;
    setPending(true);
    try {
      await updateThreadMetadata(target.threadRef, {
        ...(classification !== originalClassification
          ? { originClassification: classification }
          : {}),
        ...(trimmed !== originalDescription
          ? { description: trimmed.length === 0 ? null : trimmed }
          : {}),
      });
      onClose();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: uiText("Could not save chat metadata", undefined, undefined, uiLocale),
          description:
            error instanceof Error
              ? error.message
              : uiText("Try again.", undefined, undefined, uiLocale),
        }),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <DialogPopup className="max-w-md" data-testid="thread-metadata-dialog">
      <DialogHeader>
        <DialogTitle>{uiText("Edit metadata", undefined, undefined, uiLocale)}</DialogTitle>
        <DialogDescription>
          {uiText('"{title}"', { title: target.title }, undefined, uiLocale)}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="grid gap-5">
        {!loaded ? (
          <p className="text-sm text-muted-foreground">
            {uiText("Loading…", undefined, undefined, uiLocale)}
          </p>
        ) : (
          <>
            <div className="grid gap-1.5">
              <span className="font-medium text-sm">
                {uiText("Created by", undefined, undefined, uiLocale)}
              </span>
              <SegmentedControl<ThreadOriginClassification>
                aria-label={uiText("Created by", undefined, undefined, uiLocale)}
                value={classification}
                onValueChange={setClassification}
                options={[
                  { value: "human", label: uiText("Human", undefined, undefined, uiLocale) },
                  { value: "agent", label: uiText("Agent", undefined, undefined, uiLocale) },
                  { value: "unknown", label: uiText("Unknown", undefined, undefined, uiLocale) },
                ]}
              />
              {recordedOrigin?.source === "user" ? (
                <span className="text-xs text-muted-foreground">
                  {uiText("You set this label.", undefined, undefined, uiLocale)}
                </span>
              ) : null}
            </div>

            <label className="grid gap-1.5">
              <span className="font-medium text-sm">
                {uiText("Description", undefined, undefined, uiLocale)}
              </span>
              <Textarea
                value={description}
                rows={4}
                aria-invalid={descriptionTooLong || descriptionInvalid ? "true" : undefined}
                data-testid="thread-metadata-description"
                onChange={(event) => setDescription(event.currentTarget.value)}
              />
              <span
                className={cn(
                  "text-xs text-muted-foreground",
                  (descriptionTooLong || descriptionInvalid) && "text-destructive",
                )}
              >
                {descriptionInvalid
                  ? uiText(
                      "Remove control characters from the description.",
                      undefined,
                      undefined,
                      uiLocale,
                    )
                  : `${trimmed.length} / ${THREAD_DESCRIPTION_MAX_CHARS}`}
              </span>
            </label>

            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t border-border-subtle pt-4 text-sm">
              <dt className="text-muted-foreground">
                {uiText("Recorded", undefined, undefined, uiLocale)}
              </dt>
              <dd data-testid="thread-metadata-provenance">
                {provenance ? (
                  <>
                    {creationPathLabel(provenance.creationPath, uiLocale)}
                    {provenance.originThreadId ? (
                      <>
                        {" · "}
                        {originThread ? (
                          <Link
                            to="/$environmentId/$threadId"
                            params={buildThreadRouteParams(
                              scopeThreadRef(environmentId, originThread.id),
                            )}
                            className="underline underline-offset-2"
                            onClick={onClose}
                          >
                            {originThread.title}
                          </Link>
                        ) : (
                          uiText("a chat that is no longer listed", undefined, undefined, uiLocale)
                        )}
                      </>
                    ) : null}
                    <span className="block text-xs text-muted-foreground">
                      {dateFormatter.format(new Date(provenance.recordedAt))}
                    </span>
                  </>
                ) : (
                  uiText("Not recorded", undefined, undefined, uiLocale)
                )}
              </dd>
              {group ? (
                <>
                  <dt className="text-muted-foreground">
                    {uiText("Group", undefined, undefined, uiLocale)}
                  </dt>
                  <dd>
                    {uiText(
                      'In "{group}", owned by "{owner}"',
                      { group: group.title, owner: group.ownerTitle },
                      undefined,
                      uiLocale,
                    )}
                  </dd>
                </>
              ) : null}
            </dl>
          </>
        )}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" disabled={pending} onClick={onClose}>
          {uiText("Cancel", undefined, undefined, uiLocale)}
        </Button>
        <Button
          disabled={!changed || pending || descriptionTooLong || descriptionInvalid}
          onClick={() => void save()}
          data-testid="thread-metadata-save"
        >
          {uiText("Save", undefined, undefined, uiLocale)}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}

/** Recorded creation paths; "Cafe tools" never claims a native subagent. */
function creationPathLabel(path: ThreadCreationPath, uiLocale: UiLocale) {
  switch (path) {
    case "cafe-ui":
      return uiText("Created in Cafe", undefined, undefined, uiLocale);
    case "mcp-launch":
      return uiText("Created through Cafe tools by a session of", undefined, undefined, uiLocale);
    case "mcp-owner-client":
      return uiText(
        "Created through Cafe tools by an external client",
        undefined,
        undefined,
        uiLocale,
      );
    case "fork":
      return uiText("Forked from", undefined, undefined, uiLocale);
    case "duplicate":
      return uiText("Duplicated from", undefined, undefined, uiLocale);
    case "server":
      return uiText("Created by Cafe", undefined, undefined, uiLocale);
  }
}
