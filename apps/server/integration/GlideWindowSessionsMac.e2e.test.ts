import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { readGlideFrames, writeGlideFrame } from "../src/glide/framing.ts";
import { actionReceiptSchema, observationSchema, windowListSchema } from "../src/glide/protocol.ts";
import { glideChildEnvironment } from "../src/glide/runtime.ts";

function refusalMessage(reply: { error?: string; result?: unknown }) {
  expect(reply.error).toBeUndefined();
  const receipt = actionReceiptSchema.parse(reply.result);
  expect(receipt).toMatchObject({
    status: "refused",
    dispatch: "not-dispatched",
    progress: { axAttempted: 0, eventsPosted: 0 },
  });
  return receipt.message;
}

const bounded = async <A>(promise: Promise<A>, label: string): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

// Explicit real-native qualification. Only private LS-owned fixture windows are
// queried/edited, and no foreground activation or user window is involved.
async function qualifyWindowSessions(metadataOnly = false) {
  const directory = await mkdtemp(join(tmpdir(), "cafe-glide-window-sessions-"));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const bundle = join(directory, "SessionFixture.app");
  const executable = join(bundle, "Contents/MacOS/SessionFixture");
  const receipt = join(directory, "events");
  const helperPath = join(root, "apps/desktop/native/build", process.arch, "mac-glide");
  let watcher: FSWatcher | undefined;
  let owner: ReturnType<typeof spawn> | undefined;
  let ownerExit: Promise<void> | undefined;
  let secondOwner: ReturnType<typeof spawn> | undefined;
  let secondOwnerExit: Promise<void> | undefined;
  let helper: ReturnType<typeof spawn> | undefined;
  let helperExit: Promise<void> | undefined;
  let frames: AsyncGenerator<unknown> | undefined;
  let retired = false;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      retired = true;
      watcher?.close();
      if (helper && helperExit) {
        helper.stdin?.end();
        const force = setTimeout(() => helper?.kill("SIGKILL"), 1500);
        try {
          await helperExit;
          helper.stdout?.destroy();
          await frames?.return(undefined);
        } finally {
          clearTimeout(force);
        }
      }
      if (owner && ownerExit) {
        owner.stdin?.end();
        const force = setTimeout(() => owner?.kill("SIGKILL"), 1500);
        try {
          await ownerExit;
        } finally {
          clearTimeout(force);
        }
      }
      if (secondOwner && secondOwnerExit) {
        secondOwner.stdin?.end();
        const force = setTimeout(() => secondOwner?.kill("SIGKILL"), 1500);
        try {
          await secondOwnerExit;
        } finally {
          clearTimeout(force);
        }
      }
      await rm(directory, { recursive: true, force: true });
    })());
  onTestFinished(cleanup);

  try {
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(
      join(bundle, "Contents/Info.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.cafecode.glide-window-sessions-fixture</string><key>CFBundleExecutable</key><string>SessionFixture</string><key>CFBundleName</key><string>SessionFixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
    );
    const compiler = spawnSync(
      "xcrun",
      [
        "swiftc",
        "-target",
        `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`,
        fileURLToPath(new URL("./fixtures/glide-background-mac.fixture.swift", import.meta.url)),
        "-o",
        executable,
      ],
      { shell: false, timeout: 30_000, encoding: "utf8" },
    );
    expect(compiler.status, compiler.stderr).toBe(0);
    const launcher = join(directory, "Owner");
    await copyFile(executable, launcher);
    const ready = new Promise<void>((resolveReady, reject) => {
      watcher = watch(directory, (_event, name) => {
        if (name !== "events") return;
        void readFile(receipt, "utf8").then(
          (text) => {
            if (
              !retired &&
              JSON.parse(text).some((value: { kind: string }) => value.kind === "ready")
            )
              resolveReady();
          },
          () => undefined,
        );
      });
      watcher.once("error", reject);
    });
    owner = spawn(launcher, ["--launch-owned", bundle, receipt], {
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
      env: {
        ...glideChildEnvironment(process.env),
        HOME: directory,
        CFFIXED_USER_HOME: directory,
        TMPDIR: directory,
        CAFE_GLIDE_FIXTURE_SECOND_WINDOW: "1",
        CAFE_GLIDE_FIXTURE_WINDOW_CONTROL: "1",
      },
    });
    ownerExit = new Promise<void>((resolveExit, reject) => {
      owner!.once("exit", () => resolveExit());
      owner!.once("error", reject);
    });
    void ownerExit.catch(() => undefined);
    await bounded(
      Promise.race([
        ready,
        ownerExit.then(() => {
          throw new Error("Fixture owner exited before readiness.");
        }),
      ]),
      "Fixture readiness deadline.",
    );
    const initial = JSON.parse(await readFile(receipt + ".initial", "utf8")) as {
      foreground: unknown;
      pointer: unknown;
    };
    const first = (
      JSON.parse(await readFile(receipt, "utf8")) as {
        pid: number;
        windowNumber: number;
        witnessWindowNumber: number;
      }[]
    )[0]!;
    expect(first.windowNumber).toBeGreaterThan(0);
    expect(first.witnessWindowNumber).toBeGreaterThan(0);
    expect(first.windowNumber).not.toBe(first.witnessWindowNumber);
    const preserved = async () => {
      const values = JSON.parse(await readFile(receipt, "utf8")) as {
        foreground: unknown;
        pointer: unknown;
      }[];
      for (const value of values) {
        expect(value.foreground).toEqual(initial.foreground);
        expect(value.pointer).toEqual(initial.pointer);
      }
    };
    await preserved();
    if (!metadataOnly)
      helper = spawn(
        helperPath,
        ["--input-mode", "background", "--allow-app", "com.cafecode.glide-window-sessions-fixture"],
        {
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          env: glideChildEnvironment(process.env),
        },
      );
    if (!metadataOnly) {
      helper!.stderr!.resume();
      helperExit = new Promise<void>((resolveExit, reject) => {
        helper!.once("exit", () => resolveExit());
        helper!.once("error", reject);
      });
      void helperExit.catch(() => undefined);
      frames = readGlideFrames(helper!.stdout!);
    }
    let sequence = 0;
    const ask = async (sessionId: string, method: string, input: Record<string, unknown>) => {
      const id = ++sequence;
      await writeGlideFrame(helper!.stdin!, {
        id,
        sessionId,
        method,
        input,
        timeout_ms: 10_000,
        receiptVersion: 1,
      });
      const frame = await bounded(frames!.next(), "Native session reply deadline.");
      expect(frame.done).not.toBe(true);
      const value = frame.value as { id: number; result?: unknown; error?: string };
      expect(value.id).toBe(id);
      await preserved();
      return value;
    };
    const app = "com.cafecode.glide-window-sessions-fixture";
    const a = randomUUID(),
      b = randomUUID();
    if (!metadataOnly) {
      const discovered = await ask(a, "list_windows", { app });
      expect(discovered.error).toBeUndefined();
      const windows = windowListSchema.parse(discovered.result);
      expect(windows.some((window) => window.id === first.windowNumber)).toBe(true);
      expect(windows.some((window) => window.id === first.witnessWindowNumber)).toBe(true);
      expect((await ask(a, "get_app_state", { app, includeScreenshot: false })).error).toContain(
        "ambiguous",
      );
    }
    const secondHome = join(directory, "second-home");
    await mkdir(secondHome);
    const secondReceipt = join(directory, "events-second");
    const secondReady = new Promise<void>((resolveReady, reject) => {
      const listener = (_event: string, name: string | Buffer | null) => {
        if (name?.toString() !== "events-second") return;
        void readFile(secondReceipt, "utf8").then((source) => {
          if (JSON.parse(source).some((value: { kind: string }) => value.kind === "ready")) {
            watcher!.off("change", listener);
            resolveReady();
          }
        }, reject);
      };
      watcher!.on("change", listener);
    });
    secondOwner = spawn(launcher, ["--launch-owned", bundle, secondReceipt], {
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
      env: {
        ...glideChildEnvironment(process.env),
        HOME: secondHome,
        CFFIXED_USER_HOME: secondHome,
        TMPDIR: secondHome,
      },
    });
    secondOwnerExit = new Promise<void>((resolveExit, reject) => {
      secondOwner!.once("exit", () => resolveExit());
      secondOwner!.once("error", reject);
    });
    void secondOwnerExit.catch(() => undefined);
    await bounded(
      Promise.race([
        secondReady,
        secondOwnerExit.then(() => {
          throw new Error("Second exact fixture owner retired before readiness.");
        }),
      ]),
      "Second fixture readiness deadline.",
    );
    const secondValues = JSON.parse(await readFile(secondReceipt, "utf8")) as {
      pid: number;
      windowNumber: number;
      foreground: unknown;
      pointer: unknown;
    }[];
    for (const value of secondValues) {
      expect(value.foreground).toEqual(initial.foreground);
      expect(value.pointer).toEqual(initial.pointer);
    }
    const second = secondValues[0]!;
    const status = spawnSync(helperPath, ["--status"], {
      shell: false,
      timeout: 10_000,
      encoding: "utf8",
      env: glideChildEnvironment(process.env),
    });
    expect(status.error).toBeUndefined();
    expect(status.status, status.stderr).toBe(0);
    const pickerApps = (
      JSON.parse(status.stdout) as { apps: { bundleId: string; path: string; pid: number }[] }
    ).apps.filter((value) => value.bundleId === app);
    expect(pickerApps).toHaveLength(1);
    expect(await realpath(pickerApps[0]!.path)).toBe(await realpath(bundle));
    expect([first.pid, second.pid]).toContain(pickerApps[0]!.pid);
    await mkdir(join(root, ".logs"), { recursive: true });
    await writeFile(
      join(root, ".logs/glide-window-metadata-status.json"),
      JSON.stringify(
        {
          pickerApps,
          ownedPIDs: [first.pid, second.pid],
          ownedWindows: [first.windowNumber, second.windowNumber],
        },
        null,
        2,
      ),
    );
    await preserved();
    if (metadataOnly) return;
    const selected = await ask(a, "get_app_state", {
      app,
      windowId: first.windowNumber,
      includeScreenshot: true,
    });
    expect(selected.error).toBeUndefined();
    const stateA = observationSchema.parse(selected.result);
    await writeFile(
      join(root, ".logs/glide-window-observation.json"),
      JSON.stringify(
        {
          state: { ...stateA, screenshot: undefined },
          fixture: JSON.parse(await readFile(receipt, "utf8")),
          secondFixture: JSON.parse(await readFile(secondReceipt, "utf8")),
        },
        null,
        2,
      ),
    );
    if (stateA.screenshot)
      await writeFile(
        join(root, ".logs/glide-window-observation.png"),
        Buffer.from(stateA.screenshot.url.replace("data:image/png;base64,", ""), "base64"),
      );
    expect(stateA.windowId).toBe(first.windowNumber);
    expect(stateA.accessibilityAvailable).toBe(true);
    expect(stateA.screenshot?.url.startsWith("data:image/png;base64,")).toBe(true);
    const fieldA = Number(
      stateA.text
        .split("\n")
        .find((line) => line.includes("AXTextField") && line.includes("initial"))
        ?.match(/\b(\d+): AXTextField/)?.[1],
    );
    expect(fieldA).toBeGreaterThan(0);
    expect(
      refusalMessage(
        await ask(b, "set_value", {
          app,
          windowId: first.windowNumber,
          element_index: fieldA,
          value: "must not run",
        }),
      ),
    ).toContain("no observation");
    const bState = await ask(b, "get_app_state", {
      app,
      windowId: first.windowNumber,
      includeScreenshot: false,
    });
    expect(bState.error).toBeUndefined();
    const stateB = observationSchema.parse(bState.result);
    const fieldB = Number(
      stateB.text
        .split("\n")
        .find((line) => line.includes("AXTextField") && line.includes("initial"))
        ?.match(/\b(\d+): AXTextField/)?.[1],
    );
    expect(fieldB).toBeGreaterThan(0);
    expect(fieldB).not.toBe(fieldA);
    expect(
      refusalMessage(
        await ask(b, "set_value", {
          app,
          windowId: first.windowNumber,
          element_index: fieldA,
          value: "must not run",
        }),
      ),
    ).toContain("stale");
    expect((await ask(a, "retire_session", {})).error).toBeUndefined();
    expect(
      refusalMessage(
        await ask(a, "set_value", {
          app,
          windowId: first.windowNumber,
          element_index: fieldA,
          value: "retired must not run",
        }),
      ),
    ).toContain("no observation");
    expect(
      (
        await ask(b, "set_value", {
          app,
          windowId: first.windowNumber,
          element_index: fieldB,
          value: "exact B retained",
        })
      ).error,
    ).toBeUndefined();
    const retained = await ask(b, "get_app_state", {
      app,
      windowId: first.windowNumber,
      includeScreenshot: false,
    });
    expect(retained.error).toBeUndefined();
    expect(observationSchema.parse(retained.result).text).toContain("exact B retained");
    const restored = new Promise<void>((resolveRestored, reject) => {
      const listener = (_event: string, name: string | Buffer | null) => {
        if (name?.toString() !== "events") return;
        void readFile(receipt, "utf8").then((text) => {
          if (
            JSON.parse(text).some(
              (value: { kind: string }) => value.kind === "owned window restored",
            )
          ) {
            watcher!.off("change", listener);
            resolveRestored();
          }
        }, reject);
      };
      watcher!.on("change", listener);
    });
    await writeFile(receipt + ".control", "move-away-and-back");
    await bounded(restored, "Owned window restoration receipt deadline.");
    expect(
      refusalMessage(
        await ask(b, "set_value", {
          app,
          windowId: first.windowNumber,
          element_index: fieldB,
          value: "stale geometry must not run",
        }),
      ),
    ).toContain("window changed");
    const renewed = await ask(b, "get_app_state", {
      app,
      windowId: first.windowNumber,
      includeScreenshot: false,
      disableDiff: true,
    });
    expect(renewed.error).toBeUndefined();
    expect(observationSchema.parse(renewed.result).text).toContain("exact B retained");
    const witness = await ask(b, "get_app_state", {
      app,
      windowId: first.witnessWindowNumber,
      includeScreenshot: false,
    });
    expect(witness.error).toBeUndefined();
    expect(observationSchema.parse(witness.result).text).toContain("witness unchanged");
    const instances = windowListSchema.parse((await ask(b, "list_windows", { app })).result);
    expect(instances.some((value) => value.id === first.windowNumber)).toBe(true);
    expect(instances.some((value) => value.id === second.windowNumber)).toBe(true);
    const selectedInstance = await ask(b, "get_app_state", {
      app,
      windowId: second.windowNumber,
      includeScreenshot: false,
      disableDiff: true,
    });
    expect(selectedInstance.error).toBeUndefined();
    const secondState = observationSchema.parse(selectedInstance.result);
    expect(secondState.pid).toBe(second.pid);
    expect(secondState.windowId).toBe(second.windowNumber);
    expect(secondState.text).toContain("initial");
    expect((await ask("not-a-uuid", "retire_session", {})).error).toContain("session identity");
    await preserved();
  } finally {
    await cleanup();
  }
}

it.skipIf(process.platform !== "darwin")(
  "pins explicit windows and retires only the exact native session observations",
  () => qualifyWindowSessions(),
  60_000,
);
it.skipIf(process.platform !== "darwin")(
  "lists one picker row for two exact owned instances without AX or input",
  () => qualifyWindowSessions(true),
  60_000,
);
