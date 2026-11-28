import { autoAnimate } from "@formkit/auto-animate";

export function attachSidebarListAnimation(list: HTMLUListElement | null) {
  if (!list) return;

  const controller = autoAnimate(list, { duration: 180, easing: "ease-out" });
  // Release the library's observers and parent registry entry when React detaches the list.
  return () => controller.destroy?.();
}
