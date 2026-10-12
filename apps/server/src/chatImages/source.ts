// @effect-diagnostics nodeBuiltinImport:off
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { normalizeUri } from "micromark-util-sanitize-uri";
import { fromMarkdown } from "mdast-util-from-markdown";
import { CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MAX_PER_MESSAGE } from "@cafecode/contracts";
import { parseImageHeader } from "../rasterImageHeader.ts";

export function markdownImageSources(text: string): Array<{ source: string; path: string }> {
  // Parse only completed, bounded messages, never per-token deltas. A regex
  // cannot distinguish examples in code from actual Markdown image nodes.
  if (text.length > 512 * 1024 || !text.includes("![")) return [];
  const tree = fromMarkdown(text);
  const definitions = new Map<string, string>();
  const images: Array<{ url?: string; identifier?: string }> = [];
  const visit = (node: typeof tree | (typeof tree.children)[number]) => {
    if (node.type === "definition") definitions.set(node.identifier, node.url);
    if (node.type === "image") images.push({ url: node.url });
    if (node.type === "imageReference") images.push({ identifier: node.identifier });
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(tree);
  return [...new Set(images.map((image) => image.url ?? definitions.get(image.identifier ?? "")))]
    .filter((source): source is string => Boolean(source))
    .slice(0, CHAT_IMAGE_MAX_PER_MESSAGE)
    .map((path) => ({ source: normalizeUri(path), path }));
}

function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

const descriptorPath = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;

/** Read only regular raster files below explicit workspace roots. */
export async function readWorkspaceImage(source: string, roots: readonly string[]) {
  if (!source || source.length > 32_768 || /[\p{Cc}]/u.test(source) || !path.isAbsolute(source))
    throw new Error("image unavailable");
  if (process.platform === "win32" && (/^\\\\[?.]/u.test(source) || source.slice(2).includes(":")))
    throw new Error("image unavailable");
  const target = path.normalize(source);
  const configuredRoot = roots.find(
    (root) => path.isAbsolute(root) && inside(path.resolve(root), target),
  );
  if (!configuredRoot) throw new Error("image unavailable");
  const root = await realpath(configuredRoot);
  const relative = path.relative(path.resolve(configuredRoot), target);
  const parts = relative.split(path.sep);
  const handles: FileHandle[] = [];
  const identities: Array<{ name: string; dev: bigint; ino: bigint }> = [];
  const noFollow = constants.O_NOFOLLOW ?? 0;

  const checkIdentities = async () => {
    for (const expected of identities) {
      const current = await lstat(expected.name, { bigint: true });
      if (current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino)
        throw new Error("image unavailable");
    }
  };
  try {
    let directory = root;
    // Linux traverses relative to held parents through procfs. macOS /dev/fd
    // cannot look up children: hold directory descriptors and verify named
    // identities before/after the read. Windows uses those namespace checks
    // without POSIX directory handles or chmod.
    for (let index = 0; index < parts.length; index++) {
      const name = index === 0 ? root : path.join(directory, parts[index - 1]!);
      const before = await lstat(name, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("image unavailable");
      identities.push({ name, dev: before.dev, ino: before.ino });
      if (process.platform !== "win32") {
        const heldName =
          index === 0 || process.platform !== "linux"
            ? name
            : path.join(descriptorPath(handles.at(-1)!), parts[index - 1]!);
        const held = await open(heldName, constants.O_RDONLY | constants.O_DIRECTORY | noFollow);
        handles.push(held);
        const info = await held.stat({ bigint: true });
        if (info.dev !== before.dev || info.ino !== before.ino)
          throw new Error("image unavailable");
      }
      directory = name;
    }
    const name = path.join(root, relative);
    const before = await lstat(name, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(CHAT_IMAGE_MAX_BYTES))
      throw new Error("image unavailable");
    const handle = await open(
      process.platform === "linux"
        ? path.join(descriptorPath(handles.at(-1)!), parts.at(-1)!)
        : name,
      constants.O_RDONLY | noFollow | constants.O_NONBLOCK,
    );
    handles.push(handle);
    const info = await handle.stat({ bigint: true });
    if (
      !info.isFile() ||
      info.dev !== before.dev ||
      info.ino !== before.ino ||
      info.size !== before.size
    )
      throw new Error("image unavailable");
    await checkIdentities();
    const bytes = Buffer.alloc(Number(info.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    await checkIdentities();
    const current = await lstat(name, { bigint: true });
    if (
      length !== Number(info.size) ||
      length > CHAT_IMAGE_MAX_BYTES ||
      after.size !== info.size ||
      after.mtimeNs !== info.mtimeNs ||
      after.ctimeNs !== info.ctimeNs ||
      current.isSymbolicLink() ||
      current.dev !== info.dev ||
      current.ino !== info.ino
    )
      throw new Error("image unavailable");
    const data = bytes.subarray(0, length);
    const metadata = parseImageHeader(data);
    if (
      !metadata ||
      metadata.width > 16_384 ||
      metadata.height > 16_384 ||
      metadata.width * metadata.height > 40_000_000
    )
      throw new Error("image unavailable");
    return { bytes: data, ...metadata, sizeBytes: length };
  } finally {
    for (const handle of handles.toReversed()) await handle.close();
  }
}
