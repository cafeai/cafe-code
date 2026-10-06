import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { ScopedThreadRef } from "@cafecode/contracts";
import { threadHasStarted } from "../components/ChatView.logic";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { createThreadSelectorByRef } from "../storeSelectors";
import { useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { useDeskStore } from "../deskStore";

function DraftChatThreadRouteView() {
  const navigate = useNavigate();
  const { draftId: rawDraftId } = Route.useParams();
  const draftId = DraftId.make(rawDraftId);
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const ownsPendingEditor = useDeskStore((store) => Boolean(store.draftEditors[draftId]));
  const [capturedThread, setCapturedThread] = useState<{
    draftId: DraftId;
    threadRef: ScopedThreadRef | null;
  }>(() => ({
    draftId,
    threadRef: draftSession
      ? { environmentId: draftSession.environmentId, threadId: draftSession.threadId }
      : null,
  }));
  if (
    capturedThread.draftId !== draftId ||
    (draftSession &&
      (capturedThread.threadRef?.environmentId !== draftSession.environmentId ||
        capturedThread.threadRef?.threadId !== draftSession.threadId))
  ) {
    setCapturedThread({
      draftId,
      threadRef: draftSession
        ? { environmentId: draftSession.environmentId, threadId: draftSession.threadId }
        : null,
    });
  }
  // Promotion retires the local session before the async route commit. Retain
  // only its exact identity so that boundary cannot redirect a saved chat to /.
  const remembered = capturedThread.draftId === draftId ? capturedThread.threadRef : null;
  const draftEnvironmentId = draftSession?.environmentId ?? remembered?.environmentId ?? null;
  const draftThreadId = draftSession?.threadId ?? remembered?.threadId ?? null;
  const promotedTo = draftSession?.promotedTo ?? null;
  const serverThread = useStore(
    useMemo(
      () =>
        createThreadSelectorByRef(
          draftEnvironmentId && draftThreadId
            ? {
                environmentId: draftEnvironmentId,
                threadId: draftThreadId,
              }
            : null,
        ),
      [draftEnvironmentId, draftThreadId],
    ),
  );
  const serverThreadStarted = threadHasStarted(serverThread);
  const canonicalThreadRef = useMemo(
    () =>
      promotedTo
        ? serverThreadStarted
          ? promotedTo
          : null
        : serverThread
          ? {
              environmentId: serverThread.environmentId,
              threadId: serverThread.id,
            }
          : null,
    [promotedTo, serverThread, serverThreadStarted],
  );

  useEffect(() => {
    if (!canonicalThreadRef || ownsPendingEditor) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(canonicalThreadRef),
      replace: true,
    });
  }, [canonicalThreadRef, ownsPendingEditor, navigate]);

  useEffect(() => {
    if (draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate]);

  return null;
}

export const Route = createFileRoute("/_chat/draft/$draftId")({
  component: DraftChatThreadRouteView,
});
