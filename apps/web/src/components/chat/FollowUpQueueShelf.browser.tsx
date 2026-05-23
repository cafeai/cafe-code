import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { FollowUpQueueShelf } from "./ChatComposer";

describe("FollowUpQueueShelf", () => {
  it("renders queue controls and expands bounded prompt details", async () => {
    const onToggleExpanded = vi.fn();
    const onAction = vi.fn();
    const onRemove = vi.fn();
    const onClear = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);

    const screen = await render(
      <FollowUpQueueShelf
        items={[
          {
            id: "queued-1",
            preview: "Short preview",
            promptText: "Full queued prompt\nwith details",
            images: [],
            queuedAt: "2026-05-22T00:00:00.000Z",
            expanded: true,
            canExpand: true,
            blockedReason: null,
          },
        ]}
        actionLabel="Steer"
        actionTitle="Steer this into the active turn now"
        onToggleExpanded={onToggleExpanded}
        onAction={onAction}
        onRemove={onRemove}
        onClear={onClear}
        onExpandImage={vi.fn()}
      />,
      { container: host },
    );

    try {
      expect(document.body.textContent ?? "").toContain("1 message queued");
      expect(document.body.textContent ?? "").toContain("Steer");
      expect(document.body.textContent ?? "").toContain("Full queued prompt");
      await expect.element(page.getByLabelText("Queued message prompt")).toBeInTheDocument();

      await page.getByText("Steer").click();
      expect(onAction).toHaveBeenCalledWith("queued-1");

      await page.getByLabelText("Remove queued message").click();
      expect(onRemove).toHaveBeenCalledWith("queued-1");

      await page.getByText("Clear").click();
      expect(onClear).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("does not expose expansion for prompts that fit in the collapsed row", async () => {
    const onToggleExpanded = vi.fn();
    const onAction = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);

    const screen = await render(
      <FollowUpQueueShelf
        items={[
          {
            id: "queued-short",
            preview: "say yes",
            promptText: "say yes",
            images: [],
            queuedAt: "2026-05-22T00:00:00.000Z",
            expanded: true,
            canExpand: false,
            blockedReason: null,
          },
        ]}
        actionLabel="Interrupt"
        actionTitle="Interrupt the active turn and send this queued follow-up next"
        onToggleExpanded={onToggleExpanded}
        onAction={onAction}
        onRemove={vi.fn()}
        onClear={vi.fn()}
        onExpandImage={vi.fn()}
      />,
      { container: host },
    );

    try {
      await expect.element(page.getByText("say yes", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByLabelText("Expand queued message")).not.toBeInTheDocument();

      await page.getByText("say yes", { exact: true }).click();
      expect(onToggleExpanded).not.toHaveBeenCalled();
      expect((document.body.textContent ?? "").match(/say yes/g)).toHaveLength(1);

      await page.getByText("Interrupt").click();
      expect(onAction).toHaveBeenCalledWith("queued-short");

      const steerButton = document.querySelector(".cafe-followup-steer-button");
      expect(steerButton).not.toBeNull();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("exposes expansion and image previews for queued attachments", async () => {
    const onToggleExpanded = vi.fn();
    const onExpandImage = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);

    const screen = await render(
      <FollowUpQueueShelf
        items={[
          {
            id: "queued-image",
            preview: "short",
            promptText: "short",
            images: [
              {
                type: "image",
                id: "img-1",
                name: "cat.png",
                mimeType: "image/png",
                sizeBytes: 64,
                previewUrl:
                  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
                file: new File(["image"], "cat.png", { type: "image/png" }),
              },
            ],
            queuedAt: "2026-05-22T00:00:00.000Z",
            expanded: true,
            canExpand: true,
            blockedReason: null,
          },
        ]}
        actionLabel="Interrupt"
        actionTitle="Interrupt the active turn and send this queued follow-up next"
        onToggleExpanded={onToggleExpanded}
        onAction={vi.fn()}
        onRemove={vi.fn()}
        onClear={vi.fn()}
        onExpandImage={onExpandImage}
      />,
      { container: host },
    );

    try {
      await expect.element(page.getByLabelText("Collapse queued message")).toBeInTheDocument();
      await page.getByLabelText("Preview queued image cat.png").click();
      expect(onExpandImage).toHaveBeenCalledWith({
        images: [{ src: expect.stringContaining("data:image/png;base64,"), name: "cat.png" }],
        index: 0,
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
