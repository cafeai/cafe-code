// Native fixture exercises actual file identity, namespace and cleanup behavior.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtemp, rm } from "node:fs/promises";
// Native fixture exercises actual file identity, namespace and cleanup behavior.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { watch, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
// Native fixture paths retain host drive, separator and namespace semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GlideExecutionError, GlideRuntime } from "../src/glide/runtime.ts";
import { actionReceiptSchema } from "../src/glide/protocol.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/glide-native.fixture.ts", import.meta.url));
describe("isolated Glide kernel process", () => {
  let runtime: GlideRuntime, directory: string;
  let watchers: FSWatcher[];
  beforeEach(async () => {
    watchers = [];
    directory = await mkdtemp(join(tmpdir(), "cafe-glide-kernel-"));
    runtime = new GlideRuntime({
      helperPath: process.execPath,
      nativePrefixArgs: [fixturePath, join(directory, "received")],
      allowedApps: ["fixture.app"],
    });
  });
  afterEach(async () => {
    for (const watcher of watchers) watcher.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const text = (result: Awaited<ReturnType<GlideRuntime["execute"]>>) =>
    result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
  const receipts = (result: Awaited<ReturnType<GlideRuntime["execute"]>>) =>
    result.content.flatMap((item) =>
      item.type === "text" && item.text.startsWith("Glide action ")
        ? [actionReceiptSchema.parse(JSON.parse(item.text.slice("Glide action ".length)))]
        : [],
    );

  it("keeps actual prior effects and uncertain completion visible without replaying an open", async () => {
    await runtime.execute({ code: 'var app = await glide.getApp("Fixture");' });
    const result = await runtime.execute({
      code: 'await app.setValue(1,"prepared"); await app.performSecondaryAction(1,"AXOpen"); await app.typeText("duplicate");',
    });
    expect(result.isError).toBe(true);
    expect(receipts(result)).toMatchObject([
      { method: "set_value", status: "verified" },
      { method: "perform_secondary_action", status: "uncertain", osStatus: -25205 },
    ]);
    const state = JSON.parse(
      text(await runtime.execute({ code: "nodeRepl.write(await app.getAXState({emit:false}));" })),
    );
    expect(state.text).toBe("opened");
    expect(state.operations).toEqual([
      "get_app_state",
      "set_value",
      "perform_secondary_action",
      "get_app_state",
    ]);
    const history = await runtime.execute({
      code: "nodeRepl.write(glide.getActionReceipts({emit:false}).map(r=>r.status));",
    });
    expect(text(history)).toBe("[ 'verified', 'uncertain' ]");
  });
  it("stops on accepted no-ops and returns interruption stage/progress through a real worker", async () => {
    await runtime.execute({ code: 'var app = await glide.getApp("Fixture");' });
    const ignored = await runtime.execute({
      code: 'await app.setValue(1,"fixture-no-op"); await app.typeText("must not run");',
    });
    expect(ignored.isError).toBe(true);
    expect(receipts(ignored)).toMatchObject([
      {
        status: "not-observed",
        osAcceptance: "accepted",
        verification: { after: "initial", matched: false },
      },
    ]);
    const interrupted = await runtime.execute({
      code: 'await app.pressKey("interrupt"); await app.typeText("must not run");',
    });
    expect(interrupted.isError).toBe(true);
    expect(receipts(interrupted)).toMatchObject([
      {
        status: "uncertain",
        progress: { eventsPosted: 1 },
        interruption: { event: "scroll", source: "unattributed" },
      },
    ]);
    const observed = JSON.parse(
      text(await runtime.execute({ code: "nodeRepl.write(await app.getAXState({emit:false}));" })),
    );
    expect(observed.text).toBe("initialselected");
    expect(observed.operations).not.toContain("type_text");
  });
  it("retains completed receipts and the exact pending action when a kernel is cancelled", async () => {
    const received = new Promise<void>((resolve, reject) => {
      const watcher = watch(directory, (_event, name) => {
        if (name === "received") {
          watcher.close();
          resolve();
        }
      });
      watcher.once("error", reject);
      watchers.push(watcher);
    });
    const controller = new AbortController();
    const execution = runtime.execute(
      {
        code: 'var app = await glide.getApp("Fixture"); await app.setValue(1,"prepared"); await app.pressKey("hold");',
      },
      controller.signal,
    );
    const failure = execution.catch((error: unknown) => error);
    await received;
    controller.abort();
    const error = await failure;
    expect(error).toBeInstanceOf(GlideExecutionError);
    expect(error).toMatchObject({
      receipts: [
        { method: "set_value", status: "verified" },
        {
          method: "press_key",
          status: "uncertain",
          dispatch: "unknown",
          progress: { eventsPosted: null },
        },
      ],
    });
  });

  it.each([undefined, "background", "foreground"] as const)(
    "delivers the selected native connection mode to an actual child (%s)",
    async (inputMode) => {
      // Keep the omitted option genuinely omitted to exercise the runtime's
      // default, then inspect an independently parsed child-process receipt.
      if (inputMode !== undefined) {
        await runtime.close();
        runtime = new GlideRuntime({
          helperPath: process.execPath,
          nativePrefixArgs: [fixturePath, join(directory, "received")],
          allowedApps: ["fixture.app"],
          inputMode,
        });
      }
      const result = await runtime.execute({
        code: 'nodeRepl.write((await sky.get_app_state({app:"Fixture"})).text);',
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(text(result))).toEqual({
        text: "initial",
        operations: ["get_app_state"],
        inputMode: inputMode ?? "background",
      });
    },
  );

  it("refuses an unrecognized input mode before starting a connection", () => {
    expect(
      () =>
        new GlideRuntime({
          helperPath: process.execPath,
          nativePrefixArgs: [fixturePath, join(directory, "received")],
          allowedApps: ["fixture.app"],
          // Reproduce untyped configuration input at the public constructor.
          inputMode: "automatic" as "background",
        }),
    ).toThrow();
  });

  it("persists declarations, mutation, imports and redeclaration across actual ESM cells", async () => {
    expect(
      (
        await runtime.execute({
          code: "const count = 1; let {a, b: [c]} = {a: 2, b:[3]}; function add(x) { return x + count; } class Box {}",
        })
      ).isError,
    ).not.toBe(true);
    expect(
      text(await runtime.execute({ code: "nodeRepl.write([count, a, c, add(4), typeof Box]);" })),
    ).toBe("[ 1, 2, 3, 5, 'function' ]");
    expect((await runtime.execute({ code: "a += 5; const count = 9;" })).isError).not.toBe(true);
    expect(text(await runtime.execute({ code: "nodeRepl.write([count,a,add(4)]);" }))).toBe(
      "[ 9, 7, 5 ]",
    );
    expect(
      (
        await runtime.execute({
          code: 'const {glide: imported} = await import("@cafecode/glide");',
        })
      ).isError,
    ).not.toBe(true);
    expect(
      text(
        await runtime.execute({ code: "nodeRepl.write(await imported.listApps({emit:false}));" }),
      ),
    ).toContain("fixture.app");
  });
  it("uses Glide imports and legacy aliases against the same native state across cells", async () => {
    const canonical = await runtime.execute({
      code: 'import { glide as driver } from "@cafecode/glide"; var current = await driver.getApp("Fixture"); await current.setValue(1,"Glide");',
    });
    expect(canonical.isError).not.toBe(true);
    const legacy = await runtime.execute({
      code: 'const {cua: legacyDriver} = await import("@cafecode/computer"); var old = await legacyDriver.getApp("Fixture"); await old.typeText(" compatibility"); nodeRepl.write(await old.getAXState({emit:false}));',
    });
    expect(legacy.isError).not.toBe(true);
    expect(text(legacy)).toContain('"text":"Glide compatibility"');
    const oldSky = await runtime.execute({
      code: 'const {sky: oldSky} = await import("@oai/sky"); nodeRepl.write((await oldSky.get_app_state({app:"Fixture"})).text); nodeRepl.write(driver === glide && driver === cua && driver === legacyDriver);',
    });
    expect(oldSky.isError).not.toBe(true);
    expect(text(oldSky)).toContain('"text":"Glide compatibility"');
    expect(text(oldSky)).toContain("true");
  });
  it("preserves initialized partial bindings after failure and treats throw undefined as an error", async () => {
    await runtime.execute({ code: "let old = 1;" });
    expect(
      (
        await runtime.execute({
          code: 'old = 2; const committed = 3; throw new Error("fixture failure"); const uninitialized = 4;',
        })
      ).isError,
    ).toBe(true);
    expect(
      text(
        await runtime.execute({ code: "nodeRepl.write([old, committed, typeof uninitialized]);" }),
      ),
    ).toBe("[ 2, 3, 'undefined' ]");
    expect((await runtime.execute({ code: "throw undefined;" })).isError).toBe(true);
    expect((await runtime.execute({ code: "const old = old;" })).isError).toBe(true);
    expect(text(await runtime.execute({ code: "nodeRepl.write(old);" }))).toBe("2");
  });
  it("chains native calls in order, retains app handles, and allows caught failures", async () => {
    await runtime.execute({ code: 'var app = await glide.getApp("Fixture");' });
    const result = await runtime.execute({
      code: 'await app.setValue(1,"café"); await app.typeText(" 👩‍💻"); nodeRepl.write(await app.getAXState({emit:false}));',
    });
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain('"text":"café 👩‍💻"');
    expect(text(result)).toContain(
      '"operations":["get_app_state","set_value","type_text","get_app_state"]',
    );
    const caught = await runtime.execute({
      code: 'try { await sky.get_app_state({app:"Denied"}); } catch { nodeRepl.write("caught"); }',
    });
    expect(caught.isError).not.toBe(true);
    expect(text(caught)).toBe("caught");
  });
  it("has explicit output and rejects unsupported imports without losing bindings", async () => {
    expect((await runtime.execute({ code: "const retained = 7; 1 + 1;" })).content).toEqual([]);
    expect((await runtime.execute({ code: 'await import("node:fs");' })).isError).toBe(true);
    expect(text(await runtime.execute({ code: "nodeRepl.write(retained);" }))).toBe("7");
    expect(
      (
        await runtime.execute({
          code: 'await nodeRepl.emitImage("https://example.com/image.png");',
        })
      ).isError,
    ).toBe(true);
  });
  it("enforces image/output bounds and returns actual image content", async () => {
    const result = await runtime.execute({
      code: 'await nodeRepl.emitImage("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2WQAAAAASUVORK5CYII=");',
    });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.type).toBe("image");
    expect(
      (await runtime.execute({ code: 'nodeRepl.write("x".repeat(11 * 1024 * 1024));' })).isError,
    ).toBe(true);
  });
  it("times out a CPU loop, retires its process and starts a fresh kernel", async () => {
    await runtime.execute({ code: "const retained = 9;" });
    await expect(runtime.execute({ code: "while(true) {}", timeout_ms: 200 })).rejects.toThrow(
      "timed out",
    );
    expect(text(await runtime.execute({ code: "nodeRepl.write(typeof retained);" }))).toBe(
      "undefined",
    );
  });
  it("cancels only its owned active execution after the synthetic peer receives input", async () => {
    const received = new Promise<void>((resolve, reject) => {
      const watcher = watch(directory, (event, filename) => {
        if (event === "rename" && filename === "received") {
          watcher.close();
          resolve();
        }
      });
      watchers.push(watcher);
      watcher.once("error", reject);
    });
    const controller = new AbortController();
    const execution = runtime.execute(
      { code: 'await sky.press_key({app:"Fixture",key:"hold"});' },
      controller.signal,
    );
    const assertion = expect(execution).rejects.toThrow("cancelled");
    await received;
    controller.abort();
    await assertion;
    expect(text(await runtime.execute({ code: 'nodeRepl.write("fresh");' }))).toBe("fresh");
  });
  it("expires queued work without interrupting another owner or replaying it after reset", async () => {
    const received = new Promise<void>((resolve) => {
      const watcher = watch(directory, (_event, filename) => {
        if (filename === "received") {
          watcher.close();
          resolve();
        }
      });
      watchers.push(watcher);
    });
    const held = runtime.execute({ code: 'await sky.press_key({app:"Fixture",key:"hold"});' });
    const heldAssertion = expect(held).rejects.toThrow("reset");
    await received;
    await expect(
      runtime.execute({
        code: 'await sky.type_text({app:"Fixture",text:"must not run"});',
        timeout_ms: 10,
      }),
    ).rejects.toThrow("timed out");
    await runtime.reset();
    await heldAssertion;
    const state = text(
      await runtime.execute({
        code: 'nodeRepl.write((await sky.get_app_state({app:"Fixture"})).text);',
      }),
    );
    expect(state).toContain('"text":"initial"');
    expect(state).not.toContain("type_text");
  });
  it("does not replay effects after a native peer crash", async () => {
    await expect(
      runtime.execute({ code: 'await sky.press_key({app:"Fixture",key:"crash"});' }),
    ).rejects.toThrow("subprocess");
    expect(text(await runtime.execute({ code: 'nodeRepl.write("fresh");' }))).toBe("fresh");
  });
  it("refuses old deferred callbacks without denying app methods invoked by the current cell", async () => {
    await runtime.execute({
      code: 'var release; var deferred = new Promise(resolve => {release = resolve;}); deferred.then(() => {nodeRepl.write("stale output");}).catch(() => {}); deferred.then(() => sky.type_text({app:"Fixture",text:"stale input"})).catch(() => {});',
    });
    const result = await runtime.execute({
      code: 'release(); await Promise.resolve(); await Promise.resolve(); nodeRepl.write("current");',
    });
    expect(result.isError).not.toBe(true);
    expect(text(result)).toBe("current");
    const state = text(
      await runtime.execute({
        code: 'nodeRepl.write((await sky.get_app_state({app:"Fixture"})).text);',
      }),
    );
    expect(state).toContain('"text":"initial"');
    expect(state).not.toContain("type_text");
  });
});
