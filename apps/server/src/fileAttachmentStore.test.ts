// @effect-diagnostics nodeBuiltinImport:off
import { mkdtemp, readFile, writeFile, stat, symlink, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@cafecode/contracts";
import {
  fileAttachmentStoragePaths,
  normalizeFileAttachmentName,
  previewFileAttachment,
  readStoredFileAttachment,
  readFileAttachmentById,
  storeFileAttachment,
} from "./fileAttachmentStore.ts";

const temporaryRoots: string[] = [];
async function fixture() {
  const attachmentsDir = await mkdtemp(join(tmpdir(), "cafe-file-attachments-"));
  temporaryRoots.push(attachmentsDir);
  return attachmentsDir;
}
afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("file attachment store", () => {
  it.each([
    "notes.tex",
    "page.html",
    "code.rs",
    "unknown.weird",
    "archive.zip",
    "program.exe",
    "README",
    "drawing.svg",
    "文書.docx",
  ])("stores %s as exact inert bytes with private immutable metadata", async (name) => {
    const attachmentsDir = await fixture();
    const bytes = Buffer.from("<script>never execute</script>\\section{hello}");
    const attachment = await storeFileAttachment({
      attachmentsDir,
      threadId: "future-thread",
      name,
      mimeType: "application/octet-stream",
      bytes,
    });
    expect(attachment).toEqual({
      type: "file",
      id: expect.any(String),
      name,
      mimeType: "application/octet-stream",
      sizeBytes: bytes.length,
    });
    const stored = await readStoredFileAttachment({
      attachmentsDir,
      attachment,
      threadId: "future-thread",
    });
    expect(Buffer.from(stored.bytes)).toEqual(bytes);
    expect(stored.threadId).toBe("future-thread");
    expect((await readFileAttachmentById(attachmentsDir, attachment.id)).attachment).toEqual(
      attachment,
    );
    if (process.platform !== "win32") expect((await stat(stored.path)).mode & 0o777).toBe(0o600);
    expect(attachment).not.toHaveProperty("sha256");
    expect(attachment).not.toHaveProperty("path");
  });

  it("allows empty files and rejects oversized bytes before writing", async () => {
    const attachmentsDir = await fixture();
    const empty = await storeFileAttachment({
      attachmentsDir,
      threadId: "thread",
      name: "empty",
      mimeType: "",
      bytes: new Uint8Array(),
    });
    expect(
      (await readStoredFileAttachment({ attachmentsDir, attachment: empty })).bytes,
    ).toHaveLength(0);
    const before = await readdir(attachmentsDir);
    await expect(
      storeFileAttachment({
        attachmentsDir,
        threadId: "thread",
        name: "large",
        mimeType: "",
        bytes: new Uint8Array(PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1),
      }),
    ).rejects.toMatchObject({ code: "too-large" });
    expect(await readdir(attachmentsDir)).toEqual(before);
  });

  it("rejects metadata tampering, content tampering, cross-thread references and unsafe ids", async () => {
    const attachmentsDir = await fixture();
    const attachment = await storeFileAttachment({
      attachmentsDir,
      threadId: "thread",
      name: "readme.md",
      mimeType: "text/plain",
      bytes: Buffer.from("original"),
    });
    await expect(
      readStoredFileAttachment({ attachmentsDir, attachment: { ...attachment, name: "renamed" } }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      readStoredFileAttachment({ attachmentsDir, attachment, threadId: "other-thread" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(() => fileAttachmentStoragePaths(attachmentsDir, "../secrets")).toThrow();
    const paths = fileAttachmentStoragePaths(attachmentsDir, attachment.id);
    await writeFile(paths.data, "modified");
    await expect(readStoredFileAttachment({ attachmentsDir, attachment })).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await readFile(paths.metadata, "utf8")).toContain('"sha256"');
  });

  it("rejects symlinked data and metadata without reading their target", async () => {
    const attachmentsDir = await fixture();
    const attachment = await storeFileAttachment({
      attachmentsDir,
      threadId: "thread",
      name: "file.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("safe"),
    });
    const paths = fileAttachmentStoragePaths(attachmentsDir, attachment.id);
    const original = await readFile(paths.data);
    await rm(paths.data);
    try {
      await symlink(paths.metadata, paths.data);
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(readStoredFileAttachment({ attachmentsDir, attachment })).rejects.toMatchObject({
      code: "unavailable",
    });
    await rm(paths.data);
    await writeFile(paths.data, original);
    await rm(paths.metadata);
    await symlink(paths.data, paths.metadata);
    await expect(readStoredFileAttachment({ attachmentsDir, attachment })).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("sanitizes path-like/control names and returns only bounded plain text previews", () => {
    expect(normalizeFileAttachmentName("C:\\private\\script\u202E.html\n")).toBe("script.html");
    expect(normalizeFileAttachmentName("../..")).toBe("attachment");
    const truncatedEmoji = normalizeFileAttachmentName(`${"a".repeat(254)}📄.tex`);
    expect(truncatedEmoji.length).toBe(255);
    expect(() => encodeURIComponent(truncatedEmoji)).not.toThrow();
    expect(previewFileAttachment(Buffer.from("<script>alert(1)</script>"))).toEqual({
      text: "<script>alert(1)</script>",
      truncated: false,
    });
    expect(previewFileAttachment(Uint8Array.from([0, 255]))).toBeNull();
    expect(previewFileAttachment(Uint8Array.from([255, 255]))).toBeNull();
    expect(previewFileAttachment(Buffer.alloc(70 * 1024, "x"))).toEqual({
      text: "x".repeat(64 * 1024),
      truncated: true,
    });
  });
});
