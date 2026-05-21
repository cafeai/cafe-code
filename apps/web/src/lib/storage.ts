import { Debouncer } from "@tanstack/react-pacer";

export interface StateStorage<R = unknown> {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => R;
  removeItem: (name: string) => R;
}

export interface DebouncedStorage<R = unknown> extends StateStorage<R> {
  flush: () => void;
}

export function createMemoryStorage(): StateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
}

export function isStateStorage(
  storage: Partial<StateStorage> | null | undefined,
): storage is StateStorage {
  return (
    storage !== null &&
    storage !== undefined &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function"
  );
}

export function resolveStorage(storage: Partial<StateStorage> | null | undefined): StateStorage {
  return isStateStorage(storage) ? storage : createMemoryStorage();
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown }).then === "function";
}

export function createLegacyCompatibleStorage(
  baseStorage: Partial<StateStorage> | null | undefined,
  currentKey: string,
  legacyKeys: readonly string[],
): StateStorage {
  const resolvedStorage = resolveStorage(baseStorage);
  const readLegacyValue = (): string | null | Promise<string | null> => {
    for (const legacyKey of legacyKeys) {
      const legacyValue = resolvedStorage.getItem(legacyKey);
      if (isPromiseLike(legacyValue)) {
        return legacyValue.then((value) => {
          if (value !== null) {
            resolvedStorage.setItem(currentKey, value);
            return value;
          }
          return null;
        });
      }
      if (legacyValue !== null) {
        resolvedStorage.setItem(currentKey, legacyValue);
        return legacyValue;
      }
    }
    return null;
  };

  return {
    getItem: (name) => {
      const value = resolvedStorage.getItem(name);
      if (name !== currentKey) {
        return value;
      }
      if (isPromiseLike(value)) {
        return value.then((resolvedValue) => resolvedValue ?? readLegacyValue());
      }
      return value ?? readLegacyValue();
    },
    setItem: (name, value) => {
      const result = resolvedStorage.setItem(name, value);
      if (name === currentKey) {
        for (const legacyKey of legacyKeys) {
          resolvedStorage.removeItem(legacyKey);
        }
      }
      return result;
    },
    removeItem: (name) => {
      const result = resolvedStorage.removeItem(name);
      if (name === currentKey) {
        for (const legacyKey of legacyKeys) {
          resolvedStorage.removeItem(legacyKey);
        }
      }
      return result;
    },
  };
}

export function createDebouncedStorage(
  baseStorage: Partial<StateStorage> | null | undefined,
  debounceMs: number = 300,
): DebouncedStorage {
  const resolvedStorage = resolveStorage(baseStorage);
  const debouncedSetItem = new Debouncer(
    (name: string, value: string) => {
      resolvedStorage.setItem(name, value);
    },
    { wait: debounceMs },
  );

  return {
    getItem: (name) => resolvedStorage.getItem(name),
    setItem: (name, value) => {
      debouncedSetItem.maybeExecute(name, value);
    },
    removeItem: (name) => {
      debouncedSetItem.cancel();
      resolvedStorage.removeItem(name);
    },
    flush: () => {
      debouncedSetItem.flush();
    },
  };
}
