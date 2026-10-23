// Native Proxy detection must precede reflection: received test/extension
// objects must not execute traps while an observational copy is constructed.
import { types } from "node:util";

const OMITTED = "[Private image metadata omitted]";
const MAX_DEPTH = 32;
const MAX_ENTRIES = 50_000;

/**
 * Remove the new image-generation attachment identity and input-file metadata
 * from observations, never from the wire used for decoding or native control.
 *
 * Codex 0.164 flattens either `fileId` or the legacy `result` onto an image item
 * and adds inputImages (absolute input paths and byte digests). Neither field
 * is Cafe filesystem/download authority. Preserve the existing presentation,
 * including savedPath, while keeping these new private fields out of public
 * activity, retained history and logs. The projected value is deliberately
 * unknown: a file-only copy is no longer a valid upstream image-item schema.
 *
 * https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/ext/items/src/image_generation.rs#L22-L87
 */
export function redactCodexImageGenerationMetadata(value: unknown): unknown {
  let remaining = MAX_ENTRIES;
  const active = new WeakSet<object>();

  const visit = (current: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > MAX_DEPTH) return OMITTED;
    if (current === null || typeof current === "string" || typeof current === "boolean")
      return current;
    if (typeof current === "number") return Number.isFinite(current) ? current : OMITTED;
    if (current === undefined) return current;
    if (typeof current !== "object" || types.isProxy(current)) return OMITTED;
    if (active.has(current)) return OMITTED;

    active.add(current);
    try {
      const array = Array.isArray(current);
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null)
        return OMITTED;
      const keys = Reflect.ownKeys(current);
      if (keys.length > remaining || keys.some((key) => typeof key !== "string")) return OMITTED;

      if (array) {
        const length = Object.getOwnPropertyDescriptor(current, "length");
        if (
          !length ||
          !("value" in length) ||
          !Number.isSafeInteger(length.value) ||
          length.value < 0 ||
          length.value > remaining ||
          keys.length !== length.value + 1
        )
          return OMITTED;
        const copy: unknown[] = [];
        let changed = false;
        for (let index = 0; index < length.value; index += 1) {
          const entry = Object.getOwnPropertyDescriptor(current, String(index));
          if (!entry || !("value" in entry)) return OMITTED;
          const projected = visit(entry.value, depth + 1);
          copy.push(projected);
          changed ||= projected !== entry.value;
        }
        return changed ? copy : current;
      }

      const type = Object.getOwnPropertyDescriptor(current, "type");
      if (type && !("value" in type)) return OMITTED;
      const image = type?.value === "imageGeneration";
      const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      let changed = false;
      for (const key of keys) {
        if (typeof key !== "string") return OMITTED;
        if (image && (key === "fileId" || key === "inputImages")) {
          // Even an accessor in an omitted field stays unread. No attachment
          // lookup, path normalization or coercion belongs to this projection.
          changed = true;
          continue;
        }
        const entry = Object.getOwnPropertyDescriptor(current, key);
        if (!entry || !("value" in entry)) return OMITTED;
        const projected = visit(entry.value, depth + 1);
        Object.defineProperty(copy, key, {
          value: projected,
          enumerable: entry.enumerable === true,
          configurable: true,
          writable: true,
        });
        changed ||= projected !== entry.value;
      }
      return changed ? copy : current;
    } catch {
      // Received values and native reflection errors are opaque. Never render
      // their message, stack, toJSON or string conversion into a diagnostic.
      return OMITTED;
    } finally {
      active.delete(current);
    }
  };

  return visit(value, 0);
}
