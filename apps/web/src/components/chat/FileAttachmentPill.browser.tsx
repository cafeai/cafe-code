import "../../index.css";
import { EnvironmentId, type ChatFileAttachment } from "@cafecode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { FileAttachmentPill } from "./FileAttachmentPill";
import {
  downloadFileAttachment,
  getFileAttachmentPreview,
} from "../../attachments/fileAttachments";

vi.mock("../../attachments/fileAttachments", () => ({
  downloadFileAttachment: vi.fn(),
  getFileAttachmentPreview: vi.fn(),
}));
const environmentId = EnvironmentId.make("file-pill-environment");
const attachment: ChatFileAttachment = {
  type: "file",
  id: "file-copy",
  name: "source.html",
  mimeType: "text/html",
  sizeBytes: 42,
};

describe("inert file attachment pills", () => {
  beforeEach(() => {
    vi.mocked(downloadFileAttachment).mockResolvedValue();
  });
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("shows HTML source as escaped text, with a separately explicit download", async () => {
    vi.mocked(getFileAttachmentPreview).mockResolvedValue({
      text: '<img src="x" onerror="alert(1)"><script>unsafe()</script>',
      truncated: true,
    });
    const screen = await render(
      <FileAttachmentPill environmentId={environmentId} attachment={attachment} />,
    );
    try {
      await page.getByRole("button", { name: "source.html", exact: true }).click();
      await expect.element(page.getByText("Plain-text preview (truncated)")).toBeInTheDocument();
      expect(document.querySelector("[data-file-attachment] pre")?.textContent).toContain(
        "<script>unsafe()</script>",
      );
      expect(
        document.querySelector(
          "[data-file-attachment] img, [data-file-attachment] iframe, [data-file-attachment] script",
        ),
      ).toBeNull();
      await page.getByLabelText("Download source.html").click();
      expect(downloadFileAttachment).toHaveBeenCalledWith({ environmentId, attachment });
      await page.getByLabelText("Close file preview").click();
      expect(document.querySelector("[data-file-attachment] pre")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps non-previewable binaries available for download without promising interpretation", async () => {
    vi.mocked(getFileAttachmentPreview).mockResolvedValue(null);
    const screen = await render(
      <FileAttachmentPill environmentId={environmentId} attachment={attachment} />,
    );
    try {
      await page.getByRole("button", { name: "source.html", exact: true }).click();
      await expect
        .element(
          page.getByText("No text preview for this format. Download the file to inspect it."),
        )
        .toBeInTheDocument();
      await expect.element(page.getByLabelText("Download source.html")).toBeEnabled();
    } finally {
      await screen.unmount();
    }
  });
});
