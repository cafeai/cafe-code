// @effect-diagnostics nodeBuiltinImport:off
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { storeFileAttachment } from "../src/fileAttachmentStore.ts";
import * as Extraction from "../src/provider/fileAttachmentExtraction.ts";
import {
  FILE_ATTACHMENT_MANIFEST_MAX_BYTES,
  prepareFileAttachmentPrompt,
} from "../src/provider/fileAttachmentPrompt.ts";
import { createPdfFixture as pdf } from "./fixtures/pdf.ts";

/*
 * Required native PDF qualification, explicitly selected by CI after the
 * default suite on every host. These tests invoke the real isolated parser,
 * with its unchanged 15-second deadline and no mock result, retry or provider.
 * The default prompt tests separately exercise cache/manifest policy against
 * controlled extraction results. Both layers use the same inert PDF fixture.
 */
const temporaryDirectories: Array<string> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function upload(name: string, bytes: Uint8Array) {
  const attachmentsDir = await mkdtemp(path.join(os.tmpdir(), "cafe-pdf-qualification-"));
  temporaryDirectories.push(attachmentsDir);
  const attachment = await storeFileAttachment({
    attachmentsDir,
    threadId: "pdf-qualification",
    name,
    mimeType: "application/pdf",
    bytes,
  });
  return { attachmentsDir, threadId: "pdf-qualification", attachments: [attachment] };
}

function inventory(manifest: string): Array<{
  path: string;
  textView?: {
    path?: string;
    status?: string;
    scope?: string;
    truncated?: boolean;
    pagesRead?: number;
    totalPages?: number;
  };
}> {
  return JSON.parse(manifest.split("\n").at(-1) ?? "[]");
}

describe("real isolated PDF attachment extraction", () => {
  it("creates a bounded PDF text view while preserving the original native PDF", async () => {
    // A call-through spy observes cache reuse without replacing the real child.
    const parser = vi.spyOn(Extraction, "extractFileAttachmentText");
    const source = pdf("Attachment PDF body");
    const input = await upload("example.pdf", source);
    const manifest = await prepareFileAttachmentPrompt(input);
    const entry = inventory(manifest)[0]!;
    expect(entry.path).toMatch(/\.pdf$/);
    expect(await readFile(entry.path)).toEqual(Buffer.from(source));
    expect(entry.textView?.path).toMatch(/\.provider\.pdf\.txt$/);
    expect(entry.textView?.pagesRead).toBe(1);
    expect(await readFile(entry.textView!.path!, "utf8")).toContain("Attachment PDF body");
    expect(manifest).not.toContain("Attachment PDF body");
    expect(entry.textView?.scope).toContain("images, charts, layout");
    expect(Buffer.byteLength(manifest)).toBeLessThan(FILE_ATTACHMENT_MANIFEST_MAX_BYTES);
    expect((await stat(entry.textView!.path!)).size).toBeLessThanOrEqual(
      Extraction.FILE_EXTRACTION_MAX_TEXT_BYTES,
    );
    if (process.platform !== "win32") {
      expect((await stat(entry.path)).mode & 0o777).toBe(0o400);
      expect((await stat(entry.textView!.path!)).mode & 0o777).toBe(0o400);
    }
    expect(await prepareFileAttachmentPrompt(input)).toBe(manifest);
    expect(parser).toHaveBeenCalledExactlyOnceWith("pdf", source);
  }, 20_000);

  it("does not call a visual-only or malformed PDF successfully understood", async () => {
    const parser = vi.spyOn(Extraction, "extractFileAttachmentText");
    for (const [index, content] of [pdf(""), Buffer.from("%PDF-1.4\nmalformed")].entries()) {
      const input = await upload("scan.pdf", content);
      const entry = inventory(await prepareFileAttachmentPrompt(input))[0]!;
      expect(entry.textView?.status).toBe("unavailable");
      expect(entry.textView?.path).toBeUndefined();
      expect(await readFile(entry.path)).toEqual(Buffer.from(content));
      expect(parser).toHaveBeenLastCalledWith("pdf", content);
      const extraction = await parser.mock.results[index]!.value;
      if (index === 0) {
        // The valid empty page must actually parse: a timed-out child must not
        // make this negative qualification pass for the wrong reason.
        expect(extraction).toMatchObject({ pagesRead: 1, totalPages: 1, hasText: false });
      } else {
        expect(extraction).toBeUndefined();
      }
    }
    expect(parser).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("bounds PDF extraction to 200 pages and declares remaining pages", async () => {
    const parser = vi.spyOn(Extraction, "extractFileAttachmentText");
    const source = pdf("page text", 201);
    const input = await upload("long.pdf", source);
    const entry = inventory(await prepareFileAttachmentPrompt(input))[0]!;
    expect(entry.textView?.pagesRead).toBe(200);
    expect(entry.textView?.totalPages).toBe(201);
    expect(entry.textView?.truncated).toBe(true);
    const extractedText = await readFile(entry.textView!.path!, "utf8");
    expect(extractedText).toContain("[Page 200]");
    expect(extractedText).not.toContain("[Page 201]");
    expect(await readFile(entry.path)).toEqual(Buffer.from(source));
    expect(parser).toHaveBeenCalledExactlyOnceWith("pdf", source);
  }, 20_000);
});
