import { describe, expect, it } from "vitest";

import {
  isPathInsideWorkspace,
  resolveMarkdownFileLinkMeta,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
} from "./markdown-links";

describe("rewriteMarkdownFileUriHref", () => {
  it("rewrites file uri hrefs into direct path hrefs", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/src/main.ts#L42")).toBe(
      "/Users/julius/project/src/main.ts#L42",
    );
  });

  it("preserves encoded octets so file paths are decoded only once later", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%2520name.md",
    );
  });

  it("normalizes file uri hrefs for windows drive paths", () => {
    expect(
      rewriteMarkdownFileUriHref(
        "file:///D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69");
  });

  it("unwraps angle-bracketed file uri hrefs", () => {
    expect(
      rewriteMarkdownFileUriHref(" <file:///D:/Programme/t3code/apps/web/src/markdown-links.ts> "),
    ).toBe("D:/Programme/t3code/apps/web/src/markdown-links.ts");
  });
});

describe("resolveMarkdownFileLinkTarget", () => {
  it("resolves absolute posix file paths", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/AGENTS.md")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("resolves relative file paths against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("src/processRunner.ts:71", "/Users/julius/project")).toBe(
      "/Users/julius/project/src/processRunner.ts:71",
    );
  });

  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  it("resolves bare file names against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("AGENTS.md", "/Users/julius/project")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("maps #L line anchors to editor line suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  it("ignores external urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
  });

  it("does not double-decode file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });

  it("formats tooltip display paths relative to the cwd when possible", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "file:///C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts#L501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toMatchObject({
      displayPath: "t3code/apps/web/src/session-logic.ts:501",
    });
  });

  it("formats tooltip display paths relative to the cwd for slash-prefixed windows paths", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "/C:/Users/mike/dev-stuff/t3code/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toMatchObject({
      displayPath:
        "t3code/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
    });
  });

  it("normalizes slash-prefixed windows drive paths before resolving", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "/D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx:69");
  });

  it("resolves angle-bracketed windows drive paths", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "</D:/Programme/t3code/apps/web/src/components/ChatMarkdown.tsx:1>",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/ChatMarkdown.tsx:1");
  });

  it("does not treat app routes as file links", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
  });
});

describe("markdown file link workspace policy", () => {
  it("allows direct opens for POSIX paths inside the workspace", () => {
    expect(
      resolveMarkdownFileLinkMeta("/Users/julius/project/src/main.ts#L42", "/Users/julius/project"),
    ).toMatchObject({
      targetPath: "/Users/julius/project/src/main.ts:42",
      openPolicy: "direct",
    });
  });

  it("requires confirmation for POSIX paths outside the workspace", () => {
    expect(resolveMarkdownFileLinkMeta("/etc/passwd", "/Users/julius/project")).toMatchObject({
      targetPath: "/etc/passwd",
      openPolicy: "confirm",
    });
    expect(resolveMarkdownFileLinkMeta("/tmp/output.log", "/Users/julius/project")).toMatchObject({
      targetPath: "/tmp/output.log",
      openPolicy: "confirm",
    });
  });

  it("handles macOS volume paths by workspace containment", () => {
    expect(
      resolveMarkdownFileLinkMeta("/Volumes/Data/project/src/main.ts", "/Volumes/Data/project"),
    ).toMatchObject({
      openPolicy: "direct",
    });
    expect(
      resolveMarkdownFileLinkMeta("/Volumes/Secrets/key.txt", "/Volumes/Data/project"),
    ).toMatchObject({
      openPolicy: "confirm",
    });
  });

  it("handles Windows drive and UNC workspace containment", () => {
    expect(
      resolveMarkdownFileLinkMeta("C:/Users/mike/project/src/main.ts", "C:/Users/mike/project"),
    ).toMatchObject({
      openPolicy: "direct",
    });
    expect(
      resolveMarkdownFileLinkMeta("C:/Users/mike/other/secret.txt", "C:/Users/mike/project"),
    ).toMatchObject({
      openPolicy: "confirm",
    });
    expect(
      resolveMarkdownFileLinkMeta(
        "\\\\server\\share\\project\\src\\main.ts",
        "\\\\server\\share\\project",
      ),
    ).toMatchObject({
      openPolicy: "direct",
    });
    expect(
      resolveMarkdownFileLinkMeta(
        "\\\\server\\share\\other\\secret.txt",
        "\\\\server\\share\\project",
      ),
    ).toMatchObject({
      openPolicy: "confirm",
    });
  });

  it("treats relative and file URL links according to the resolved workspace path", () => {
    expect(resolveMarkdownFileLinkMeta("src/main.ts", "/Users/julius/project")).toMatchObject({
      targetPath: "/Users/julius/project/src/main.ts",
      openPolicy: "direct",
    });
    expect(
      resolveMarkdownFileLinkMeta(
        "file:///Users/julius/project/src/main.ts",
        "/Users/julius/project",
      ),
    ).toMatchObject({
      targetPath: "/Users/julius/project/src/main.ts",
      openPolicy: "direct",
    });
    expect(
      resolveMarkdownFileLinkMeta("file:///private/etc/hosts", "/Users/julius/project"),
    ).toMatchObject({
      targetPath: "/private/etc/hosts",
      openPolicy: "confirm",
    });
  });

  it("uses exact path boundaries for workspace checks", () => {
    expect(isPathInsideWorkspace("/Users/julius/projected/file.ts", "/Users/julius/project")).toBe(
      false,
    );
    expect(
      isPathInsideWorkspace("/Users/julius/project/file.ts:4:2", "/Users/julius/project"),
    ).toBe(true);
  });

  it("treats configured additional directories as direct-open workspace paths", () => {
    expect(
      isPathInsideWorkspace("/Users/julius/docs/README.md", "/Users/julius/project", [
        "/Users/julius/docs",
      ]),
    ).toBe(true);
    expect(
      resolveMarkdownFileLinkMeta("file:///Users/julius/docs/README.md", "/Users/julius/project", [
        "/Users/julius/docs",
      ]),
    ).toMatchObject({
      openPolicy: "direct",
    });
  });
});
