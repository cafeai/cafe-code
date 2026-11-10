/** Content stays in this module until the separately loaded pairing view owns it. */
let captured:
  | { readonly href: string }
  | { readonly savedId: string }
  | { readonly choose: true }
  | undefined;
if (typeof window !== "undefined" && !window.desktopBridge) {
  if (window.location.pathname === "/relay/pair") {
    captured = { href: window.location.href };
    // A fresh /relay/pair invitation must cause a new document navigation,
    // even after an invalid/expired attempt. Keep no secret in the address bar.
    window.history.replaceState(null, "", "/relay/connect");
  } else {
    try {
      const savedId = sessionStorage.getItem("cafe-relay-active");
      if (savedId) captured = { savedId };
    } catch {
      /* No automatic resume without its local selection. */
    }
    if (!captured && window.location.pathname === "/relay/connect") captured = { choose: true };
  }
}
export const hasRelayEntry = captured !== undefined;
export function takeRelayIntent() {
  const value = captured;
  captured = undefined;
  return value;
}
