import { isRetiredProviderDriverKind } from "@cafecode/contracts";
import { uiText } from "@cafecode/shared/i18n";
import { useNavigate } from "@tanstack/react-router";
import { SearchIcon, XIcon } from "lucide-react";
import {
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { useSettings } from "../../hooks/useSettings";
import { useUiLocale } from "../../i18n";
import { formatShortcutLabel } from "../../keybindings";
import { isMacPlatform, cn } from "../../lib/utils";
import { useServerProviders } from "../../rpc/serverState";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Kbd } from "../ui/kbd";
import { SidebarGroup, SidebarGroupLabel, useSidebar } from "../ui/sidebar";
import { getDriverOption } from "./providerDriverMeta";
import {
  searchSettings,
  type SettingsSearchGroup,
  type SettingsSearchRange,
  type SettingsSearchResult,
} from "./settingsSearchMatching";
import {
  settingsSearchProviderEntries,
  settingsSearchStaticEntries,
  type SettingsSearchAvailability,
} from "./settingsSearchIndex";
import { revealSettingsSearchTarget } from "./settingsSearchLanding";
import { useSettingsSearchFocusStore } from "./settingsSearchStore";
import type { SettingsSectionPath } from "./SettingsSidebarNav";

export const SETTINGS_SEARCH_INPUT_ATTRIBUTE = "data-settings-search-input";

/** ⌘F on Mac, Ctrl+F elsewhere; only handled while Settings is open. */
export const SETTINGS_SEARCH_SHORTCUT = {
  key: "f",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: true,
} as const;

export function isSettingsSearchShortcut(event: globalThis.KeyboardEvent): boolean {
  if (event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return false;
  return isMacPlatform(navigator.platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

export interface SettingsSearchNavItem {
  readonly label: string;
  readonly to: SettingsSectionPath;
  readonly icon: ComponentType<{ className?: string }>;
  readonly activePaths?: ReadonlyArray<string>;
}

function searchAvailability(): SettingsSearchAvailability {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const desktop = Boolean(bridge);
  return {
    keepAwake: typeof bridge?.setPowerSaveBlockerState === "function",
    desktop,
    macDesktop: desktop && isMacPlatform(navigator.platform),
  };
}

function useSettingsSearchEntries() {
  const serverProviders = useServerProviders();
  const providerInstances = useSettings((settings) => settings.providerInstances);
  return useMemo(() => {
    const accounts = serverProviders
      .filter((provider) => !isRetiredProviderDriverKind(provider.driver))
      .map((provider) => {
        const driverLabel = getDriverOption(provider.driver)?.label ?? String(provider.driver);
        const name =
          providerInstances?.[provider.instanceId]?.displayName?.trim() ||
          provider.displayName?.trim() ||
          driverLabel;
        return { instanceId: String(provider.instanceId), name, driverLabel };
      });
    return [
      ...settingsSearchStaticEntries(searchAvailability()),
      ...settingsSearchProviderEntries(accounts),
    ];
  }, [providerInstances, serverProviders]);
}

/**
 * Query, keyboard selection and result opening for the Settings sidebar.
 * The query survives navigation between Settings pages (the sidebar stays
 * mounted) so several matches can be opened in turn; it resets when the user
 * leaves Settings.
 */
export function useSettingsSearchController(input: {
  readonly navItems: readonly SettingsSearchNavItem[];
}) {
  const uiLocale = useUiLocale();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const entries = useSettingsSearchEntries();
  const [query, setQueryState] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const groups = useMemo(
    () => searchSettings({ entries, query, locale: uiLocale, navItems: input.navItems }),
    [entries, input.navItems, query, uiLocale],
  );
  const flatResults = useMemo(() => groups.flatMap((group) => group.results), [groups]);
  const active = query.trim().length > 0;
  const activeResult =
    flatResults.find((result) => result.entry.id === activeId) ?? flatResults[0] ?? null;

  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    setActiveId(null);
    if (next.trim().length > 0) {
      setHasSearched(true);
    } else {
      setCurrentId(null);
    }
  }, []);

  const openResult = useCallback(
    (result: SettingsSearchResult) => {
      setActiveId(result.entry.id);
      setCurrentId(result.entry.id);
      if (isMobile) setOpenMobile(false);
      void navigate({ to: result.entry.path, replace: true });
      void revealSettingsSearchTarget({
        id: result.entry.id,
        kind: result.entry.kind,
        root: document.body,
      });
    },
    [isMobile, navigate, setOpenMobile],
  );

  const moveActive = useCallback(
    (delta: number) => {
      if (flatResults.length === 0) return;
      const index = activeResult ? flatResults.indexOf(activeResult) : -1;
      const next = Math.min(flatResults.length - 1, Math.max(0, index + delta));
      setActiveId(flatResults[next]?.entry.id ?? null);
    },
    [activeResult, flatResults],
  );

  return {
    query,
    setQuery,
    active,
    groups,
    resultCount: flatResults.length,
    activeId: activeResult?.entry.id ?? null,
    currentId,
    hasSearched,
    setActiveId,
    moveActive,
    openResult,
    activeResult,
  };
}

export type SettingsSearchController = ReturnType<typeof useSettingsSearchController>;

function optionDomId(listboxId: string, entryId: string): string {
  return `${listboxId}-${entryId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export function SettingsSearchField({
  search,
  listboxId,
}: {
  readonly search: SettingsSearchController;
  readonly listboxId: string;
}) {
  const uiLocale = useUiLocale();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const shortcutLabel = formatShortcutLabel(SETTINGS_SEARCH_SHORTCUT);

  // Checks once on mount, so a request made before a mobile sheet opened is
  // kept, then follows later requests without re-rendering the field.
  useEffect(() => {
    const focusIfRequested = () => {
      const input = inputRef.current;
      if (!input || !useSettingsSearchFocusStore.getState().consume()) return;
      input.focus({ preventScroll: true });
      input.select();
    };
    focusIfRequested();
    return useSettingsSearchFocusStore.subscribe(focusIfRequested);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        search.moveActive(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        search.moveActive(-1);
        break;
      case "Enter":
        if (search.activeResult) {
          event.preventDefault();
          search.openResult(search.activeResult);
        }
        break;
      case "Escape":
        // Handled here so the Settings layout's Escape (leave Settings) only
        // runs once the field is empty and unfocused.
        event.preventDefault();
        if (search.query.length > 0) search.setQuery("");
        else event.currentTarget.blur();
        break;
    }
  };

  return (
    <div className="px-2 pt-0.5 pb-1">
      <InputGroup data-size="sm">
        <InputGroupAddon>
          <SearchIcon className="size-3.5 text-muted-foreground" aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          size="sm"
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={search.active}
          aria-controls={search.active ? listboxId : undefined}
          aria-activedescendant={
            search.active && search.activeId ? optionDomId(listboxId, search.activeId) : undefined
          }
          aria-label={uiText("Search settings", undefined, undefined, uiLocale)}
          placeholder={uiText("Search settings", undefined, undefined, uiLocale)}
          autoComplete="off"
          spellCheck={false}
          value={search.query}
          onChange={(event) => search.setQuery(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          data-settings-search-input=""
        />
        <InputGroupAddon align="inline-end">
          {search.query.length > 0 ? (
            <button
              type="button"
              className="inline-flex size-5 animate-enter-fade items-center justify-center rounded-sm text-muted-foreground outline-hidden transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={uiText("Clear search", undefined, undefined, uiLocale)}
              onClick={() => {
                search.setQuery("");
                inputRef.current?.focus({ preventScroll: true });
              }}
            >
              <XIcon className="size-3.5" />
            </button>
          ) : (
            <Kbd className="h-4 min-w-0 animate-enter-fade rounded-sm px-1.5 text-2xs">
              {shortcutLabel}
            </Kbd>
          )}
        </InputGroupAddon>
      </InputGroup>
      <span className="sr-only" aria-live="polite">
        {search.active
          ? search.resultCount === 0
            ? uiText(
                "No settings match “{query}”",
                { query: search.query.trim() },
                undefined,
                uiLocale,
              )
            : uiText(
                "{count, plural, one {# result} other {# results}}",
                { count: search.resultCount },
                undefined,
                uiLocale,
              )
          : null}
      </span>
    </div>
  );
}

function Highlighted({
  text,
  ranges,
  className,
}: {
  readonly text: string;
  readonly ranges: readonly SettingsSearchRange[];
  readonly className?: string;
}) {
  if (ranges.length === 0) return <span className={className}>{text}</span>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      parts.push(
        <span key={`t${cursor}`} className={className}>
          {text.slice(cursor, range.start)}
        </span>,
      );
    }
    parts.push(
      <span key={`m${range.start}`} className="font-semibold text-foreground">
        {text.slice(range.start, range.end)}
      </span>,
    );
    cursor = range.end;
  }
  if (cursor < text.length) {
    parts.push(
      <span key={`t${cursor}`} className={className}>
        {text.slice(cursor)}
      </span>,
    );
  }
  return <>{parts}</>;
}

function ResultOption({
  result,
  listboxId,
  selected,
  current,
  icon: Icon,
  search,
}: {
  readonly result: SettingsSearchResult;
  readonly listboxId: string;
  readonly selected: boolean;
  readonly current: boolean;
  readonly icon: ComponentType<{ className?: string }> | null;
  readonly search: SettingsSearchController;
}) {
  const emphasized = selected || current;
  const titleClassName = emphasized ? "text-foreground" : "text-muted-foreground";
  const hasDetail = result.section !== null || result.alternate !== null;
  return (
    <div
      id={optionDomId(listboxId, result.entry.id)}
      role="option"
      aria-selected={selected}
      aria-current={current ? "page" : undefined}
      data-settings-search-result={result.entry.id}
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-[background-color,color] duration-(--duration-fast)",
        emphasized ? "bg-sidebar-accent" : "hover:bg-sidebar-accent",
      )}
      // Keep focus (and the active descendant) in the search field.
      onMouseDown={(event) => event.preventDefault()}
      onPointerMove={() => {
        if (!selected) search.setActiveId(result.entry.id);
      }}
      onClick={() => search.openResult(result)}
    >
      {Icon ? (
        <Icon
          className={cn(
            "size-4 shrink-0",
            emphasized ? "text-foreground" : "text-subtle-foreground",
          )}
        />
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-(length:--text-ui)">
          <Highlighted text={result.title} ranges={result.titleRanges} className={titleClassName} />
        </span>
        {hasDetail ? (
          <span className="truncate text-2xs text-subtle-foreground">
            {result.section !== null ? (
              <Highlighted text={result.section} ranges={result.sectionRanges} />
            ) : null}
            {result.section !== null && result.alternate !== null ? " · " : null}
            {result.alternate !== null ? (
              <Highlighted text={result.alternate} ranges={result.alternateRanges} />
            ) : null}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function SettingsSearchResults({
  search,
  listboxId,
  navItems,
}: {
  readonly search: SettingsSearchController;
  readonly listboxId: string;
  readonly navItems: readonly SettingsSearchNavItem[];
}) {
  const uiLocale = useUiLocale();
  const labelIdPrefix = useId();
  const navItemByPath = useMemo(
    () => new Map(navItems.map((item) => [item.to, item] as const)),
    [navItems],
  );

  if (search.groups.length === 0) {
    return (
      <div className="animate-enter-rise px-4 pt-6 text-center" role="status">
        <p className="text-(length:--text-ui) text-muted-foreground">
          {uiText(
            "No settings match “{query}”",
            { query: search.query.trim() },
            undefined,
            uiLocale,
          )}
        </p>
      </div>
    );
  }

  return (
    <div
      id={listboxId}
      role="listbox"
      aria-label={uiText("Settings search results", undefined, undefined, uiLocale)}
      className="flex w-full min-w-0 animate-enter-rise flex-col gap-2"
    >
      {search.groups.map((group: SettingsSearchGroup) => {
        const navItem = navItemByPath.get(group.navPath);
        const labelId = `${labelIdPrefix}-${group.navPath}`;
        return (
          <SidebarGroup
            key={group.navPath}
            role="group"
            aria-labelledby={labelId}
            className="px-2 py-2 first:pt-3"
          >
            <SidebarGroupLabel
              id={labelId}
              className="label-overline h-6 px-2 text-2xs text-subtle-foreground"
            >
              {navItem?.label ?? null}
            </SidebarGroupLabel>
            <div className="flex w-full min-w-0 flex-col gap-1">
              {group.results.map((result) => (
                <ResultOption
                  key={result.entry.id}
                  result={result}
                  listboxId={listboxId}
                  selected={result.entry.id === search.activeId}
                  current={result.entry.id === search.currentId}
                  icon={result.entry.kind === "page" ? (navItem?.icon ?? null) : null}
                  search={search}
                />
              ))}
            </div>
          </SidebarGroup>
        );
      })}
    </div>
  );
}
