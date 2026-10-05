import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  hasSavedEnvironmentRegistryHydrated,
  useSavedEnvironmentRegistryStore,
} from "../environments/runtime/catalog";
import { selectEnvironmentState, selectThreadExistsByRef, useStore } from "../store";
import { resolveThreadRouteRef } from "../threadRoutes";

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedEnvironmentExists = useSavedEnvironmentRegistryStore((s) =>
    threadRef ? Boolean(s.byId[threadRef.environmentId]) : false,
  );
  const bootstrapComplete = useStore(
    (store) => selectEnvironmentState(store, threadRef?.environmentId ?? null).bootstrapComplete,
  );
  const threadExists = useStore((store) => selectThreadExistsByRef(store, threadRef));
  const environmentHasServerThreads = useStore(
    (store) => selectEnvironmentState(store, threadRef?.environmentId ?? null).threadIds.length > 0,
  );
  const draftThreadExists = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const environmentHasDraftThreads = useComposerDraftStore((store) => {
    if (!threadRef) {
      return false;
    }
    return store.hasDraftThreadsInEnvironment(threadRef.environmentId);
  });
  const routeThreadExists = threadExists || draftThreadExists;
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;

  useEffect(() => {
    if (!threadRef || !bootstrapComplete) {
      return;
    }

    if (!routeThreadExists && environmentHasAnyThreads) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, routeThreadExists, threadRef]);

  useEffect(() => {
    if (
      threadRef !== null &&
      primaryEnvironmentId !== null &&
      hasSavedEnvironmentRegistryHydrated() &&
      threadRef.environmentId !== primaryEnvironmentId &&
      !savedEnvironmentExists
    ) {
      void navigate({ to: "/", replace: true });
    }
  }, [navigate, primaryEnvironmentId, savedEnvironmentExists, threadRef]);

  // The shared chat layout owns pane mounts and draft promotion. Route guards
  // remain here, but navigation must not create a second view/queue dispatcher.
  return null;
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: ChatThreadRouteView,
});
