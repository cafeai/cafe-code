import { useEffect, useState } from "react";

export function useDesktopDebugEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.getDebugEndpointState) {
      setEnabled(false);
      return;
    }

    let cancelled = false;
    void bridge
      .getDebugEndpointState()
      .then((debugState) => {
        if (!cancelled) {
          setEnabled(debugState.enabled);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEnabled(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return enabled;
}
