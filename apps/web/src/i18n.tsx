import { Fragment, useSyncExternalStore, type ReactNode } from "react";
import {
  UI_DIRECTION,
  getUiLocale,
  subscribeUiLocale,
  uiMessageParts,
  uiText,
  type UiLocale,
} from "@cafecode/shared/i18n";

/** The snapshot is a finite presentation enum, not chat/session state. Every
 * translated render subscribes independently, including React.memo children. */
export function useUiLocale() {
  return useSyncExternalStore(subscribeUiLocale, getUiLocale, getUiLocale);
}

/** Snapshot code-owned finite option tables and display helpers per locale.
 * Legacy static tables use lazy translation getters rather than freezing the
 * startup language. Stable locale-specific helper identities also invalidate
 * React Compiler's derived-copy caches without remounting components/drafts.
 * Never pass received/provider/user objects here: this is trusted source-owned
 * metadata only; arbitrary data remains untouched at its existing boundary. */
const presentationSnapshots = new WeakMap<object, Map<UiLocale, unknown>>();

function snapshotPresentation<T>(value: T, locale: UiLocale): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  // The locale must be a real argument/key, not merely a manual useMemo
  // dependency: the React Compiler can otherwise cache the getter snapshot
  // against its unchanged source object. Each trusted object has at most three
  // immutable snapshots and weak ownership; no received values enter here.
  let snapshots = presentationSnapshots.get(value);
  if (snapshots?.has(locale)) return snapshots.get(locale) as T;
  snapshots ??= new Map();
  let result: T;
  if (typeof value === "function") {
    const original = value as (...args: unknown[]) => unknown;
    result = ((...args: unknown[]) => original(...args)) as T;
  } else if (Array.isArray(value)) {
    result = value.map((entry) => snapshotPresentation(entry, locale)) as T;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    result = Object.fromEntries(
      Object.keys(value).map((key) => [key, snapshotPresentation(Reflect.get(value, key), locale)]),
    ) as T;
  }
  snapshots.set(locale, result);
  presentationSnapshots.set(value, snapshots);
  return result;
}

export function useUiPresentation<T>(sourceOwnedValues: T): T {
  const locale = useUiLocale();
  return snapshotPresentation(sourceOwnedValues, locale);
}

/** A catalog can reorder trusted slots, never create HTML or action authority.
 * Chat prose, paths, terminal output and received provider fields bypass this
 * boundary completely. React continues to escape all interpolated strings. */
export function UiMessage({
  message,
  values,
  slots,
  context,
}: {
  message: string;
  values?: Readonly<
    Record<
      string,
      | string
      | number
      | boolean
      | Date
      | null
      | undefined
      | ((parts: (string | ReactNode)[]) => ReactNode)
    >
  >;
  context?: string;
  slots?: Readonly<Record<string, ReactNode>>;
}) {
  const locale = useUiLocale();
  // Capture the node at this render. Deferring its expression into a callback
  // would lose TypeScript's admission narrowing and could observe later mutable
  // state under the wrong message. Catalog callbacks only return captured nodes.
  const argumentsByName: Record<string, NonNullable<typeof values>[string]> = Object.create(null);
  // Match the formatter's own-data-only admission. Reading Object.entries or
  // spreading arbitrary props would invoke accessors before that admission.
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(values ?? {}))) {
    if ("value" in descriptor) argumentsByName[name] = descriptor.value;
  }
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(slots ?? {}))) {
    if ("value" in descriptor) {
      const node = descriptor.value as ReactNode;
      argumentsByName[name] = () => node;
    }
  }
  const parts = uiMessageParts<ReactNode>(message, argumentsByName, context, locale);
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>{part}</Fragment>
      ))}
    </>
  );
}

/** Metadata follows the already-resolved reviewed locale before first mount
 * and whenever the presentation setting changes, never received prose. */
export function initializeUiLocale(document: Document): void {
  document.documentElement.lang = getUiLocale();
  document.documentElement.dir = UI_DIRECTION;
  // Only the exact source-owned inert startup target is amended before React
  // mounts. This is not a generic DOM-text replacement/translation observer.
  const boot = document.querySelector("body > #root > #boot-shell > #boot-shell-card");
  boot?.setAttribute(
    "aria-label",
    uiText("Cafe Code splash screen", undefined, undefined, getUiLocale()),
  );
  const manifest = document.querySelector('link[rel="manifest"]');
  if (
    ["/manifest.webmanifest", "/manifest.ja.webmanifest", "/manifest.ko.webmanifest"].includes(
      manifest?.getAttribute("href") ?? "",
    )
  ) {
    const locale = getUiLocale();
    manifest?.setAttribute(
      "href",
      locale === "en" ? "/manifest.webmanifest" : `/manifest.${locale}.webmanifest`,
    );
  }
}
