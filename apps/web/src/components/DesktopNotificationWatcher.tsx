import { useEffect, useRef } from "react";
import { useParams, useRouter } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { scopedThreadKey, scopeThreadRef } from "@cafecode/client-runtime";

import { selectSidebarThreadsAcrossEnvironments, useStore } from "../store";
import { isElectron } from "../env";
import { useSettings } from "../hooks/useSettings";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";

/**
 * Desktop-app counterpart of Web Push: the Electron renderer keeps its
 * WebSocket alive while backgrounded, so it can fire native OS notifications
 * directly (the HTML5 Notification API maps to Windows/macOS/Linux native
 * notifications in Electron, no permission prompt needed). Fires when a
 * thread's turn settles, unless the user is focused on that very thread.
 */
export function DesktopNotificationWatcher() {
  const settings = useSettings();
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const router = useRouter();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const activeThreadKey =
    routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;
  const activeThreadKeyRef = useRef(activeThreadKey);
  activeThreadKeyRef.current = activeThreadKey;
  const notificationsEnabledRef = useRef(settings.notificationsEnabled);
  notificationsEnabledRef.current = settings.notificationsEnabled;
  const runningByKeyRef = useRef<Map<string, boolean> | null>(null);

  useEffect(() => {
    if (!isElectron) return;
    const previous = runningByKeyRef.current;
    const next = new Map<string, boolean>();
    for (const thread of threads) {
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      next.set(key, thread.session?.status === "running" && thread.session.activeTurnId != null);
    }
    runningByKeyRef.current = next;
    // First sync after load: seed the baseline without notifying.
    if (previous === null) return;
    if (!notificationsEnabledRef.current) return;
    if (typeof Notification === "undefined") return;

    for (const thread of threads) {
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      if (previous.get(key) !== true || next.get(key) !== false) continue;
      // Watching the thread with the window focused — nothing to announce.
      if (key === activeThreadKeyRef.current && document.hasFocus()) continue;

      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      const notification = new Notification(thread.title, {
        body: "Finished running",
        tag: `cafe-code-thread-${thread.id}`,
      });
      notification.onclick = () => {
        window.focus();
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
      };
    }
  }, [router, threads]);

  return null;
}
