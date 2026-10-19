/**
 * Web links that the assistant message context menu can copy.
 *
 * The message menu replaces the native one (which offered Copy Link), so it
 * must offer the link itself when the right-click lands on one. Only http(s)
 * links qualify, matching the desktop shell's safe external URL policy; file
 * links render through MarkdownFileLink, whose own menu (open/reveal/copy
 * path) stops propagation before this runs, and in-page `#` anchors are not
 * worth copying. Copying is the only action: opening stays a normal click.
 */
const COPYABLE_LINK_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

export interface CopyableMessageLink {
  /** Resolved absolute URL, as the browser's own "Copy link" would copy it. */
  readonly url: string;
  readonly anchor: HTMLAnchorElement;
}

export function findCopyableMessageLink(
  target: EventTarget | null,
  container: Element,
): CopyableMessageLink | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement) || !container.contains(anchor)) return null;
  let url: URL;
  try {
    url = new URL(anchor.href);
  } catch {
    return null;
  }
  return COPYABLE_LINK_PROTOCOLS.has(url.protocol) ? { url: url.href, anchor } : null;
}
