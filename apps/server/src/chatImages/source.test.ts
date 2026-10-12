import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CHAT_IMAGE_MAX_BYTES } from "@cafecode/contracts";
import { markdownImageSources, readWorkspaceImage } from "./source.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
  "base64",
);
const temporary: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cafe-chat-image-"));
  temporary.push(directory);
  const root = join(directory, "workspace");
  await mkdir(root);
  return { root, directory };
}
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("parses actual images and references, excluding code, links and incomplete syntax", () => {
  expect(
    markdownImageSources(
      [
        "![Chart](</repo/chart with spaces.png>)",
        "![Reference][plot]",
        "",
        "[plot]: /repo/ref.png",
        "",
        "[Link](/repo/link.png)",
        "`![Example](/repo/inline.png)`",
        "```md",
        "![Example](/repo/fenced.png)",
        "```",
        "![Incomplete](/repo/not-done.png",
      ].join("\n"),
    ),
  ).toEqual([
    { source: "/repo/chart%20with%20spaces.png", path: "/repo/chart with spaces.png" },
    { source: "/repo/ref.png", path: "/repo/ref.png" },
  ]);
  expect(
    markdownImageSources(Array.from({ length: 20 }, (_, i) => `![x](/repo/${i}.png)`).join("\n")),
  ).toHaveLength(8);
});

it("reads byte-identified raster files inside the workspace and explicit additional roots", async () => {
  const { root, directory } = await fixture();
  const folder = join(root, "nested");
  await mkdir(folder);
  const image = join(folder, "chart with spaces.png");
  await writeFile(image, png);
  expect(await readWorkspaceImage(image, [root])).toMatchObject({
    bytes: png,
    mimeType: "image/png",
    width: 1,
    height: 1,
  });
  const extra = join(directory, "extra");
  await mkdir(extra);
  const extraImage = join(extra, "chart.png");
  await writeFile(extraImage, png);
  await expect(readWorkspaceImage(extraImage, [root])).rejects.toThrow("unavailable");
  expect((await readWorkspaceImage(extraImage, [root, extra])).bytes).toEqual(png);
});

it("rejects outside roots, sibling prefixes, directories, executable content and oversized images", async () => {
  const { root, directory } = await fixture();
  const outside = join(directory, "outside.png");
  await writeFile(outside, png);
  await expect(readWorkspaceImage(outside, [root])).rejects.toThrow("unavailable");
  await expect(readWorkspaceImage(join(root, "..", "outside.png"), [root])).rejects.toThrow(
    "unavailable",
  );
  await expect(readWorkspaceImage(`file://${outside}`, [root])).rejects.toThrow("unavailable");
  await expect(readWorkspaceImage(root, [root])).rejects.toThrow("unavailable");
  const html = join(root, "looks-like.png");
  await writeFile(html, "<svg onload='alert(1)'></svg>");
  await expect(readWorkspaceImage(html, [root])).rejects.toThrow("unavailable");
  const big = join(root, "big.png");
  await writeFile(big, Buffer.alloc(CHAT_IMAGE_MAX_BYTES + 1));
  await expect(readWorkspaceImage(big, [root])).rejects.toThrow("unavailable");
  const huge = Buffer.from(png);
  huge.writeUInt32BE(16000, 16);
  huge.writeUInt32BE(16000, 20);
  await writeFile(html, huge);
  await expect(readWorkspaceImage(html, [root])).rejects.toThrow("unavailable");
});

it("rejects symlink files and directory escapes", async (context) => {
  const { root, directory } = await fixture();
  const outside = join(directory, "outside.png");
  await writeFile(outside, png);
  try {
    await symlink(outside, join(root, "link.png"));
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip();
      return;
    }
    throw error;
  }
  await expect(readWorkspaceImage(join(root, "link.png"), [root])).rejects.toThrow("unavailable");
  await symlink(directory, join(root, "escape"), "junction");
  await expect(readWorkspaceImage(join(root, "escape", "outside.png"), [root])).rejects.toThrow(
    "unavailable",
  );
});
