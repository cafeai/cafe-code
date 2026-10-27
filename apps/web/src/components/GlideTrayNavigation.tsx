import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { scopeThreadRef } from "@cafecode/client-runtime";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { readEnvironmentApi } from "../environmentApi";
import { isElectron } from "../env";
import { buildThreadRouteParams } from "../threadRoutes";
import { useUiLocale } from "../i18n";

/** The daemon's status item can survive a closed desktop. Navigation is a
 * single server-minted receipt consumed only by this desktop's primary host,
 * never by whichever remote workspace happens to be selected. */
export function GlideTrayNavigation() {
  const environmentId = usePrimaryEnvironmentId();
  const router = useRouter();
  const locale = useUiLocale();
  useEffect(() => {
    if (!isElectron || !environmentId) return;
    let retired = false,
      reading = false;
    let presentationKey = "";
    const syncPresentation = () => {
      const api = readEnvironmentApi(environmentId)?.glide;
      if (!api || retired) return;
      const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
      const accent = getComputedStyle(document.documentElement)
        .getPropertyValue("--primary")
        .trim();
      const color = /^(#[a-fA-F0-9]{6}|oklch\([0-9.\s%]+\))$/.test(accent) ? accent : undefined;
      const key = JSON.stringify([theme, locale, color]);
      if (presentationKey === key) return;
      presentationKey = key;
      void api
        .control({ action: "presentation", theme, locale, ...(color ? { accent: color } : {}) })
        .catch(() => {
          if (presentationKey === key) presentationKey = "";
        });
    };
    const poll = async () => {
      const api = readEnvironmentApi(environmentId)?.glide;
      if (retired || reading || !api) return;
      reading = true;
      try {
        syncPresentation();
        const result = await api.control({ action: "activity" });
        if (retired || !result.navigation) return;
        const receipt = result.navigation;
        window.focus();
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(environmentId, receipt.threadId)),
        });
        if (!retired) await api.control({ action: "ack-navigation", id: receipt.id });
      } catch {
        /* A reconnect retains the unconsumed native receipt. */
      } finally {
        reading = false;
      }
    };
    void poll();
    const observer = new MutationObserver(syncPresentation);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    const timer = window.setInterval(() => void poll(), 1000);
    return () => {
      retired = true;
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, [environmentId, router, locale]);
  return null;
}
