// @effect-diagnostics nodeBuiltinImport:off
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import { storeFileAttachment } from "../fileAttachmentStore.ts";
import * as Extraction from "./fileAttachmentExtraction.ts";
import {
  appendFileAttachmentPrompt,
  FILE_ATTACHMENT_MANIFEST_MAX_BYTES,
  prepareFileAttachmentPrompt,
} from "./fileAttachmentPrompt.ts";

const temporaryDirectories: Array<string> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function upload(
  name: string,
  content: string | Uint8Array,
  mimeType = "application/octet-stream",
) {
  const attachmentsDir = await mkdtemp(path.join(os.tmpdir(), "cafe-provider-file-"));
  temporaryDirectories.push(attachmentsDir);
  const attachment = await storeFileAttachment({
    attachmentsDir,
    threadId: "attachment-test",
    name,
    mimeType,
    bytes: typeof content === "string" ? Buffer.from(content) : content,
  });
  return { attachmentsDir, threadId: "attachment-test", attachments: [attachment] };
}

function inventory(manifest: string): Array<{
  path: string;
  name: string;
  content: string;
  textView?: {
    path?: string;
    status?: string;
    scope?: string;
    truncated?: boolean;
    pagesRead?: number;
  };
}> {
  return JSON.parse(manifest.split("\n").at(-1) ?? "[]");
}

/** Minimal deterministic fixtures use the format, never external office tools. */
function pdf(text: string, pageCount = 1): Uint8Array {
  const stream = text ? `BT /F1 12 Tf 10 100 Td (${text}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${index + 5} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ...Array.from(
      { length: pageCount },
      () =>
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>",
    ),
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

function docx(
  xml: string,
  options: { duplicate?: boolean; declaredSize?: number; badCrc?: boolean } = {},
): Uint8Array {
  const bytes = Buffer.from(xml);
  const compressed = deflateRawSync(bytes);
  const name = Buffer.from("word/document.xml");
  const locals: Array<Buffer> = [];
  const directory: Array<Buffer> = [];
  let offset = 0;
  const count = options.duplicate ? 2 : 1;
  for (let index = 0; index < count; index++) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(options.badCrc ? 0 : crc32(bytes), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(options.declaredSize ?? bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(options.badCrc ? 0 : crc32(bytes), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(options.declaredSize ?? bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directoryBytes, end]);
}

function wordXml(body: string, prefix = "w"): string {
  return `<${prefix}:document xmlns:${prefix}="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><${prefix}:body>${body}</${prefix}:body></${prefix}:document>`;
}

describe("provider file attachments", () => {
  it.each(["page.html", "source.ts", "paper.tex", "settings.yaml", "unknown.customext"])(
    "stages %s as exact inert readable bytes without injecting its text",
    async (name) => {
      const secretBody =
        "ATTACHMENT_BODY_MUST_NOT_ENTER_THE_INITIAL_PROMPT<script>alert(1)</script>";
      const input = await upload(name, secretBody);
      const manifest = await prepareFileAttachmentPrompt(input);
      const entry = inventory(manifest)[0]!;
      expect(manifest).not.toContain(secretBody);
      expect(entry.content).toContain("UTF-8 text");
      expect(await readFile(entry.path, "utf8")).toBe(secretBody);
      expect(path.extname(entry.path)).toBe(path.extname(name));
      expect(Buffer.byteLength(manifest)).toBeLessThan(FILE_ATTACHMENT_MANIFEST_MAX_BYTES);
      if (process.platform !== "win32") expect((await stat(entry.path)).mode & 0o777).toBe(0o400);
      expect(await prepareFileAttachmentPrompt(input)).toBe(manifest);
      expect((await readdir(input.attachmentsDir)).some((entry) => entry.endsWith(".tmp"))).toBe(
        false,
      );
    },
  );

  it("honestly identifies opaque binary and empty files without interpreting them", async () => {
    const input = await upload("unknown.weird", Uint8Array.from([0, 255, 1, 2]));
    const entry = inventory(await prepareFileAttachmentPrompt(input))[0]!;
    expect(entry.content).toContain("Opaque binary file available; not parsed");
    expect(entry.textView).toBeUndefined();
    const empty = await upload("empty.txt", "");
    expect(inventory(await prepareFileAttachmentPrompt(empty))[0]?.content).toContain("UTF-8 text");
  });

  it("uses bounded escaped metadata and rejects a different owning task", async () => {
    const input = await upload('folder/evil"\n\u202e.txt', "private file content");
    const manifest = await prepareFileAttachmentPrompt(input);
    expect(manifest).not.toContain("\u202e");
    expect(manifest.split("\n")).toHaveLength(3);
    expect(inventory(manifest)[0]?.name).toBe('evil".txt');
    await expect(
      prepareFileAttachmentPrompt({ ...input, threadId: "unrelated-task" }),
    ).rejects.toThrow("unavailable");
  });

  it("rejects changed stored bytes and changed provider copies without overwriting them", async () => {
    const input = await upload("example.txt", "original");
    const entry = inventory(await prepareFileAttachmentPrompt(input))[0]!;
    await chmod(entry.path, 0o600);
    await writeFile(entry.path, "modified");
    await expect(prepareFileAttachmentPrompt(input)).rejects.toThrow("unavailable");
    expect(await readFile(entry.path, "utf8")).toBe("modified");
    const other = await upload("example.txt", "original");
    await writeFile(path.join(other.attachmentsDir, `${other.attachments[0]!.id}.bin`), "modified");
    await expect(prepareFileAttachmentPrompt(other)).rejects.toThrow("unavailable");
  });

  it("rejects provider-copy symlinks without following or changing their target", async (context) => {
    const input = await upload("safe.txt", "original");
    const target = path.join(input.attachmentsDir, "target.txt");
    await writeFile(target, "outside");
    try {
      await symlink(
        target,
        path.join(input.attachmentsDir, `${input.attachments[0]!.id}.provider.txt`),
      );
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip();
        return;
      }
      throw error;
    }
    await expect(prepareFileAttachmentPrompt(input)).rejects.toThrow("unavailable");
    expect(await readFile(target, "utf8")).toBe("outside");
  });

  it("supports concurrent delivery through one stable fully written copy", async () => {
    const input = await upload("concurrent.txt", "identical bytes");
    const [first, second] = await Promise.all([
      prepareFileAttachmentPrompt(input),
      prepareFileAttachmentPrompt(input),
    ]);
    expect(first).toBe(second);
    expect((await readdir(input.attachmentsDir)).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("creates a bounded PDF text view while preserving the original native PDF", async () => {
    const parser = vi.spyOn(Extraction, "extractFileAttachmentText");
    const input = await upload("example.pdf", pdf("Attachment PDF body"), "application/pdf");
    const manifest = await prepareFileAttachmentPrompt(input);
    const entry = inventory(manifest)[0]!;
    expect(entry.path).toMatch(/\.pdf$/);
    expect(entry.textView?.path).toMatch(/\.provider\.pdf\.txt$/);
    expect(entry.textView?.pagesRead).toBe(1);
    expect(await readFile(entry.textView!.path!, "utf8")).toContain("Attachment PDF body");
    expect(manifest).not.toContain("Attachment PDF body");
    expect(entry.textView?.scope).toContain("images, charts, layout");
    expect(await prepareFileAttachmentPrompt(input)).toBe(manifest);
    expect(parser).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("single-flights extraction and verifies cached sidecars before reuse", async () => {
    const parser = vi.spyOn(Extraction, "extractFileAttachmentText");
    const input = await upload(
      "cache.docx",
      docx(wordXml("<w:p><w:r><w:t>cached body</w:t></w:r></w:p>")),
    );
    const [first, second] = await Promise.all([
      prepareFileAttachmentPrompt(input),
      prepareFileAttachmentPrompt(input),
    ]);
    expect(first).toBe(second);
    expect(parser).toHaveBeenCalledTimes(1);
    const textPath = inventory(first)[0]!.textView!.path!;
    await chmod(textPath, 0o600);
    await writeFile(textPath, "changed body");
    if (process.platform !== "win32") await chmod(textPath, 0o400);
    await expect(prepareFileAttachmentPrompt(input)).rejects.toThrow("unavailable");
    expect(parser).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("caps the extracted DOCX view and declares its omission", async () => {
    const input = await upload(
      "large.docx",
      docx(wordXml(`<w:p><w:r><w:t>${"a".repeat(1024 * 1024 + 20)}</w:t></w:r></w:p>`)),
    );
    const entry = inventory(await prepareFileAttachmentPrompt(input))[0]!;
    expect(entry.textView?.truncated).toBe(true);
    expect((await stat(entry.textView!.path!)).size).toBeLessThanOrEqual(1024 * 1024);
  }, 20_000);

  it("does not call a visual-only or malformed PDF successfully understood", async () => {
    for (const content of [pdf(""), Buffer.from("%PDF-1.4\nmalformed")]) {
      const input = await upload("scan.pdf", content, "application/pdf");
      const entry = inventory(await prepareFileAttachmentPrompt(input))[0]!;
      expect(entry.textView?.status).toBe("unavailable");
      expect(await readFile(entry.path)).toEqual(Buffer.from(content));
    }
  }, 20_000);

  it("bounds PDF extraction to 200 pages and declares remaining pages", async () => {
    const input = await upload("long.pdf", pdf("page text", 201), "application/pdf");
    const entry = inventory(await prepareFileAttachmentPrompt(input))[0]!;
    expect(entry.textView?.pagesRead).toBe(200);
    expect(entry.textView?.truncated).toBe(true);
    expect(await readFile(entry.textView!.path!, "utf8")).not.toContain("[Page 201]");
  }, 20_000);

  it("extracts only bounded DOCX body text and leaves the full archive intact", async () => {
    const content = docx(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Document &amp; text</w:t><w:tab/><w:t>&#x3b1;</w:t></w:r></w:p></w:body></w:document>',
    );
    const input = await upload("example.docx", content);
    const manifest = await prepareFileAttachmentPrompt(input);
    const entry = inventory(manifest)[0]!;
    expect(await readFile(entry.path)).toEqual(Buffer.from(content));
    expect(await readFile(entry.textView!.path!, "utf8")).toBe("Document & text\tα\n");
    expect(entry.textView?.scope).toContain("Main document body text only");
    expect(manifest).not.toContain("Document & text");
  }, 20_000);

  it.each([{ duplicate: true }, { declaredSize: 5 * 1024 * 1024 }, { badCrc: true }])(
    "fails closed on ambiguous/oversized/corrupt DOCX members: %j",
    async (options) => {
      const input = await upload(
        "unsafe.docx",
        docx(wordXml("<w:p><w:r><w:t>untrusted</w:t></w:r></w:p>"), options),
      );
      const entry = inventory(await prepareFileAttachmentPrompt(input))[0]!;
      expect(entry.textView?.status).toBe("unavailable");
    },
    20_000,
  );

  it("never expands custom XML entities", async () => {
    const input = await upload(
      "unsafe.docx",
      docx(
        '<!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///private/credential">]>' +
          wordXml("<w:p><w:r><w:t>&x;</w:t></w:r></w:p>"),
      ),
    );
    expect(inventory(await prepareFileAttachmentPrompt(input))[0]?.textView?.status).toBe(
      "unavailable",
    );
  }, 20_000);

  it("uses XML namespaces and ignores text-looking comments and instructions", async () => {
    const input = await upload(
      "namespace.docx",
      docx(
        wordXml(
          "<!-- <a:t>COMMENT_NOT_TEXT</a:t> --><?instruction ignore?><a:p><a:r><a:t>Actual &amp; </a:t><a:t><![CDATA[CDATA text]]></a:t></a:r></a:p>",
          "a",
        ),
      ),
    );
    const entry = inventory(await prepareFileAttachmentPrompt(input))[0]!;
    expect(await readFile(entry.textView!.path!, "utf8")).toBe("Actual & CDATA text\n");
  }, 20_000);

  it("rejects excessively deep or malformed XML without interpreting a partial view", async () => {
    for (const xml of [
      wordXml("<w:p>".repeat(257) + "</w:p>".repeat(257)),
      wordXml("<w:p><w:t>unclosed"),
    ]) {
      const input = await upload("malformed.docx", docx(xml));
      expect(inventory(await prepareFileAttachmentPrompt(input))[0]?.textView?.status).toBe(
        "unavailable",
      );
    }
  }, 20_000);

  it("does not alter image-only or text-only provider prompts", async () => {
    expect(
      await prepareFileAttachmentPrompt({
        attachmentsDir: "not-read",
        threadId: "test",
        attachments: undefined,
      }),
    ).toBe("");
    expect(appendFileAttachmentPrompt("original\n", "")).toBe("original\n");
    expect(appendFileAttachmentPrompt(undefined, "manifest")).toBe("manifest");
    expect(appendFileAttachmentPrompt("text", "manifest")).toBe("text\n\nmanifest");
  });

  it("does not resurrect derivatives when deletion wins during shared extraction", async () => {
    const input = await upload("deleted.pdf", pdf("private deleted text"), "application/pdf");
    const started = Promise.withResolvers<void>();
    const extracted =
      Promise.withResolvers<Awaited<ReturnType<typeof Extraction.extractFileAttachmentText>>>();
    const parser = vi.spyOn(Extraction, "extractFileAttachmentText").mockImplementation(() => {
      started.resolve();
      return extracted.promise;
    });
    // Attach rejection handlers immediately: the two callers share one parser
    // but both must fail, with no unhandled rejection during filesystem awaits.
    const completions = Promise.allSettled([
      prepareFileAttachmentPrompt(input),
      prepareFileAttachmentPrompt(input),
    ]);
    await started.promise;
    const id = input.attachments[0]!.id;
    await rm(path.join(input.attachmentsDir, `${id}.metadata.json`));
    for (const entry of await readdir(input.attachmentsDir))
      await rm(path.join(input.attachmentsDir, entry), { force: true });
    extracted.resolve({ text: "private deleted text", truncated: false });
    const results = await completions;
    expect(parser).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(await readdir(input.attachmentsDir)).toEqual([]);
  });

  it("cleans only its newly published copies when source ownership disappears", async () => {
    const source = pdf("existing copy");
    const input = await upload("existing.pdf", source, "application/pdf");
    const id = input.attachments[0]!.id;
    const existingPath = path.join(input.attachmentsDir, `${id}.provider.pdf`);
    await writeFile(existingPath, source, { mode: process.platform === "win32" ? 0o600 : 0o400 });
    const started = Promise.withResolvers<void>();
    const extracted =
      Promise.withResolvers<Awaited<ReturnType<typeof Extraction.extractFileAttachmentText>>>();
    vi.spyOn(Extraction, "extractFileAttachmentText").mockImplementation(() => {
      started.resolve();
      return extracted.promise;
    });
    const completion = Promise.allSettled([prepareFileAttachmentPrompt(input)]);
    await started.promise;
    await rm(path.join(input.attachmentsDir, `${id}.metadata.json`));
    extracted.resolve({ text: "late text view", truncated: false });
    expect((await completion)[0]?.status).toBe("rejected");
    expect(await readFile(existingPath)).toEqual(Buffer.from(source));
    expect(await readdir(input.attachmentsDir)).toEqual(
      expect.arrayContaining([`${id}.bin`, `${id}.provider.pdf`]),
    );
    expect((await readdir(input.attachmentsDir)).some((entry) => entry.endsWith(".pdf.txt"))).toBe(
      false,
    );
  });
});
