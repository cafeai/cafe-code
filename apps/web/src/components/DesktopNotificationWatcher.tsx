import { useEffect, useRef } from "react";
import { getUiLocale, uiText } from "@cafecode/shared/i18n";
import { useParams, useRouter } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@cafecode/client-runtime";

import { useWorkspaceSidebarThreads } from "../environments/workspaceData";
import { useWorkspaceEnvironmentId } from "../environments/workspace";
import { isElectron } from "../env";
import { useSettings } from "../hooks/useSettings";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { readEnvironmentApi } from "../environmentApi";
import { shouldNotifyScheduledTurn } from "../lib/scheduledNotification";
import { desktopThreadNotificationTag, sendDesktopNotification } from "../lib/desktopNotifications";
import {
  getThreadNotificationKind,
  isThreadNotificationPending,
  type ThreadNotificationKind,
  type ThreadNotificationState,
} from "../lib/threadNotification";

/**
 * Desktop-app counterpart of Web Push: the Electron renderer keeps its
 * WebSocket alive while backgrounded, so it can fire native OS notifications
 * through its trusted main-process bridge. Native authorization is owned by
 * Electron/the OS; the renderer's microphone-only permission policy stays
 * unchanged. Fires when a
 * thread's turn settles or asks for input, unless the user is focused on that
 * very thread. Each category has its own per-device opt-in.
 */
export function DesktopNotificationWatcher() {
  const settings = useSettings();
  const environmentId = useWorkspaceEnvironmentId();
  const threads = useWorkspaceSidebarThreads();
  const router = useRouter();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const activeThreadKey =
    routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;
  const activeThreadKeyRef = useRef(activeThreadKey);
  activeThreadKeyRef.current = activeThreadKey;
  const preferencesRef = useRef(settings);
  preferencesRef.current = settings;
  const statesByKeyRef = useRef<Map<string, ThreadNotificationState> | null>(null);
  const pendingByKeyRef = useRef(
    new Map<
      string,
      {
        readonly kind: ThreadNotificationKind;
        readonly turnId: ThreadNotificationState["turnId"];
      }
    >(),
  );
  const mountedRef = useRef(true);

  useEffect(() => {
    if (!isElectron) return;
    return window.desktopBridge?.onNotificationClick?.((tag) => {
      const thread = threads.find(
        (candidate) =>
          tag ===
          desktopThreadNotificationTag(scopeThreadRef(candidate.environmentId, candidate.id)),
      );
      if (!thread) return;
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    });
  }, [router, threads]);

  useEffect(() => {
    mountedRef.current = true;
    statesByKeyRef.current = null;
    const pending = pendingByKeyRef.current;
    return () => {
      mountedRef.current = false;
      pending.clear();
    };
  }, [environmentId]);

  useEffect(() => {
    if (!isElectron) return;
    const previous = statesByKeyRef.current;
    const next = new Map<string, ThreadNotificationState>();
    for (const thread of threads) {
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const running = thread.session?.status === "running" && thread.session.activeTurnId != null;
      const current = {
        running,
        turnId: thread.session?.activeTurnId ?? null,
        userInputPending: thread.hasPendingUserInput,
      };
      next.set(key, current);
      // Retire resolved prompts and superseded completion decisions before
      // an awaited schedule-policy read can deliver an obsolete notification.
      const pending = pendingByKeyRef.current.get(key);
      if (
        pending &&
        (!isThreadNotificationPending(pending.kind, current) ||
          (pending.kind === "user-input" && pending.turnId !== current.turnId))
      ) {
        pendingByKeyRef.current.delete(key);
      }
    }
    for (const key of pendingByKeyRef.current.keys()) {
      if (!next.has(key)) pendingByKeyRef.current.delete(key);
    }
    statesByKeyRef.current = next;
    // First sync after load: seed the baseline without notifying.
    if (previous === null) return;
    if (
      !preferencesRef.current.notificationsEnabled &&
      !preferencesRef.current.userInputNotificationsEnabled
    )
      return;

    for (const thread of threads) {
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const previousTurn = previous.get(key);
      const current = next.get(key)!;
      const kind = getThreadNotificationKind(previousTurn, current, preferencesRef.current);
      if (!kind) continue;
      // Watching the thread with the window focused — nothing to announce.
      if (key === activeThreadKeyRef.current && document.hasFocus()) continue;

      const turnId = kind === "user-input" ? current.turnId : previousTurn!.turnId;
      const candidate = { kind, turnId };
      pendingByKeyRef.current.set(key, candidate);
      // Capture the exact notification turn before this asynchronous read.
      // The current shell may already refer to another turn when it resolves.
      void shouldNotifyScheduledTurn(
        readEnvironmentApi(thread.environmentId),
        thread.id,
        turnId,
      ).then((notify) => {
        if (!mountedRef.current || pendingByKeyRef.current.get(key) !== candidate) return;
        pendingByKeyRef.current.delete(key);
        const enabled =
          kind === "user-input"
            ? preferencesRef.current.userInputNotificationsEnabled
            : preferencesRef.current.notificationsEnabled;
        if (!notify || !enabled) return;
        if (key === activeThreadKeyRef.current && document.hasFocus()) return;
        void sendDesktopNotification({
          title: thread.title.slice(0, 256),
          // Language is presentation at delivery, not part of the exact-turn
          // notification candidate. A delayed read must not freeze old copy
          // or restart the admission watcher when the preference changes.
          body:
            kind === "user-input"
              ? uiText("Waiting for your input", undefined, undefined, getUiLocale())
              : uiText("Finished running", undefined, undefined, getUiLocale()),
          tag: desktopThreadNotificationTag(scopeThreadRef(thread.environmentId, thread.id)),
        });
      });
    }
  }, [router, threads]);

  return null;
}
