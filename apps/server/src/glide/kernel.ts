import * as vm from "node:vm";
import { AsyncLocalStorage } from "node:async_hooks";
import { createGlideApi, type GlideBridge } from "./api.ts";
import { prepareCellSource } from "./cellSource.ts";
import {
  GLIDE_IMAGE_BYTES,
  GLIDE_OUTPUT_BYTES,
  type CellResult,
  type GlideOutput,
} from "./protocol.ts";

function pngData(value: string | Uint8Array): string {
  if (typeof value === "string" && !/^data:image\/png;base64,[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new Error("emitImage requires PNG bytes or a PNG data URL.");
  const bytes =
    typeof value === "string"
      ? Buffer.from(value.slice("data:image/png;base64,".length), "base64")
      : Buffer.from(value);
  if (
    bytes.length < 24 ||
    bytes.length > GLIDE_IMAGE_BYTES ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("Invalid or oversized PNG image.");
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (!width || !height || width > 16384 || height > 16384 || width * height > 40_000_000)
    throw new Error("PNG image dimensions exceed the limit.");
  return bytes.toString("base64");
}

/** This VM supplies language semantics, not a security sandbox. Its owning
 * process is disposable and does not inherit provider credential variables. Glide authority is
 * separately limited by the broker and native helper's immutable allowlist. */
export function createGlideKernel(invoke: GlideBridge) {
  if (typeof vm.SourceTextModule !== "function")
    throw new Error("The Glide kernel requires --experimental-vm-modules.");
  const bindings = new Map<string, unknown>();
  const executions = new AsyncLocalStorage<object>();
  let currentExecution: object | undefined;
  let output: GlideOutput[] | undefined;
  let outputBytes = 0;
  const pending = new Set<Promise<unknown>>();
  const push = (item: GlideOutput) => {
    if (!output || executions.getStore() !== currentExecution)
      throw new Error("Glide output belongs to an expired execution.");
    outputBytes += Buffer.byteLength(item.type === "text" ? item.text : item.data);
    if (outputBytes > GLIDE_OUTPUT_BYTES || output.length >= 128)
      throw new Error("Glide output limit exceeded.");
    output.push(item);
  };
  const tracked: GlideBridge = (request) => {
    if (!output || executions.getStore() !== currentExecution)
      return Promise.reject(new Error("Glide request belongs to an expired execution."));
    if (pending.size >= 64) return Promise.reject(new Error("Too many pending Glide operations."));
    const result = invoke(request);
    pending.add(result);
    void result.then(
      () => pending.delete(result),
      () => {
        pending.delete(result);
      },
    );
    return result;
  };
  const api = createGlideApi({
    invoke: tracked,
    write: (text) => push({ type: "text", text }),
    emitImage: async (value) =>
      push({ type: "image", mimeType: "image/png", data: pngData(value) }),
  });
  const nodeRepl = Object.freeze({
    write: api.write,
    emitImage: async (value: string | Uint8Array) =>
      push({ type: "image", mimeType: "image/png", data: pngData(value) }),
  });
  const context = vm.createContext({
    glide: api.glide,
    cua: api.glide,
    sky: api.sky,
    nodeRepl,
    console: Object.freeze({ log: api.write, info: api.write, warn: api.write, error: api.write }),
  });
  const link = (specifier: string): vm.Module => {
    const values =
      specifier === "@cafecode/glide" || specifier === "@cafecode/computer"
        ? { glide: api.glide, cua: api.glide, sky: api.sky }
        : specifier === "@oai/sky"
          ? { sky: api.sky }
          : undefined;
    if (!values)
      throw new Error(
        "Only @cafecode/glide, @cafecode/computer and the @oai/sky compatibility alias may be imported.",
      );
    return new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      },
      { context },
    );
  };

  return {
    async execute(code: string): Promise<CellResult> {
      const execution = {};
      // Async continuations retain their originating cell. Calling a saved app
      // method/function from a new cell is valid; a deferred callback from a
      // completed cell cannot acquire the next cell's output or input authority.
      return executions.run(execution, async (): Promise<CellResult> => {
        if (output) throw new Error("A Glide cell is already running.");
        currentExecution = execution;
        output = [];
        outputBytes = 0;
        let module: vm.SourceTextModule | undefined;
        let names: string[] = [];
        let error: unknown;
        let failed = false;
        try {
          const prepared = prepareCellSource(code, [...bindings.keys()]);
          names = prepared.names;
          const previous = new vm.SyntheticModule(
            [...bindings.keys()],
            function () {
              for (const [name, value] of bindings) this.setExport(name, value);
            },
            { context },
          );
          module = new vm.SourceTextModule(prepared.code, {
            context,
            identifier: "cafe-glide-cell",
            importModuleDynamically: async (specifier) => {
              const imported = link(specifier);
              await imported.link(() => {
                throw new Error("Nested imports are unavailable.");
              });
              await imported.evaluate();
              return imported;
            },
          });
          await module.link((specifier) =>
            specifier === "cafe:previous" ? previous : link(specifier),
          );
          await module.evaluate();
        } catch (cause) {
          error = cause;
          failed = true;
        }
        // Drain even unawaited RPCs before another cell receives ownership. This
        // preserves output correlation and avoids leaking actions across cells.
        while (pending.size) await Promise.allSettled(pending);
        if (module && (module.status === "evaluated" || module.status === "errored")) {
          for (const name of names) {
            try {
              bindings.set(name, (module.namespace as Record<string, unknown>)[name]);
            } catch {
              /* A TDZ binding retains its previous committed value. */
            }
          }
        }
        const content = output;
        output = undefined;
        currentExecution = undefined;
        if (failed) {
          // An error can itself be thrown by model code. String conversion is
          // bounded, and neither code nor environment is copied into diagnostics.
          let message = "JavaScript cell failed.";
          try {
            message = String(error).slice(0, 2048);
          } catch {
            /* Fixed fallback. */
          }
          content.push({ type: "text", text: message });
          return { content, isError: true };
        }
        return { content };
      });
    },
  };
}
