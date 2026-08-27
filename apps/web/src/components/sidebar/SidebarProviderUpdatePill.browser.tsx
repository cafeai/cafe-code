import "../../index.css";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@cafecode/contracts";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SidebarProviderUpdatePillContent } from "./SidebarProviderUpdatePill";

const INITIAL_CHECKED_AT = "2026-08-27T10:00:00.000Z";
const LATER_CHECKED_AT = "2026-08-27T10:01:00.000Z";

function claudeProvider(input: {
  readonly checkedAt?: string;
  readonly updateState: ServerProviderUpdateState;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: input.checkedAt ?? INITIAL_CHECKED_AT,
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "claude update",
      canUpdate: true,
      checkedAt: input.checkedAt ?? INITIAL_CHECKED_AT,
      message: null,
    },
    updateState: input.updateState,
  };
}

const runningClaude = claudeProvider({
  updateState: {
    status: "running",
    startedAt: INITIAL_CHECKED_AT,
    finishedAt: null,
    message: "Updating provider.",
    output: null,
  },
});

const failedClaude = claudeProvider({
  checkedAt: LATER_CHECKED_AT,
  updateState: {
    status: "failed",
    startedAt: INITIAL_CHECKED_AT,
    finishedAt: LATER_CHECKED_AT,
    message: "Update command was interrupted during reconnect.",
    output: null,
  },
});

const unchangedClaude = claudeProvider({
  checkedAt: "2026-08-27T10:02:00.000Z",
  updateState: {
    status: "unchanged",
    startedAt: INITIAL_CHECKED_AT,
    finishedAt: "2026-08-27T10:02:00.000Z",
    message: "Claude is still behind the latest version.",
    output: null,
  },
});

function pill(host: HTMLElement): HTMLDivElement {
  const element = host.querySelector<HTMLDivElement>('[data-cafe-provider-update-pill="true"]');
  if (!element) {
    throw new Error("Expected the provider update pill to be rendered.");
  }
  return element;
}

describe("SidebarProviderUpdatePill", () => {
  it("settles a terminal provider snapshot when CSS emits no transition event", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <SidebarProviderUpdatePillContent
        providers={[runningClaude]}
        onOpenProviderSettings={vi.fn()}
      />,
      { container: host },
    );

    try {
      expect(host.textContent).toContain("Updating Claude");

      // A hidden/suspended Electron renderer can skip transition events. Inline
      // `transition: none` deterministically exercises that browser behavior so
      // this assertion depends on the bounded React-state fallback.
      pill(host).style.transition = "none";
      await screen.rerender(
        <SidebarProviderUpdatePillContent
          providers={[failedClaude]}
          onOpenProviderSettings={vi.fn()}
        />,
      );

      await vi.waitFor(() => {
        expect(host.textContent).toContain("Claude v1.1.0 update failed");
        expect(host.textContent).not.toContain("Updating Claude");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("handles transition cancellation idempotently and lands on the newest pending view", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <SidebarProviderUpdatePillContent
        providers={[runningClaude]}
        onOpenProviderSettings={vi.fn()}
      />,
      { container: host },
    );

    try {
      const exitingPill = pill(host);
      await screen.rerender(
        <SidebarProviderUpdatePillContent
          providers={[failedClaude]}
          onOpenProviderSettings={vi.fn()}
        />,
      );
      await vi.waitFor(() => expect(exitingPill.classList.contains("opacity-0")).toBe(true));

      // The provider can advance again before the old view finishes leaving.
      // The transition must settle to this newest snapshot, not the first
      // terminal snapshot captured when the exit began.
      await screen.rerender(
        <SidebarProviderUpdatePillContent
          providers={[unchangedClaude]}
          onOpenProviderSettings={vi.fn()}
        />,
      );
      exitingPill.dispatchEvent(new Event("transitioncancel", { bubbles: true }));
      // A second browser event (for another transitioned CSS property) must be
      // harmless after the keyed completion has already committed.
      exitingPill.dispatchEvent(new Event("transitioncancel", { bubbles: true }));

      await vi.waitFor(() => {
        expect(host.textContent).toContain("Claude still needs an update");
        expect(host.textContent).not.toContain("update failed");
        expect(host.textContent).not.toContain("Updating Claude");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
