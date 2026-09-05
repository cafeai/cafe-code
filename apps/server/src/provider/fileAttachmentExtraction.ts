// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** All parsing budgets are independent of provider/model context limits. */
export const FILE_EXTRACTION_MAX_TEXT_BYTES = 1024 * 1024;
export const FILE_EXTRACTION_MAX_PDF_PAGES = 200;
const FILE_EXTRACTION_TIMEOUT_MS = 15_000;
const FILE_EXTRACTION_MAX_RESULT_BYTES = 8 * 1024 * 1024;

export interface FileAttachmentExtraction {
  readonly text: string;
  readonly truncated: boolean;
  readonly pagesRead?: number;
  readonly totalPages?: number;
  readonly hasText?: boolean;
}

/*
 * PDF/ZIP parsers consume attacker-controlled compressed structures. Keep them
 * out of the long-lived provider daemon's heap/event loop: this fixed Node
 * program receives only validated upload bytes on stdin, has a finite heap and
 * deadline, and returns at most a bounded plain-text result. No filenames,
 * prompts, credentials, or user-selected code enter its argv/environment.
 *
 * PDF.js is used as a text reader, not a viewer. JavaScript evaluation, font
 * loading and network fetches are disabled. Yauzl reads only the exact main
 * DOCX body member; nothing is unpacked to disk and links/macros are ignored.
 * Sources: https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html
 * and https://github.com/thejoshwolfe/yauzl#security-and-stability.
 */
const EXTRACTION_PROGRAM = String.raw`
import { crc32 } from "node:zlib";
const MAX_INPUT = 25 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const MAX_XML = 4 * 1024 * 1024;
const MAX_PAGES = 200;
const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > MAX_INPUT) process.exit(1);
  chunks.push(chunk);
}
const bytes = Buffer.concat(chunks);
const mode = process.argv[1];
globalThis.fetch = async () => { throw new Error("Network unavailable"); };
// Libraries may emit warnings on stdout. The protocol permits only our final
// JSON result; silence library console output without retaining it anywhere.
console.log = console.warn = console.error = console.info = console.debug = () => {};
let text = "";
let remaining = MAX_TEXT;
let truncated = false;
function append(value) {
  const encoded = Buffer.from(value);
  if (encoded.length <= remaining) {
    text += value;
    remaining -= encoded.length;
    return;
  }
  // A nonfatal decode drops the incomplete last UTF-8 code point without
  // growing beyond the byte cap; no replacement code point is introduced.
  let end = remaining;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  text += encoded.subarray(0, end).toString("utf8");
  remaining = 0;
  truncated = true;
}
try {
  if (mode === "pdf") {
    const pdfjs = await import(process.argv[2]);
    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes), isEvalSupported: false,
      useSystemFonts: false, disableFontFace: true, useWorkerFetch: false,
      disableAutoFetch: true, disableRange: true, stopAtErrors: true,
      isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
      verbosity: 0,
    });
    const pdf = await task.promise;
    let pagesRead = 0;
    let hasText = false;
    for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, MAX_PAGES); pageNumber++) {
      if (remaining === 0) { truncated = true; break; }
      const page = await pdf.getPage(pageNumber);
      append("\n[Page " + pageNumber + "]\n");
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (typeof item.str !== "string") continue;
        hasText ||= item.str.trim().length > 0;
        append(item.str + (item.hasEOL ? "\n" : " "));
        if (remaining === 0) break;
      }
      pagesRead++;
      page.cleanup();
    }
    truncated ||= pagesRead < pdf.numPages;
    const totalPages = pdf.numPages;
    await task.destroy();
    process.stdout.write(JSON.stringify({ text, truncated, pagesRead, totalPages, hasText }));
  } else if (mode === "docx") {
    const imported = await import(process.argv[2]);
    const yauzl = imported.default ?? imported;
    const xmlBytes = await new Promise((resolve, reject) => {
      yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true,
        strictFileNames: true, autoClose: false }, (error, zip) => {
        if (error) return reject(error);
        let chosen;
        let entries = 0;
        let settled = false;
        const fail = () => {
          if (settled) return;
          settled = true;
          zip.close();
          reject(new Error("Invalid DOCX"));
        };
        zip.on("error", fail);
        zip.on("entry", entry => {
          if (settled) return;
          if (++entries > 2048) return fail();
          if (entry.fileName === "word/document.xml") {
            if (chosen || entry.isEncrypted() || entry.uncompressedSize > MAX_XML ||
                entry.uncompressedSize < 1 || ![0, 8].includes(entry.compressionMethod) ||
                ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) return fail();
            chosen = entry;
          }
          zip.readEntry();
        });
        zip.on("end", () => {
          if (settled) return;
          if (!chosen) return fail();
          zip.openReadStream(chosen, (error, stream) => {
            if (error) return fail();
            const body = [];
            let length = 0;
            stream.on("error", fail);
            stream.on("data", chunk => {
              length += chunk.length;
              if (length > MAX_XML) { stream.destroy(); fail(); return; }
              body.push(chunk);
            });
            stream.on("end", () => {
              if (settled) return;
              const result = Buffer.concat(body);
              if (result.length !== chosen.uncompressedSize || crc32(result) !== chosen.crc32) return fail();
              settled = true;
              zip.close();
              resolve(result);
            });
          });
        });
        zip.readEntry();
      });
    });
    const xml = new TextDecoder("utf-8", { fatal: true }).decode(xmlBytes);
    // Parse XML namespaces, not prefix spellings or regex-looking markup.
    // Saxes never fetches DTDs; reject even a declaration so no custom entity
    // can be introduced. Comments and instructions are not document text.
    const saxes = await import(process.argv[3]);
    const parser = new saxes.SaxesParser({ xmlns: true });
    const wordNamespaces = new Set([
      "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
      "http://purl.oclc.org/ooxml/wordprocessingml/main",
    ]);
    let depth = 0;
    let bodyDepth;
    let textDepth;
    let sawDocument = false;
    let sawBody = false;
    const fail = () => { throw new Error("Invalid DOCX XML"); };
    parser.on("error", fail);
    parser.on("doctype", fail);
    parser.on("opentag", tag => {
      if (++depth > 256) fail();
      if (!wordNamespaces.has(tag.uri)) return;
      if (depth === 1 && tag.local === "document") sawDocument = true;
      if (sawDocument && depth === 2 && tag.local === "body") { bodyDepth = depth; sawBody = true; }
      if (bodyDepth === undefined) return;
      if (tag.local === "t") textDepth = depth;
      else if (tag.local === "tab") append("\t");
      else if (tag.local === "br" || tag.local === "cr") append("\n");
    });
    const onText = value => { if (textDepth !== undefined) append(value); };
    parser.on("text", onText);
    parser.on("cdata", onText);
    parser.on("closetag", tag => {
      if (depth === textDepth) textDepth = undefined;
      if (bodyDepth !== undefined && wordNamespaces.has(tag.uri) && tag.local === "p") append("\n");
      if (depth === bodyDepth) bodyDepth = undefined;
      depth--;
    });
    parser.write(xml).close();
    if (!sawDocument || !sawBody) fail();
    process.stdout.write(JSON.stringify({ text, truncated }));
  } else process.exitCode = 1;
} catch { process.exitCode = 1; }
`;

/** Failure is an unavailable optional text view, never false successful parsing. */
export async function extractFileAttachmentText(
  kind: "pdf" | "docx",
  bytes: Uint8Array,
): Promise<FileAttachmentExtraction | undefined> {
  let moduleUrl: string;
  let xmlModuleUrl: string | undefined;
  try {
    const resolve = createRequire(import.meta.url).resolve;
    moduleUrl = pathToFileURL(
      resolve(kind === "pdf" ? "pdfjs-dist/legacy/build/pdf.mjs" : "yauzl"),
    ).href;
    if (kind === "docx") xmlModuleUrl = pathToFileURL(resolve("saxes")).href;
  } catch {
    return undefined;
  }
  return new Promise((resolve) => {
    let settled = false;
    let bytesReceived = 0;
    const chunks: Array<Buffer> = [];
    const child = spawn(
      process.execPath,
      [
        "--max-old-space-size=256",
        "--input-type=module",
        "--eval",
        EXTRACTION_PROGRAM,
        kind,
        moduleUrl,
        ...(xmlModuleUrl ? [xmlModuleUrl] : []),
      ],
      {
        shell: false,
        windowsHide: true,
        // Parsing never needs provider credentials or user-selected Node hooks.
        env: {
          // Packaged backends run under Electron's executable, whereas source
          // installs use standalone Node. The same fixed flag is harmless for
          // Node and prevents an extraction child from opening an Electron app.
          ELECTRON_RUN_AS_NODE: "1",
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
        },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const finish = (value: FileAttachmentExtraction | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(value);
    };
    const deadline = setTimeout(() => {
      // This child never launches subprocesses. A hard kill is the bounded
      // backstop for a native/parser stall; wait for close before settling.
      child.kill("SIGKILL");
    }, FILE_EXTRACTION_TIMEOUT_MS);
    child.on("error", () => finish(undefined));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      bytesReceived += chunk.byteLength;
      if (bytesReceived > FILE_EXTRACTION_MAX_RESULT_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (code !== 0 || bytesReceived > FILE_EXTRACTION_MAX_RESULT_BYTES) return finish(undefined);
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof value !== "object" || value === null) return finish(undefined);
        const result = value as Record<string, unknown>;
        if (
          typeof result.text !== "string" ||
          typeof result.truncated !== "boolean" ||
          Buffer.byteLength(result.text) > FILE_EXTRACTION_MAX_TEXT_BYTES
        )
          return finish(undefined);
        if (
          kind === "pdf" &&
          (!Number.isSafeInteger(result.pagesRead) ||
            !Number.isSafeInteger(result.totalPages) ||
            Number(result.pagesRead) < 0 ||
            Number(result.pagesRead) > FILE_EXTRACTION_MAX_PDF_PAGES ||
            Number(result.totalPages) < Number(result.pagesRead) ||
            typeof result.hasText !== "boolean")
        )
          return finish(undefined);
        finish({
          text: result.text,
          truncated: result.truncated,
          ...(kind === "pdf"
            ? {
                pagesRead: Number(result.pagesRead),
                totalPages: Number(result.totalPages),
                hasText: result.hasText as boolean,
              }
            : {}),
        });
      } catch {
        finish(undefined);
      }
    });
    child.stdin.end(bytes);
  });
}
