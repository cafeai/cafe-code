import "../../index.css";
import { StrictMode, useEffect, useLayoutEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  EditorId,
  EnvironmentId,
  ThreadId,
  type ResolvedKeybindingsConfig,
} from "@cafecode/contracts";
import { scopedThreadKey, scopeThreadRef } from "@cafecode/client-runtime";
import {
  ChatPaneContext,
  ChatPaneRuntimeProvider,
  useChatPaneQueueOwnership,
  useChatPaneResource,
  useChatPaneSharedState,
} from "../../chatPaneContext";
import { OpenInPicker } from "./OpenInPicker";
import { useScrollToBottomDismissal } from "./useScrollToBottomDismissal";

const openEditor = vi.fn().mockResolvedValue(undefined);
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ persistence: {} }),
  readLocalApi: () => ({ shell: { openInEditor: openEditor } }),
}));

const keybindings: ResolvedKeybindingsConfig = [
  {
    command: "editor.openFavorite",
    shortcut: {
      key: "o",
      modKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
    },
  },
];

function EditorPane({
  active,
  visible,
  path,
}: {
  active: boolean;
  visible: boolean;
  path: string;
}) {
  return (
    <ChatPaneContext value={{ active, visible }}>
      <OpenInPicker
        keybindings={keybindings}
        availableEditors={[EditorId.make("vscode")]}
        terminal={{ available: false, label: "Terminal", unavailableReason: "Test fixture" }}
        openInCwd={path}
      />
    </ChatPaneContext>
  );
}

describe("Desk pane ownership in a mounted React tree", () => {
  it("routes the global editor shortcut only to the active visible pane", async () => {
    openEditor.mockClear();
    const screen = await render(
      <>
        <EditorPane active={false} visible path="/synthetic/left" />
        <EditorPane active visible path="/synthetic/right" />
        <EditorPane active visible={false} path="/synthetic/hidden" />
      </>,
    );
    try {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "o", ctrlKey: true, bubbles: true, cancelable: true }),
      );
      expect(openEditor).toHaveBeenCalledExactlyOnceWith("/synthetic/right", "vscode");
    } finally {
      await screen.unmount();
    }
  });

  it("retains shared queues across tab removal and dispatches each row once after handoff", async () => {
    const dispatched = vi.fn();
    function Pane({ thread }: { thread: string }) {
      const { owns, revision } = useChatPaneQueueOwnership("local", thread);
      const [queue, setQueue] = useChatPaneSharedState("test:queue", () => ["closed-chat"]);
      const stopped = useChatPaneResource("test:stops", () => ({ current: true }));
      const [tick, setTick] = useState(0);
      useEffect(() => {
        if (stopped.current) return;
        const next = queue.find((target) => owns("local", target));
        if (!next) return;
        // A synchronous shared claim mirrors the real queue admission boundary.
        setQueue((latest) => latest.filter((target) => target !== next));
        dispatched(next);
      }, [owns, queue, revision, setQueue, stopped, tick]);
      return (
        <button
          onClick={() => {
            stopped.current = false;
            setTick((value) => value + 1);
          }}
        >
          Resume {thread}
        </button>
      );
    }
    function Harness() {
      const [left, setLeft] = useState(true);
      return (
        <ChatPaneRuntimeProvider>
          <button onClick={() => setLeft(false)}>Close left view</button>
          {left ? (
            <ChatPaneContext value={{ active: true, visible: true }}>
              <Pane thread="left" />
            </ChatPaneContext>
          ) : null}
          <ChatPaneContext value={{ active: !left, visible: true }}>
            <Pane thread="right" />
          </ChatPaneContext>
        </ChatPaneRuntimeProvider>
      );
    }
    const screen = await render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    try {
      expect(dispatched).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Close left view" }).click();
      expect(dispatched).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Resume right" }).click();
      await vi.waitFor(() => expect(dispatched).toHaveBeenCalledExactlyOnceWith("closed-chat"));
    } finally {
      await screen.unmount();
    }
  });
});

type ScrollDismissal = ReturnType<typeof useScrollToBottomDismissal>;

/** These controls exercise the shared hook's exact mounted-owner boundary.
 * A fixture button representing a retained bottom callback is deliberately not
 * proof of physical scrolling; the real-list suite qualifies that producer.
 * Capturing after commit lets the test replay an actual retired hook callback
 * rather than reconstructing another callback with the same owner string. */
function ScrollDismissalPane({
  label,
  owner,
  capture,
}: {
  label: string;
  owner: string;
  capture?: (value: ScrollDismissal) => void;
}) {
  const { dismissed, hideUntilBottom, observeBottom } = useScrollToBottomDismissal(owner);
  useLayoutEffect(() => {
    capture?.({ dismissed, hideUntilBottom, observeBottom });
  }, [capture, dismissed, hideUntilBottom, observeBottom]);
  return (
    <section>
      <output aria-label={`Scroll control ${label}`}>{dismissed ? "Hidden" : "Available"}</output>
      <button onClick={hideUntilBottom}>Hide {label}</button>
      <button onClick={observeBottom}>Observe current bottom {label}</button>
    </section>
  );
}

const firstScrollOwner = scopedThreadKey(
  scopeThreadRef(EnvironmentId.make("scroll-first-environment"), ThreadId.make("same-chat")),
);
const secondScrollOwner = scopedThreadKey(
  scopeThreadRef(EnvironmentId.make("scroll-second-environment"), ThreadId.make("same-chat")),
);
const neighboringScrollOwner = scopedThreadKey(
  scopeThreadRef(EnvironmentId.make("scroll-first-environment"), ThreadId.make("neighboring-chat")),
);

describe("scroll-control dismissal ownership in a mounted layout", () => {
  it("keeps environment choices distinct and rejects an old callback across an owner round trip", async () => {
    let retiredFirstBottom: (() => void) | undefined;
    const captureFirst = (value: ScrollDismissal) => {
      retiredFirstBottom ??= value.observeBottom;
    };
    function Harness() {
      const [owner, setOwner] = useState(firstScrollOwner);
      return (
        <ChatPaneRuntimeProvider>
          <button onClick={() => setOwner(firstScrollOwner)}>Select first environment</button>
          <button onClick={() => setOwner(secondScrollOwner)}>Select second environment</button>
          <button onClick={() => retiredFirstBottom?.()}>Observe retired first bottom</button>
          <ScrollDismissalPane
            label="current"
            owner={owner}
            {...(owner === firstScrollOwner ? { capture: captureFirst } : {})}
          />
        </ChatPaneRuntimeProvider>
      );
    }
    const screen = await render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    const state = page.getByRole("status", { name: "Scroll control current", exact: true });
    try {
      await expect.element(state).toHaveTextContent("Available");
      expect(retiredFirstBottom).toBeTypeOf("function");
      await page.getByRole("button", { name: "Hide current", exact: true }).click();
      await expect.element(state).toHaveTextContent("Hidden");
      await page.getByRole("button", { name: "Select second environment", exact: true }).click();
      await expect.element(state).toHaveTextContent("Available");
      await page.getByRole("button", { name: "Hide current", exact: true }).click();
      await expect.element(state).toHaveTextContent("Hidden");
      await page.getByRole("button", { name: "Observe retired first bottom", exact: true }).click();
      await expect.element(state).toHaveTextContent("Hidden");
      await page.getByRole("button", { name: "Select first environment", exact: true }).click();
      await expect.element(state).toHaveTextContent("Hidden");
      // Equality of the owner string after A -> B -> A must not re-admit the
      // first list's delayed observation. Only this new owner's callback wins.
      await page.getByRole("button", { name: "Observe retired first bottom", exact: true }).click();
      await expect.element(state).toHaveTextContent("Hidden");
      await page
        .getByRole("button", { name: "Observe current bottom current", exact: true })
        .click();
      await expect.element(state).toHaveTextContent("Available");
      await page.getByRole("button", { name: "Select second environment", exact: true }).click();
      await expect.element(state).toHaveTextContent("Hidden");
    } finally {
      await screen.unmount();
    }
  });

  it("retains a hidden tab across remount and ignores the removed view's bottom callback", async () => {
    let retiredFirstBottom: (() => void) | undefined;
    const captureFirst = (value: ScrollDismissal) => {
      retiredFirstBottom ??= value.observeBottom;
    };
    function Harness() {
      const [mounted, setMounted] = useState(true);
      return (
        <ChatPaneRuntimeProvider>
          <button onClick={() => setMounted(false)}>Close first scroll view</button>
          <button onClick={() => setMounted(true)}>Reopen first scroll view</button>
          <button onClick={() => retiredFirstBottom?.()}>Observe removed view bottom</button>
          {mounted ? (
            <ScrollDismissalPane label="first" owner={firstScrollOwner} capture={captureFirst} />
          ) : null}
          <ScrollDismissalPane label="other" owner={secondScrollOwner} />
        </ChatPaneRuntimeProvider>
      );
    }
    const screen = await render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    const first = page.getByRole("status", { name: "Scroll control first", exact: true });
    const other = page.getByRole("status", { name: "Scroll control other", exact: true });
    try {
      await expect.element(first).toHaveTextContent("Available");
      await expect.element(other).toHaveTextContent("Available");
      expect(retiredFirstBottom).toBeTypeOf("function");
      await page.getByRole("button", { name: "Hide first", exact: true }).click();
      await page.getByRole("button", { name: "Hide other", exact: true }).click();
      await expect.element(first).toHaveTextContent("Hidden");
      await expect.element(other).toHaveTextContent("Hidden");
      await page.getByRole("button", { name: "Close first scroll view", exact: true }).click();
      await expect.element(first).not.toBeInTheDocument();
      await page.getByRole("button", { name: "Observe removed view bottom", exact: true }).click();
      await expect.element(other).toHaveTextContent("Hidden");
      await page.getByRole("button", { name: "Reopen first scroll view", exact: true }).click();
      await expect.element(first).toHaveTextContent("Hidden");
      await page.getByRole("button", { name: "Observe removed view bottom", exact: true }).click();
      await expect.element(first).toHaveTextContent("Hidden");
      await expect.element(other).toHaveTextContent("Hidden");
      await page.getByRole("button", { name: "Observe current bottom first", exact: true }).click();
      await expect.element(first).toHaveTextContent("Available");
      await expect.element(other).toHaveTextContent("Hidden");
    } finally {
      await screen.unmount();
    }
  });

  it("shares a choice only between mounted views of the exact same chat", async () => {
    const screen = await render(
      <StrictMode>
        <ChatPaneRuntimeProvider>
          <ScrollDismissalPane label="left" owner={firstScrollOwner} />
          <ScrollDismissalPane label="right" owner={firstScrollOwner} />
          <ScrollDismissalPane label="neighbor" owner={neighboringScrollOwner} />
          <ScrollDismissalPane label="other environment" owner={secondScrollOwner} />
        </ChatPaneRuntimeProvider>
      </StrictMode>,
    );
    const left = page.getByRole("status", { name: "Scroll control left", exact: true });
    const right = page.getByRole("status", { name: "Scroll control right", exact: true });
    const neighbor = page.getByRole("status", { name: "Scroll control neighbor", exact: true });
    const other = page.getByRole("status", {
      name: "Scroll control other environment",
      exact: true,
    });
    try {
      await page.getByRole("button", { name: "Hide left", exact: true }).click();
      await expect.element(left).toHaveTextContent("Hidden");
      await expect.element(right).toHaveTextContent("Hidden");
      await expect.element(neighbor).toHaveTextContent("Available");
      await expect.element(other).toHaveTextContent("Available");
      await page.getByRole("button", { name: "Hide neighbor", exact: true }).click();
      await page.getByRole("button", { name: "Hide other environment", exact: true }).click();
      await page.getByRole("button", { name: "Observe current bottom right", exact: true }).click();
      await expect.element(left).toHaveTextContent("Available");
      await expect.element(right).toHaveTextContent("Available");
      await expect.element(neighbor).toHaveTextContent("Hidden");
      await expect.element(other).toHaveTextContent("Hidden");
    } finally {
      await screen.unmount();
    }
  });
});
