import "../../index.css";
import { StrictMode, useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { EditorId, type ResolvedKeybindingsConfig } from "@cafecode/contracts";
import {
  ChatPaneContext,
  ChatPaneRuntimeProvider,
  useChatPaneQueueOwnership,
  useChatPaneResource,
  useChatPaneSharedState,
} from "../../chatPaneContext";
import { OpenInPicker } from "./OpenInPicker";

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
