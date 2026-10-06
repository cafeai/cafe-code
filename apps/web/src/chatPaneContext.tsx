import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/** Presentation ownership only. A pane becoming inactive never stops its provider. */
export interface ChatPaneState {
  readonly active: boolean;
  readonly visible: boolean;
  readonly autoFocusComposer?: boolean;
  readonly sessionRailDocked?: boolean;
  readonly onSessionRailDockedChange?: (docked: boolean) => void;
}

const DEFAULT_PANE: ChatPaneState = { active: true, visible: true };
export const ChatPaneContext = createContext<ChatPaneState>(DEFAULT_PANE);
export function useChatPane() {
  return use(ChatPaneContext);
}

interface RuntimeOwner {
  readonly environment: string;
  readonly thread: string;
  readonly active: boolean;
}

/**
 * One registry belongs to the chat layout, not to a tab. Registering another
 * view is not authority to replay input: exact mounted-thread ownership wins,
 * with one deterministic fallback for queues whose tab is currently closed.
 */
export function createChatPaneRuntimeRegistry() {
  const resources = new Map<string, { value: unknown; dispose?: () => void }>();
  const owners = new Map<symbol, RuntimeOwner>();
  const listeners = new Set<() => void>();
  let revision = 0;
  const notify = () => {
    revision += 1;
    for (const listener of listeners) listener();
  };
  return {
    resource<T>(key: string, create: () => T, dispose?: (value: T) => void): T {
      const existing = resources.get(key);
      if (existing) return existing.value as T;
      const value = create();
      resources.set(key, { value, ...(dispose ? { dispose: () => dispose(value) } : {}) });
      return value;
    },
    readResource<T>(key: string): T | undefined {
      return resources.get(key)?.value as T | undefined;
    },
    register(owner: symbol, value: RuntimeOwner) {
      owners.set(owner, value);
      notify();
      return () => {
        owners.delete(owner);
        notify();
      };
    },
    owns(owner: symbol, environment: string, thread: string) {
      const candidates = [...owners].filter(([, entry]) => entry.environment === environment);
      const exact = candidates.find(([, entry]) => entry.thread === thread);
      const selected = exact ?? candidates.find(([, entry]) => entry.active) ?? candidates[0];
      return selected?.[0] === owner;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => revision,
    dispose() {
      for (const entry of resources.values()) entry.dispose?.();
      resources.clear();
    },
  };
}

const RuntimeContext = createContext<ReturnType<typeof createChatPaneRuntimeRegistry> | null>(null);
const mountedChatRuntimes = new Set<ReturnType<typeof createChatPaneRuntimeRegistry>>();

/** The sidebar lives outside the chat layout's context. It may observe an
 * existing send gate to avoid draft reuse, but never creates a runtime or owns
 * its mutable gate. Environment/thread identity stays exact on every read. */
export function isChatSendInFlight(environment: string, thread: string): boolean {
  for (const runtime of mountedChatRuntimes) {
    const gates = runtime.readResource<Map<string, { current: boolean }>>(
      `chat-runtime:${environment}:send-gates`,
    );
    if (gates?.get(thread)?.current) return true;
  }
  return false;
}

export function ChatPaneRuntimeProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(createChatPaneRuntimeRegistry);
  const disposal = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mountedChatRuntimes.add(registry);
    // React's development effect replay must not dispose still-mounted queues.
    if (disposal.current !== null) clearTimeout(disposal.current);
    return () => {
      disposal.current = setTimeout(() => {
        mountedChatRuntimes.delete(registry);
        registry.dispose();
      }, 0);
    };
  }, [registry]);
  return <RuntimeContext value={registry}>{children}</RuntimeContext>;
}

export function useHasSharedChatRuntime() {
  return use(RuntimeContext) !== null;
}

/** Stable mutable dispatch gates are shared without making every keystroke global. */
export function useChatPaneResource<T>(key: string, create: () => T): T {
  const registry = use(RuntimeContext);
  const local = useRef<{ key: string; value: T } | null>(null);
  if (registry) return registry.resource(key, create);
  if (local.current?.key !== key) local.current = { key, value: create() };
  return local.current.value;
}

export function createChatPaneSharedValue<T>(initial: T) {
  const ref = { current: initial };
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    ref,
    snapshot: () => snapshot,
    set(next: T | ((previous: T) => T)) {
      const value = typeof next === "function" ? (next as (previous: T) => T)(ref.current) : next;
      ref.current = value;
      if (Object.is(snapshot, value)) return;
      snapshot = value;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useChatPaneSharedState<T>(
  key: string,
  create: () => T,
  dispose?: (value: T) => void,
) {
  const registry = use(RuntimeContext);
  const local = useRef<{
    key: string;
    value: ReturnType<typeof createChatPaneSharedValue<T>>;
  } | null>(null);
  const createValue = () => createChatPaneSharedValue(create());
  const value = registry
    ? registry.resource(
        key,
        createValue,
        dispose ? (entry) => dispose(entry.ref.current) : undefined,
      )
    : (() => {
        if (local.current?.key !== key) local.current = { key, value: createValue() };
        return local.current.value;
      })();
  const snapshot = useSyncExternalStore(value.subscribe, value.snapshot, value.snapshot);
  return [snapshot, value.set, value.ref] as const;
}

const noSubscribe = () => () => undefined;
const zero = () => 0;

export function useChatPaneQueueOwnership(environment: string, thread: string) {
  const registry = use(RuntimeContext);
  const { active } = useChatPane();
  const [owner] = useState(() => Symbol("chat-pane"));
  const revision = useSyncExternalStore(
    registry?.subscribe ?? noSubscribe,
    registry?.snapshot ?? zero,
    registry?.snapshot ?? zero,
  );
  useLayoutEffect(
    () => registry?.register(owner, { environment, thread, active }),
    [registry, owner, environment, thread, active],
  );
  const owns = useCallback(
    (targetEnvironment: string, targetThread: string) =>
      registry?.owns(owner, targetEnvironment, targetThread) ?? true,
    [registry, owner],
  );
  return { owns, revision };
}
