import "../../index.css";
import { EnvironmentId, ThreadId } from "@cafecode/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { DesktopObservation } from "./DesktopObservation";
import type { WorkLogEntry } from "../../session-logic";
import { FileAttachmentRequestError } from "../../attachments/fileAttachmentErrors";

const request = vi.hoisted(() => vi.fn());
vi.mock("../../attachments/fileAttachments", async (original) => ({
  ...(await original<typeof import("../../attachments/fileAttachments")>()),
  fileRequest: request,
}));
const reference = {
  id: "24ff9ac9-1d98-4bb9-9d3f-1e868663a064",
  capturedAt: "2026-09-09T00:00:00.000Z",
  width: 1,
  height: 1,
  frame: 14,
  humanControl: false,
  storage: "saved" as const,
};
const entry: WorkLogEntry = {
  id: "observe-14",
  createdAt: reference.capturedAt,
  label: "MCP tool call",
  tone: "tool",
  desktopObservation: { reference, pending: false },
};
const environmentId = EnvironmentId.make("selected-remote");
const threadId = ThreadId.make("selected-thread");
let mounted: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  request.mockReset();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});
const mount = async (value = entry) => {
  mounted = await render(
    <DesktopObservation
      entry={value}
      environmentId={environmentId}
      threadId={threadId}
      timestampFormat="24-hour"
    />,
  );
};

it("loads the exact observation only on click and releases its bytes on close", async () => {
  const bytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
    ),
    (c) => c.charCodeAt(0),
  );
  request.mockResolvedValue(new Response(bytes, { headers: { "content-type": "image/png" } }));
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  await mount();
  expect(request).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "View desktop screenshot" }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("img", { name: "Desktop screenshot observed by the model" }))
    .toBeVisible();
  expect(request).toHaveBeenCalledWith(
    environmentId,
    `/api/desktop-observations/${reference.id}`,
    expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    { threadId },
  );
  await page.getByRole("button", { name: "View full resolution screenshot" }).click();
  await expect.element(page.getByRole("dialog", { name: "Desktop screenshot" })).toBeVisible();
  await page.getByRole("button", { name: "Actual size" }).click();
  await expect.element(page.getByRole("button", { name: "Fit to window" })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect
    .element(page.getByRole("img", { name: "Desktop screenshot observed by the model" }))
    .toBeVisible();
  await page.getByRole("button", { name: "View desktop screenshot" }).click();
  await vi.waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
});

it("shows an expired result instead of a different or newer screenshot", async () => {
  request.mockRejectedValue(new FileAttachmentRequestError("unavailable"));
  await mount();
  await page.getByRole("button", { name: "View desktop screenshot" }).click();
  await expect.element(page.getByText(/This screenshot is no longer retained/)).toBeVisible();
  await expect.element(page.getByRole("img")).not.toBeInTheDocument();
});

it.each(["disabled", "failed", "legacy"] as const)(
  "explains %s observations without requesting image bytes",
  async (storage) => {
    await mount({
      ...entry,
      desktopObservation: {
        pending: false,
        ...(storage === "legacy" ? {} : { reference: { ...reference, storage } }),
      },
    });
    await page.getByRole("button", { name: "View desktop screenshot" }).click();
    await expect.element(page.getByRole("status")).toBeVisible();
    expect(request).not.toHaveBeenCalled();
  },
);

it("cancels a pending request when the inline preview collapses", async () => {
  request.mockImplementation(
    (_environment, _path, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  );
  await mount();
  await page.getByRole("button", { name: "View desktop screenshot" }).click();
  await expect.element(page.getByText("Loading screenshot…")).toBeVisible();
  const signal = request.mock.calls[0]![2].signal as AbortSignal;
  await page.getByRole("button", { name: "View desktop screenshot" }).click();
  await vi.waitFor(() => expect(signal.aborted).toBe(true));
});
