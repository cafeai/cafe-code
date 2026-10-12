import "../../index.css";
import { getUiLocale, setUiLocale } from "@cafecode/shared/i18n";
import { EnvironmentId, type ChatFileAttachment } from "@cafecode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { FileAttachmentPill } from "./FileAttachmentPill";
import {
  downloadFileAttachment,
  getFileAttachmentPreview,
} from "../../attachments/fileAttachments";
import { FileAttachmentRequestError } from "../../attachments/fileAttachmentErrors";

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
const originalLocale = getUiLocale();

describe("inert file attachment pills", () => {
  beforeEach(() => {
    setUiLocale("en");
    vi.mocked(downloadFileAttachment).mockResolvedValue();
  });
  afterEach(() => {
    setUiLocale(originalLocale);
    vi.resetAllMocks();
  });

  it.each([
    {
      kind: "no-preview",
      english: "No text preview for this format. Download the file to inspect it.",
      korean: "이 형식은 텍스트 미리보기가 없습니다. 파일을 다운로드하여 확인하세요.",
    },
    {
      kind: "classified",
      english: "Several files are being processed. Please try again shortly.",
      korean: "여러 파일을 처리 중입니다. 잠시 후 다시 시도하세요.",
    },
    {
      kind: "preview-unknown",
      english: "This file could not be previewed. You can still download it.",
      korean: "이 파일을 미리 보지 못했습니다. 다운로드할 수는 있습니다.",
    },
    {
      kind: "download-unknown",
      english: "This file could not be downloaded. Please try again.",
      korean: "이 파일을 다운로드하지 못했습니다. 다시 시도하세요.",
    },
  ])(
    "repaints retained $kind feedback without repeating file IO",
    async ({ kind, english, korean }) => {
      const privateFailure = new Error(
        "private-body /private/credentials <script>unsafe()</script>",
      );
      if (kind === "no-preview") vi.mocked(getFileAttachmentPreview).mockResolvedValue(null);
      else if (kind === "classified") {
        const error = new FileAttachmentRequestError("busy");
        error.message = privateFailure.message;
        vi.mocked(getFileAttachmentPreview).mockRejectedValue(error);
      } else if (kind === "preview-unknown")
        vi.mocked(getFileAttachmentPreview).mockRejectedValue(privateFailure);
      else vi.mocked(downloadFileAttachment).mockRejectedValue(privateFailure);
      const screen = await render(
        <FileAttachmentPill environmentId={environmentId} attachment={attachment} />,
      );
      try {
        if (kind === "download-unknown") await page.getByLabelText("Download source.html").click();
        else await page.getByRole("button", { name: "source.html", exact: true }).click();
        await expect.element(page.getByRole("status")).toHaveTextContent(english);
        setUiLocale("ko");
        await expect.element(page.getByRole("status")).toHaveTextContent(korean);
        expect(getFileAttachmentPreview).toHaveBeenCalledTimes(kind === "download-unknown" ? 0 : 1);
        expect(downloadFileAttachment).toHaveBeenCalledTimes(kind === "download-unknown" ? 1 : 0);
        await expect
          .element(page.getByRole("button", { name: "source.html", exact: true }))
          .toBeEnabled();
        const pill = document.querySelector("[data-file-attachment]");
        expect(pill?.textContent).not.toMatch(/private-body|credentials|unsafe/);
        expect(pill?.querySelector("script, iframe, img")).toBeNull();
      } finally {
        await screen.unmount();
      }
    },
  );

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
      await page.getByLabelText("Download source.html").click();
      expect(downloadFileAttachment).toHaveBeenCalledWith({ environmentId, attachment });
      expect(document.querySelector('[data-file-attachment] [role="status"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    {
      code: "owner-access" as const,
      message: "Reconnect with owner access to use attachments.",
    },
    {
      code: "unavailable" as const,
      message: "This attachment is unavailable. Remove it and attach the file again.",
    },
    {
      code: "busy" as const,
      message: "Several files are being processed. Please try again shortly.",
    },
  ])(
    "distinguishes a $code failure and permits a successful preview retry",
    async ({ code, message }) => {
      vi.mocked(getFileAttachmentPreview)
        .mockRejectedValueOnce(new FileAttachmentRequestError(code))
        .mockResolvedValueOnce({ text: "Preview recovered", truncated: false });
      const screen = await render(
        <FileAttachmentPill environmentId={environmentId} attachment={attachment} />,
      );
      try {
        await page.getByRole("button", { name: "source.html", exact: true }).click();
        await expect.element(page.getByRole("status")).toMatchTextContent(message);
        await expect.element(page.getByLabelText("Download source.html")).toBeEnabled();

        await page.getByRole("button", { name: "source.html", exact: true }).click();
        await expect.element(page.getByText("Preview recovered")).toBeInTheDocument();
        expect(document.querySelector('[data-file-attachment] [role="status"]')).toBeNull();
        expect(getFileAttachmentPreview).toHaveBeenCalledTimes(2);
      } finally {
        await screen.unmount();
      }
    },
  );

  it("redacts arbitrary preview and download exceptions without suggesting a reconnect", async () => {
    const privateFailure = new Error(
      "Bearer private-token /private/credentials <img src=x onerror=alert(1)>",
    );
    vi.mocked(getFileAttachmentPreview).mockRejectedValue(privateFailure);
    vi.mocked(downloadFileAttachment).mockRejectedValue(privateFailure);
    const screen = await render(
      <FileAttachmentPill environmentId={environmentId} attachment={attachment} />,
    );
    try {
      await page.getByRole("button", { name: "source.html", exact: true }).click();
      await expect
        .element(page.getByRole("status"))
        .toMatchTextContent("This file could not be previewed. You can still download it.");
      await expect.element(page.getByLabelText("Download source.html")).toBeEnabled();
      await page.getByLabelText("Download source.html").click();
      await expect
        .element(page.getByRole("status"))
        .toMatchTextContent("This file could not be downloaded. Please try again.");
      const pill = document.querySelector("[data-file-attachment]");
      expect(pill?.textContent).not.toMatch(/private-token|credentials|Reconnect|onerror/);
      expect(pill?.querySelector("img, script, iframe")).toBeNull();
      await expect
        .element(page.getByRole("button", { name: "source.html", exact: true }))
        .toBeEnabled();
    } finally {
      await screen.unmount();
    }
  });
});
