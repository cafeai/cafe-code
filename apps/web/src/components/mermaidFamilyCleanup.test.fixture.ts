import { afterEach, vi } from "vitest";
import { applyInterfaceScalePercent } from "../interfaceScale";

/** Register the original per-test cleanup in each isolated native file. No
 * mutable test state, frame, port or mock is retained across test files. */
export function installMermaidFamilyCleanup(resetOwnedMock?: () => void): void {
  afterEach(() => {
    resetOwnedMock?.();
    vi.restoreAllMocks();
    applyInterfaceScalePercent(100);
    document.documentElement.classList.remove("dark");
    for (const frame of document.querySelectorAll("iframe[data-mermaid-family-security-fixture]"))
      frame.remove();
  });
}
