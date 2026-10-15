import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { CheckIcon, CopyIcon } from "lucide-react";
import type { ServerProviderSkill } from "@cafecode/contracts";
import React, {
  Children,
  Suspense,
  createContext,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  isValidElement,
  use,
  useCallback,
  useContext,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Components, ExtraProps } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { stripScheduledFollowupResultForDisplay } from "@cafecode/shared/scheduledFollowupResult";
import { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { renderSkillInlineMarkdownChildren } from "./chat/SkillInlineText";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { anchoredToastManager, stackedThreadToast, toastManager } from "./ui/toast";
import { openInPreferredEditor } from "../editorPreferences";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { fnv1a32 } from "../lib/diffRendering";
import { LRUCache } from "../lib/lruCache";
import { copyTextToClipboard } from "../lib/copyToClipboard";
import { useTheme } from "../hooks/useTheme";
import {
  decodeMarkdownLinkDestination,
  extractMarkdownLinkDestinations,
  remarkNativeFileDestinations,
  resolveMarkdownFileLinkMeta,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
} from "../markdown-links";
import { readLocalApi } from "../localApi";
import { getLocalShellCapabilities } from "../localCapabilities";
import { useWorkspaceEnvironmentId } from "../environments/workspace";
import { cn, isMacPlatform, isWindowsPlatform } from "../lib/utils";
import { normalizeChatMarkdownMath } from "../lib/chatMarkdownMath";
import { getChatCodeHighlighter } from "../lib/chatCodeHighlighter";
import { normalizeAroundMermaidFences } from "../lib/chatMarkdownMermaid";
import { remarkChatMath } from "../lib/remarkChatMath";
import { remarkMermaid } from "../lib/remarkMermaid";
import { normalizeCodexCitationMarkers } from "../lib/codexCitations";
import { MermaidBlock } from "./MermaidBlock";
import { MarkdownTable } from "./MarkdownTableViewer";
import { MarkdownImage, type MarkdownImageContext } from "./chat/MarkdownImage";

class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

interface ChatMarkdownProps {
  imageContext?: MarkdownImageContext | undefined;
  text: string;
  cwd: string | undefined;
  additionalWorkspaceRoots?: ReadonlyArray<string>;
  isStreaming?: boolean;
  normalizeCodexCitations?: boolean;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
const EMPTY_ADDITIONAL_WORKSPACE_ROOTS: ReadonlyArray<string> = [];

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;
const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
const SHIKI_ALLOWED_TAGS = new Set(["pre", "code", "span"]);
const SHIKI_ALLOWED_ATTRIBUTES = new Set(["class", "style", "tabindex"]);
const UNSAFE_STYLE_VALUE_PATTERN = /(?:url\s*\(|expression\s*\(|@import)/i;
const UNSAFE_CLASS_VALUE_PATTERN = /[<>"'`=]/;

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  const raw = match?.[1] ?? "text";
  // Shiki doesn't bundle a gitignore grammar; ini is a close match (#685)
  return raw === "gitignore" ? "ini" : raw;
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(children: ReactNode): {
  className: string | undefined;
  code: string;
  mermaid: { source: string; complete: boolean } | undefined;
} | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];
  if (
    !isValidElement<{
      className?: string;
      children?: ReactNode;
      "data-mermaid-source"?: string;
      "data-mermaid-complete"?: string;
    }>(onlyChild) ||
    onlyChild.type !== "code"
  ) {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
    mermaid:
      typeof onlyChild.props["data-mermaid-source"] === "string"
        ? {
            source: onlyChild.props["data-mermaid-source"],
            complete: onlyChild.props["data-mermaid-complete"] === "true",
          }
        : undefined,
  };
}

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function escapeHtmlText(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isSafeShikiAttribute(name: string, value: string): boolean {
  const normalizedName = name.toLowerCase();
  if (!SHIKI_ALLOWED_ATTRIBUTES.has(normalizedName)) {
    return false;
  }

  switch (normalizedName) {
    case "class":
      return !UNSAFE_CLASS_VALUE_PATTERN.test(value);
    case "style":
      return !UNSAFE_STYLE_VALUE_PATTERN.test(value);
    case "tabindex":
      return /^-?\d+$/.test(value);
    default:
      return false;
  }
}

export function sanitizeHighlightedCodeHtml(html: string): string {
  if (typeof document === "undefined") {
    return escapeHtmlText(html);
  }

  const template = document.createElement("template");
  template.innerHTML = html;

  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    const tagName = element.tagName.toLowerCase();
    if (!SHIKI_ALLOWED_TAGS.has(tagName)) {
      element.replaceWith(document.createTextNode(element.textContent ?? ""));
      continue;
    }

    for (const attribute of Array.from(element.attributes)) {
      if (!isSafeShikiAttribute(attribute.name, attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  return template.innerHTML;
}

function MarkdownCodeBlock({ code, children }: { code: string; children: ReactNode }) {
  const uiLocale = useUiLocale();

  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = useCallback(() => {
    void copyTextToClipboard(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => undefined);
  }, [code]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div className="chat-markdown-codeblock leading-snug">
      <button
        type="button"
        className="chat-markdown-copy-button"
        onClick={handleCopy}
        title={
          copied
            ? uiText("Copied", undefined, undefined, uiLocale)
            : uiText("Copy code", undefined, undefined, uiLocale)
        }
        aria-label={
          copied
            ? uiText("Copied", undefined, undefined, uiLocale)
            : uiText("Copy code", undefined, undefined, uiLocale)
        }
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
      {children}
    </div>
  );
}

interface SuspenseShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
}

function SuspenseShikiCodeBlock({
  className,
  code,
  themeName,
  isStreaming,
}: SuspenseShikiCodeBlockProps) {
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  const cachedHighlightedHtml = !isStreaming ? highlightedCodeCache.get(cacheKey) : null;

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: sanitizeHighlightedCodeHtml(cachedHighlightedHtml) }}
      />
    );
  }

  return (
    <UncachedShikiCodeBlock
      code={code}
      language={language}
      themeName={themeName}
      cacheKey={cacheKey}
      isStreaming={isStreaming}
    />
  );
}

interface UncachedShikiCodeBlockProps {
  code: string;
  language: string;
  themeName: DiffThemeName;
  cacheKey: string;
  isStreaming: boolean;
}

interface MarkdownRenderingContextValue {
  diffThemeName: DiffThemeName;
  resolvedTheme: "dark" | "light";
  isStreaming: boolean;
  skills: NonNullable<ChatMarkdownProps["skills"]>;
  imageContext: MarkdownImageContext | undefined;
  cwd: string | undefined;
  additionalWorkspaceRoots: ReadonlyArray<string>;
  fileLinkParentSuffixByPath: ReadonlyMap<string, string>;
}

const MarkdownRenderingContext = createContext<MarkdownRenderingContextValue | null>(null);

function MarkdownParagraph({ node: _node, children, ...props }: ComponentProps<"p"> & ExtraProps) {
  const rendering = useContext(MarkdownRenderingContext);
  // Image state belongs to the mounted Markdown node. Keep both the image
  // and its ancestors stable across appended prose, theme and metadata updates
  // so loaded bytes and reserved geometry do not reset to a small placeholder.
  return (
    <p {...props}>
      {renderSkillInlineMarkdownChildren(children, rendering?.skills ?? EMPTY_MARKDOWN_SKILLS)}
    </p>
  );
}

function MarkdownImageElement({
  node: _node,
  src,
  alt,
  ...props
}: ComponentProps<"img"> & ExtraProps) {
  const rendering = useContext(MarkdownRenderingContext);
  const source = typeof src === "string" ? src : "";
  return rendering?.imageContext && (source.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(source)) ? (
    <MarkdownImage source={source} alt={alt ?? ""} context={rendering.imageContext} />
  ) : (
    <img {...props} src={src} alt={alt ?? ""} loading="lazy" />
  );
}

function MarkdownAnchor({ node: _node, href, ...props }: ComponentProps<"a"> & ExtraProps) {
  const rendering = useContext(MarkdownRenderingContext);
  const fileLinkMeta =
    href && rendering
      ? resolveMarkdownFileLinkMeta(href, rendering.cwd, rendering.additionalWorkspaceRoots)
      : null;
  if (!fileLinkMeta || !rendering) {
    if (!href) {
      return <span className={props.className}>{props.children}</span>;
    }
    if (href.startsWith("#")) {
      return <a {...props} href={href} />;
    }
    return <a {...props} href={href} target="_blank" rel="noopener noreferrer" />;
  }

  const parentSuffix = rendering.fileLinkParentSuffixByPath.get(fileLinkMeta.filePath);
  const labelParts = [fileLinkMeta.basename];
  if (typeof parentSuffix === "string" && parentSuffix.length > 0) {
    labelParts.push(parentSuffix);
  }
  if (fileLinkMeta.line) {
    labelParts.push(
      `L${fileLinkMeta.line}${fileLinkMeta.column ? `:C${fileLinkMeta.column}` : ""}`,
    );
  }

  return (
    <MarkdownFileLink
      href={fileLinkMeta.targetPath}
      targetPath={fileLinkMeta.targetPath}
      displayPath={fileLinkMeta.displayPath}
      filePath={fileLinkMeta.filePath}
      label={labelParts.join(" · ")}
      openPolicy={fileLinkMeta.openPolicy}
      theme={rendering.resolvedTheme}
      className={props.className}
    />
  );
}

function MarkdownPre({ node: _node, children, ...props }: ComponentProps<"pre"> & ExtraProps) {
  const rendering = useContext(MarkdownRenderingContext);
  const codeBlock = extractCodeBlock(children);
  if (!rendering || !codeBlock) {
    return <pre {...props}>{children}</pre>;
  }

  if (codeBlock.mermaid) {
    // Completion belongs to this fence, independent of whether later prose
    // streams or a truncated transcript is terminal. Keep this renderer's
    // component type stable so appended prose cannot reset diagram controls,
    // close an expanded view, or churn a cached diagram's object URL.
    return (
      <MermaidBlock
        code={codeBlock.mermaid.source}
        complete={codeBlock.mermaid.complete}
        theme={rendering.resolvedTheme}
      />
    );
  }

  return (
    <MarkdownCodeBlock code={codeBlock.code}>
      <CodeHighlightErrorBoundary fallback={<pre {...props}>{children}</pre>}>
        <Suspense fallback={<pre {...props}>{children}</pre>}>
          <SuspenseShikiCodeBlock
            className={codeBlock.className}
            code={codeBlock.code}
            themeName={rendering.diffThemeName}
            isStreaming={rendering.isStreaming}
          />
        </Suspense>
      </CodeHighlightErrorBoundary>
    </MarkdownCodeBlock>
  );
}

function MarkdownListItem({ node: _node, children, ...props }: ComponentProps<"li"> & ExtraProps) {
  const rendering = useContext(MarkdownRenderingContext);
  // A stable pre component is insufficient when a surrounding list item is
  // recreated. Preserve the ancestor identity for diagrams nested in lists,
  // while retaining the same inline-skill handling as ordinary list prose.
  return (
    <li {...props}>
      {renderSkillInlineMarkdownChildren(children, rendering?.skills ?? EMPTY_MARKDOWN_SKILLS)}
    </li>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  p: MarkdownParagraph,
  li: MarkdownListItem,
  img: MarkdownImageElement,
  a: MarkdownAnchor,
  pre: MarkdownPre,
  table: MarkdownTable,
};

function UncachedShikiCodeBlock({
  code,
  language,
  themeName,
  cacheKey,
  isStreaming,
}: UncachedShikiCodeBlockProps) {
  const highlighter = use(getChatCodeHighlighter(language));
  const highlightedHtml = useMemo(() => {
    try {
      return highlighter.codeToHtml(code, { lang: language, theme: themeName });
    } catch (error) {
      // Log highlighting failures for debugging while falling back to plain text
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );
      // If highlighting fails for this language, render as plain text
      return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  }, [code, highlighter, language, themeName]);
  const safeHighlightedHtml = useMemo(
    () => sanitizeHighlightedCodeHtml(highlightedHtml),
    [highlightedHtml],
  );

  useEffect(() => {
    if (!isStreaming) {
      highlightedCodeCache.set(
        cacheKey,
        safeHighlightedHtml,
        estimateHighlightedSize(safeHighlightedHtml, code),
      );
    }
  }, [cacheKey, code, safeHighlightedHtml, isStreaming]);

  return (
    <div
      className="chat-markdown-shiki"
      dangerouslySetInnerHTML={{ __html: safeHighlightedHtml }}
    />
  );
}

interface MarkdownFileLinkProps {
  href: string;
  targetPath: string;
  displayPath: string;
  filePath: string;
  label: string;
  openPolicy: "direct" | "confirm";
  theme: "light" | "dark";
  className?: string | undefined;
}

const MARKDOWN_FILE_LINK_CLASS_NAME =
  "chat-markdown-file-link relative top-[2px] max-w-full no-underline";
const MARKDOWN_FILE_LINK_ICON_CLASS_NAME = "chat-markdown-file-link-icon size-3.5 shrink-0";
const MARKDOWN_FILE_LINK_LABEL_CLASS_NAME = "chat-markdown-file-link-label truncate";

function getFileManagerName(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): string {
  // File-manager brands are opaque platform metadata, not case-folded UI copy.
  if (isMacPlatform(platform)) {
    return "Finder";
  }
  if (isWindowsPlatform(platform)) {
    return "Explorer";
  }
  return "Files";
}

function getFileManagerRevealLabel(): string {
  return uiText("Open in {fileManager}", { fileManager: getFileManagerName() });
}

function pathParentSegments(path: string): string[] {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments.slice(0, -1);
}

function buildFileLinkParentSuffixByPath(filePaths: ReadonlyArray<string>): Map<string, string> {
  const groups = new Map<string, Set<string>>();
  for (const filePath of filePaths) {
    const pathSegments = filePath
      .replaceAll("\\", "/")
      .split("/")
      .filter((segment) => segment.length > 0);
    const basename = pathSegments[pathSegments.length - 1];
    if (!basename) continue;
    const group = groups.get(basename) ?? new Set<string>();
    group.add(filePath);
    groups.set(basename, group);
  }

  const suffixByPath = new Map<string, string>();
  for (const group of groups.values()) {
    const uniquePaths = [...group];
    if (uniquePaths.length < 2) continue;

    const parentSegmentsByPath = new Map(
      uniquePaths.map((filePath) => [filePath, pathParentSegments(filePath)]),
    );
    const minUniqueDepthByPath = new Map<string, number>();

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      let resolvedDepth = segments.length;
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const candidate = segments.slice(-depth).join("/");
        const collision = uniquePaths.some((otherPath) => {
          if (otherPath === filePath) return false;
          const otherSegments = parentSegmentsByPath.get(otherPath) ?? [];
          return otherSegments.slice(-depth).join("/") === candidate;
        });
        if (!collision) {
          resolvedDepth = depth;
          break;
        }
      }
      minUniqueDepthByPath.set(filePath, resolvedDepth);
    }

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      if (segments.length === 0) continue;
      const minUniqueDepth = minUniqueDepthByPath.get(filePath) ?? 1;
      const suffixDepth = Math.min(segments.length, Math.max(minUniqueDepth, 2));
      suffixByPath.set(filePath, segments.slice(-suffixDepth).join("/"));
    }
  }

  return suffixByPath;
}

const MarkdownFileLink = memo(function MarkdownFileLink({
  href,
  targetPath,
  displayPath,
  filePath,
  label,
  openPolicy,
  theme,
  className,
}: MarkdownFileLinkProps) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const environmentId = useWorkspaceEnvironmentId();
  const localShellCapabilities = getLocalShellCapabilities(environmentId);
  const canOpenLocalEditor = localShellCapabilities.canOpenLocalEditor;
  const canRevealLocalPath = localShellCapabilities.canOpenLocalPath;
  const linkRef = useRef<HTMLAnchorElement | null>(null);
  const handleCopy = useCallback(
    (value: string, kind: "full" | "relative") => {
      void copyTextToClipboard(value).then(
        () => {
          // A copy confirmation is inline (style guide §10): a brief
          // tooltip-style note anchored to the link, not a stacked toast.
          const anchor = linkRef.current;
          if (!anchor?.isConnected) return;
          anchoredToastManager.add({
            data: { tooltipStyle: true },
            positionerProps: { anchor },
            timeout: 1200,
            title:
              kind === "full"
                ? uiText("Full path copied", undefined, undefined, uiLocale)
                : uiText("Relative path copied", undefined, undefined, uiLocale),
          });
        },
        (error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title:
                kind === "full"
                  ? uiText("Failed to copy full path", undefined, undefined, uiLocale)
                  : uiText("Failed to copy relative path", undefined, undefined, uiLocale),
              description:
                error instanceof Error
                  ? error.message
                  : uiText("An error occurred.", undefined, undefined, uiLocale),
            }),
          );
        },
      );
    },
    [uiLocale],
  );

  const handleOpen = useCallback(() => {
    if (!canOpenLocalEditor) {
      handleCopy(targetPath, "full");
      return;
    }

    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: uiText("Open file is unavailable", undefined, undefined, uiLocale),
      });
      return;
    }

    void (async () => {
      if (openPolicy === "confirm") {
        const confirmed = await api.dialogs.confirm(
          uiText(
            "This file is outside the current workspace:\n\n{value0}\n\nOpen it anyway?",
            {
              value0: targetPath,
            },
            undefined,
            uiLocale,
          ),
        );
        if (!confirmed) {
          return;
        }
      }

      await openInPreferredEditor(api, targetPath);
    })().catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: uiText("Unable to open file", undefined, undefined, uiLocale),
          description:
            error instanceof Error
              ? error.message
              : uiText("An error occurred.", undefined, undefined, uiLocale),
        }),
      );
    });
  }, [canOpenLocalEditor, handleCopy, openPolicy, targetPath, uiLocale]);

  const handleReveal = useCallback(() => {
    if (!canRevealLocalPath) {
      handleCopy(filePath, "full");
      return;
    }

    const api = readLocalApi();
    const fileManager = getFileManagerName();
    if (!api) {
      toastManager.add({
        type: "error",
        title: uiText("Open in {fileManager} is unavailable", { fileManager }, undefined, uiLocale),
      });
      return;
    }

    void (async () => {
      if (openPolicy === "confirm") {
        const confirmed = await api.dialogs.confirm(
          uiText(
            "This file is outside the current workspace:\n\n{value0}\n\nReveal it anyway?",
            {
              value0: targetPath,
            },
            undefined,
            uiLocale,
          ),
        );
        if (!confirmed) {
          return;
        }
      }

      await api.shell.revealPath(filePath);
    })().catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: uiText("Unable to open in {fileManager}", { fileManager }, undefined, uiLocale),
          description:
            error instanceof Error
              ? error.message
              : uiText("An error occurred.", undefined, undefined, uiLocale),
        }),
      );
    });
  }, [canRevealLocalPath, filePath, handleCopy, openPolicy, targetPath, uiLocale]);

  const handleContextMenu = useCallback(
    async (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readLocalApi();
      if (!api) return;

      const clicked = await api.contextMenu.show(
        [
          ...(canOpenLocalEditor
            ? ([
                { id: "open", label: uiText("Open file", undefined, undefined, uiLocale) },
              ] as const)
            : []),
          ...(canRevealLocalPath
            ? ([{ id: "reveal", label: uiPresentation.getFileManagerRevealLabel() }] as const)
            : []),
          {
            id: "copy-relative",
            label: uiText("Copy relative path", undefined, undefined, uiLocale),
          },
          { id: "copy-full", label: uiText("Copy full path", undefined, undefined, uiLocale) },
        ] as const,
        { x: event.clientX, y: event.clientY },
      );

      if (clicked === "open") {
        handleOpen();
        return;
      }
      if (clicked === "reveal") {
        handleReveal();
        return;
      }
      if (clicked === "copy-relative") {
        handleCopy(displayPath, "relative");
        return;
      }
      if (clicked === "copy-full") {
        handleCopy(targetPath, "full");
      }
    },
    [
      canOpenLocalEditor,
      canRevealLocalPath,
      displayPath,
      handleCopy,
      handleOpen,
      handleReveal,
      targetPath,
      uiLocale,
      uiPresentation,
    ],
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            ref={linkRef}
            href={href}
            className={cn(MARKDOWN_FILE_LINK_CLASS_NAME, className)}
            data-open-policy={openPolicy}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              handleOpen();
            }}
            onContextMenu={handleContextMenu}
          >
            <VscodeEntryIcon
              pathValue={filePath}
              kind="file"
              theme={theme}
              className={cn(MARKDOWN_FILE_LINK_ICON_CLASS_NAME, "text-current")}
            />
            <span className={MARKDOWN_FILE_LINK_LABEL_CLASS_NAME}>{label}</span>
          </a>
        }
      />
      <TooltipPopup
        side="top"
        className="max-w-[min(40rem,calc(100vw-2rem))] font-mono text-2xs leading-tight"
      >
        <div className="markdown-file-link-tooltip-scroll overflow-x-auto whitespace-nowrap">
          {displayPath}
          {openPolicy === "confirm"
            ? uiText(" (outside workspace)", undefined, undefined, uiLocale)
            : ""}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}, areMarkdownFileLinkPropsEqual);

function areMarkdownFileLinkPropsEqual(
  previous: Readonly<MarkdownFileLinkProps>,
  next: Readonly<MarkdownFileLinkProps>,
): boolean {
  return (
    previous.href === next.href &&
    previous.targetPath === next.targetPath &&
    previous.displayPath === next.displayPath &&
    previous.filePath === next.filePath &&
    previous.label === next.label &&
    previous.openPolicy === next.openPolicy &&
    previous.theme === next.theme &&
    previous.className === next.className
  );
}

function ChatMarkdown({
  imageContext,
  text,
  cwd,
  additionalWorkspaceRoots = EMPTY_ADDITIONAL_WORKSPACE_ROOTS,
  isStreaming = false,
  normalizeCodexCitations = false,
  skills = EMPTY_MARKDOWN_SKILLS,
}: ChatMarkdownProps) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const normalizedText = useMemo(() => {
    // The optional final result footer is scheduler metadata, not transcript
    // prose. Strip only a fully validated marker from this derived rendering;
    // canonical message bytes remain available for exact-run reconciliation.
    return normalizeAroundMermaidFences(stripScheduledFollowupResultForDisplay(text), (source) => {
      const citationNormalizedText = normalizeCodexCitations
        ? normalizeCodexCitationMarkers(source, { mode: "display" })
        : source;
      return normalizeChatMarkdownMath(citationNormalizedText);
    });
  }, [normalizeCodexCitations, text]);
  const markdownFileLinkMetaByHref = useMemo(() => {
    const metaByHref = new Map<
      string,
      NonNullable<ReturnType<typeof resolveMarkdownFileLinkMeta>>
    >();
    for (const { value } of extractMarkdownLinkDestinations(normalizedText)) {
      const normalizedHref = decodeMarkdownLinkDestination(value, cwd);
      if (metaByHref.has(normalizedHref)) continue;
      const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd, additionalWorkspaceRoots);
      if (meta) {
        metaByHref.set(normalizedHref, meta);
      }
    }
    return metaByHref;
  }, [additionalWorkspaceRoots, cwd, normalizedText]);
  const fileLinkParentSuffixByPath = useMemo(() => {
    const filePaths = [...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath);
    return buildFileLinkParentSuffixByPath(filePaths);
  }, [markdownFileLinkMetaByHref]);
  const renderingContext = useMemo(
    () => ({
      diffThemeName,
      resolvedTheme,
      isStreaming,
      skills,
      imageContext,
      cwd,
      additionalWorkspaceRoots,
      fileLinkParentSuffixByPath,
    }),
    [
      diffThemeName,
      resolvedTheme,
      isStreaming,
      skills,
      imageContext,
      cwd,
      additionalWorkspaceRoots,
      fileLinkParentSuffixByPath,
    ],
  );
  const markdownUrlTransform = useCallback(
    (href: string, key: string) => {
      // Image paths are transported by the authenticated chat-image service;
      // they must never become direct browser filesystem requests.
      if (key === "src" && imageContext && (href.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(href)))
        return href;
      // Native paths deliberately pass through the same recognition policy
      // before becoming actionable. Restoration occurs in the parsed AST;
      // a rejected/sanitized href can never be recovered from raw source here.
      return (
        rewriteMarkdownFileUriHref(href) ??
        (resolveMarkdownFileLinkTarget(href, cwd) ? href : defaultUrlTransform(href))
      );
    },
    [cwd, imageContext],
  );

  return (
    <div className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-chat-foreground">
      <MarkdownRenderingContext.Provider value={renderingContext}>
        <ReactMarkdown
          remarkPlugins={[
            remarkGfm,
            remarkChatMath,
            remarkMermaid,
            [remarkNativeFileDestinations, { cwd }],
          ]}
          rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false, trust: false }]]}
          components={MARKDOWN_COMPONENTS}
          urlTransform={markdownUrlTransform}
        >
          {normalizedText}
        </ReactMarkdown>
      </MarkdownRenderingContext.Provider>
    </div>
  );
}

export default memo(ChatMarkdown);

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { getFileManagerRevealLabel };
