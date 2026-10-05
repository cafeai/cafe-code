import { useCanGoBack, useNavigate } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
import { useWorkspaceEnvironmentId } from "../environments/workspace";

/** Switching servers in Settings must not return to the previous server's chat. */
export function useSettingsBackNavigation() {
  const environmentId = useWorkspaceEnvironmentId();
  const enteredEnvironmentId = useRef(environmentId);
  const canGoBack = useCanGoBack();
  const navigate = useNavigate();
  return useCallback(() => {
    if (canGoBack && enteredEnvironmentId.current === environmentId) {
      window.history.back();
    } else {
      void navigate({ to: "/" });
    }
  }, [canGoBack, environmentId, navigate]);
}
