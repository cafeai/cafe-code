import { EnvironmentId, ThreadId, type ChatFileAttachment } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import {
  composerFileFromAttachment,
  hydrateComposerFile,
  isComposerImageFile,
  persistComposerFile,
  readyComposerFiles,
} from "./composerFiles";

const environmentId = EnvironmentId.make("files-local");
const threadId = ThreadId.make("files-thread");
const attachment: ChatFileAttachment = {
  type: "file",
  id: "file-copy",
  name: "source.tex",
  mimeType: "application/x-tex",
  sizeBytes: 4,
};

describe("composer file copies", () => {
  it.each([
    "text/html",
    "image/svg+xml",
    "application/pdf",
    "application/octet-stream",
    "",
    "text/x-tex",
  ])("keeps %s outside the image rendering path", (type) => {
    expect(isComposerImageFile({ type })).toBe(false);
  });
  it.each(["image/png", "image/jpeg", "image/gif", "image/webp"])(
    "retains passive %s thumbnails",
    (type) => {
      expect(isComposerImageFile({ type })).toBe(true);
    },
  );
  it("persists handles and metadata, never browser File bytes or transient exceptions", () => {
    const ready = composerFileFromAttachment(environmentId, threadId, attachment);
    const persisted = persistComposerFile({
      ...ready,
      file: new File(["private bytes"], "source.tex"),
      error: "private exception",
    });
    expect(JSON.stringify(persisted)).not.toContain("private");
    expect(persisted).not.toHaveProperty("file");
    expect(hydrateComposerFile(persisted)).toEqual(ready);
  });
  it.each(["uploading", "failed"] as const)(
    "retains a visible non-sendable placeholder after %s reload",
    (status) => {
      const file = hydrateComposerFile(
        persistComposerFile({
          ...composerFileFromAttachment(environmentId, threadId, attachment),
          status,
        }),
      );
      expect(file?.status).toBe("failed");
      expect(file?.error).toContain("select it again");
      expect(() => readyComposerFiles([file!], environmentId, threadId)).toThrow();
    },
  );
  it("requires the exact upload environment and future thread identity", () => {
    const ready = composerFileFromAttachment(environmentId, threadId, attachment);
    expect(readyComposerFiles([ready], environmentId, threadId)).toEqual([attachment]);
    expect(() => readyComposerFiles([ready], EnvironmentId.make("other"), threadId)).toThrow();
    expect(() => readyComposerFiles([ready], environmentId, ThreadId.make("other"))).toThrow();
  });
});
