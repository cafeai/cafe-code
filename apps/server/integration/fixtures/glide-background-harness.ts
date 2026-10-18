import { spawn, spawnSync } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished } from "vitest";
import { GlideRuntime, glideChildEnvironment } from "../../src/glide/runtime.ts";
import { actionReceiptSchema } from "../../src/glide/protocol.ts";

interface Identity {
  pid: number;
  birth: { seconds: number; microseconds: number };
}
interface Receipt extends Identity {
  sequence: number;
  kind: string;
  foreground: Identity;
  pointer: { x: number; y: number };
  windowNumber: number;
  eventWindowNumber?: number;
  eventType?: number;
  key: boolean;
  main: boolean;
  active: boolean;
  field: string;
  status: string;
  spaces: { display: string; space: number }[];
  visibility: { visible: boolean; onActiveSpace: boolean; hidden: boolean; minimized: boolean };
  offSpacePreparation: {
    requested: boolean;
    failure?: string;
    moved?: boolean;
    currentSpacesUnchanged?: boolean;
    targetSpace?: number;
    windowSpaces?: number[];
  };
  controls: Record<
    "field" | "apply" | "pointer",
    { x: number; y: number; width: number; height: number }
  >;
}

// Explicit opt-in: real macOS accessibility is required; the full journey also
// requires Screen Recording. The separate AX journey qualifies input delivery
// independently without replacing or weakening the full PNG requirement.
// The fixture never activates, raises, joins fullscreen Spaces or sends input to
// another application. A user changing focus/pointer during this short journey
// fails its preservation assertion rather than being repaired by more input.
export async function qualifyBackground(
  requireScreenshot: boolean,
  offSpace = false,
  launchThroughGlide = false,
  lifecycleOnly = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "cafe-glide-background-"));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const bundle = join(directory, "BackgroundFixture.app");
  const executable = join(bundle, "Contents", "MacOS", "BackgroundFixture");
  const receiptPath = join(directory, "events");
  let runtime: GlideRuntime | undefined;
  let watcher: FSWatcher | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<void> | undefined;
  let retired = false;
  let phase = "setup";
  let receipts: Receipt[] = [];
  let validateReceipts: (() => void) | undefined;
  let receiptFailure: Error | undefined;
  const ownerPublication = Promise.withResolvers<{
    pid: number;
    seconds: number;
    microseconds: number;
  }>();
  const waiting = new Set<{
    accept: (receipts: Receipt[]) => boolean;
    resolve: (receipts: Receipt[]) => void;
    reject: (error: Error) => void;
  }>();
  const retireWaiters = (error: Error) => {
    for (const waiter of waiting) waiter.reject(error);
    waiting.clear();
  };
  const failReceipts = (error: unknown) => {
    receiptFailure = error instanceof Error ? error : new Error("Receipt read failed.");
    retireWaiters(receiptFailure);
    // An external focus/pointer change retires the exact helper immediately,
    // including while the test awaits a target receipt. Never dispatch the next
    // action after a failed preservation observation.
    void runtime?.close();
  };
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      retired = true;
      watcher?.close();
      retireWaiters(new Error("Background fixture retired."));
      await appendFile(receiptPath + ".unconfirmed-release", "release").catch(() => undefined);
      await runtime?.close();
      if (child && exited) {
        // The exact launcher owns its LS child through birth+bundle identity.
        // Closing its pipe requests owned cleanup before child-only escalation.
        child.stdin?.end();
        const force = setTimeout(() => child?.kill("SIGKILL"), 1500);
        try {
          await exited;
        } finally {
          clearTimeout(force);
        }
      }
      await rm(directory, { recursive: true, force: true });
    })());
  // Register before any launch/readiness await; hard timeout also owns cleanup.
  onTestFinished(cleanup);

  const readReceipts = async () => {
    const text = await readFile(receiptPath, "utf8").catch(() => undefined);
    if (retired || text === undefined) return;
    const next = JSON.parse(text) as Receipt[];
    if (!Array.isArray(next) || next.length > 128)
      throw new Error("Background fixture receipt bound was violated.");
    // Atomic replacement can produce overlapping watch reads. An old complete
    // journal must never replace a newer receipt already observed.
    if (next.length < receipts.length) return;
    receipts = next;
    validateReceipts?.();
    for (const waiter of waiting) {
      if (waiter.accept(receipts)) {
        waiting.delete(waiter);
        waiter.resolve(receipts);
      }
    }
  };
  const awaitReceipt = (accept: (receipts: Receipt[]) => boolean, label: string) => {
    if (accept(receipts)) return Promise.resolve(receipts);
    let waiter: {
      accept: (receipts: Receipt[]) => boolean;
      resolve: (receipts: Receipt[]) => void;
      reject: (error: Error) => void;
    };
    let timer: ReturnType<typeof setTimeout>;
    const result = new Promise<Receipt[]>((resolveReceipt, reject) => {
      waiter = { accept, resolve: resolveReceipt, reject };
      waiting.add(waiter);
      timer = setTimeout(() => reject(new Error(label)), 10_000);
      void readReceipts().catch(reject);
    });
    const observed = result.finally(() => {
      clearTimeout(timer);
      waiting.delete(waiter);
    });
    // An exact receipt is armed before dispatch. If dispatch throws, cleanup
    // rejects it without producing a detached unhandled rejection.
    void observed.catch(() => undefined);
    return observed;
  };

  try {
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(
      join(bundle, "Contents", "Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.cafecode.glide-background-fixture</string><key>CFBundleExecutable</key><string>BackgroundFixture</string><key>CFBundleName</key><string>BackgroundFixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
    );
    const compiler = spawnSync(
      "xcrun",
      [
        "swiftc",
        "-target",
        `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`,
        fileURLToPath(new URL("./glide-background-mac.fixture.swift", import.meta.url)),
        "-o",
        executable,
      ],
      { shell: false, timeout: 30_000, encoding: "utf8" },
    );
    expect(compiler.status, compiler.stderr).toBe(0);
    const launcher = join(directory, "FixtureLauncher");
    await copyFile(executable, launcher);
    watcher = watch(directory, (_event, name) => {
      if (name === "events") void readReceipts().catch(failReceipts);
      if (name === "events.owner")
        void readFile(receiptPath + ".owner", "utf8")
          .then((text) => ownerPublication.resolve(JSON.parse(text)))
          .catch(failReceipts);
    });
    watcher.once("error", failReceipts);
    const ready = awaitReceipt(
      (values) => values.some((value) => value.kind === "ready"),
      "Background fixture did not publish readiness.",
    );
    child = spawn(
      launcher,
      [launchThroughGlide ? "--watch-owned" : "--launch-owned", bundle, receiptPath],
      {
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
        env: {
          ...glideChildEnvironment(process.env),
          HOME: directory,
          CFFIXED_USER_HOME: directory,
          TMPDIR: directory,
          ...(offSpace ? { CAFE_GLIDE_FIXTURE_OFFSPACE: "1" } : {}),
        },
      },
    );
    exited = new Promise<void>((resolveExit, reject) => {
      child!.once("exit", () => {
        retireWaiters(new Error("Background fixture owner exited."));
        resolveExit();
      });
      child!.once("error", (error) => {
        retireWaiters(error);
        reject(error);
      });
    });
    void exited.catch(() => undefined);
    if (launchThroughGlide) {
      phase = "first-class background application launch";
      const owner = await Promise.race([
        ownerPublication.promise,
        ready.then(() => {
          throw new Error("Fixture launched before its owned launch request.");
        }),
        exited.then(() => {
          throw new Error("Fixture launch owner exited before admission.");
        }),
      ]);
      const escape = (text: string) =>
        text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      const infoPath = join(bundle, "Contents", "Info.plist");
      // Apple's LSEnvironment applies before Launch Services starts this exact
      // private fixture. The executable refuses to create NSApplication unless
      // both home variables match; production launch gets no env/argv override.
      // https://developer.apple.com/documentation/bundleresources/information-property-list/lsenvironment
      const info = await readFile(infoPath, "utf8");
      await writeFile(
        infoPath,
        info.replace(
          "</dict></plist>",
          `<key>GlideFixtureReceipt</key><string>${escape(receiptPath)}</string><key>GlideFixturePrivateHome</key><string>${escape(directory)}</string><key>GlideFixtureOwner</key><array><string>${owner.pid}</string><string>${owner.seconds}</string><string>${owner.microseconds}</string></array><key>LSEnvironment</key><dict><key>HOME</key><string>${escape(directory)}</string><key>CFFIXED_USER_HOME</key><string>${escape(directory)}</string><key>TMPDIR</key><string>${escape(directory)}</string></dict></dict></plist>`,
        ),
      );
      runtime = new GlideRuntime({
        helperPath: join(root, "apps/desktop/native/build", process.arch, "mac-glide"),
        allowedApps: ["com.cafecode.glide-background-fixture"],
        nativePrefixArgs: ["--allow-app-path", bundle],
      });
      const launched = await runtime.execute({
        code: `await glide.launchApp(${JSON.stringify(bundle)});`,
      });
      const homeRefusal = await readFile(receiptPath + ".home-refusal", "utf8").catch(() => "none");
      expect(
        launched.isError,
        JSON.stringify(launched.content) + " private-home refusal=" + homeRefusal,
      ).not.toBe(true);
      const emitted = launched.content.find(
        (item) => item.type === "text" && item.text.startsWith("Glide action "),
      );
      if (emitted?.type !== "text") throw new Error("Launch did not emit its action receipt.");
      expect(
        actionReceiptSchema.parse(JSON.parse(emitted.text.slice("Glide action ".length))),
      ).toMatchObject({
        method: "launch_app",
        status: "verified",
        verification: { kind: "application", matched: true },
      });
    }
    phase = "background fixture readiness";
    await ready;
    const initial = JSON.parse(await readFile(receiptPath + ".initial", "utf8")) as {
      foreground: Identity;
      pointer: { x: number; y: number };
      spaces: { display: string; space: number }[];
    };
    const first = receipts[0]!;
    expect(initial.foreground.pid).toBeGreaterThan(0);
    expect(initial.foreground.birth.seconds).toBeGreaterThan(0);
    expect(first.pid).not.toBe(initial.foreground.pid);
    expect(first.foreground).toEqual(initial.foreground);
    expect(first.key).toBe(false);
    expect(first.active).toBe(false);
    expect(first.pointer).toEqual(initial.pointer);
    let offSpaceReadySequence = Infinity;
    if (offSpace) {
      phase = "owned off-Space setup";
      expect(initial.spaces.length).toBeGreaterThan(0);
      expect(
        first.offSpacePreparation.failure,
        JSON.stringify(first.offSpacePreparation),
      ).toBeUndefined();
      expect(first.offSpacePreparation.moved).toBe(true);
      expect(first.offSpacePreparation.currentSpacesUnchanged).toBe(true);
      expect(initial.spaces.map((value) => value.space)).not.toContain(
        first.offSpacePreparation.targetSpace,
      );
      await awaitReceipt(
        (values) =>
          values.some((value) => !value.visibility.onActiveSpace && value.visibility.visible),
        "Owned window did not become off-Space.",
      );
      offSpaceReadySequence = receipts.find(
        (value) => !value.visibility.onActiveSpace && value.visibility.visible,
      )!.sequence;
    }
    const preserved = () => {
      for (const value of receipts) {
        expect(value.pid).toBe(first.pid);
        expect(value.birth).toEqual(first.birth);
        expect(value.foreground, JSON.stringify(value)).toEqual(initial.foreground);
        expect(value.pointer, JSON.stringify(value)).toEqual(initial.pointer);
        expect(value.windowNumber).toBe(first.windowNumber);
        if (offSpace) {
          expect(value.spaces).toEqual(initial.spaces);
          if (value.sequence >= offSpaceReadySequence) {
            expect(value.visibility.onActiveSpace).toBe(false);
            expect(value.visibility.visible).toBe(true);
            expect(value.visibility.hidden).toBe(false);
            expect(value.visibility.minimized).toBe(false);
          }
        }
        if (value.eventWindowNumber !== undefined) {
          // Keyboard events may be PID-addressed with windowNumber 0; their
          // actual field-change receipt proves responder delivery. Pointer
          // events must carry this exact window's number.
          const allowed =
            value.eventType === 10 || value.eventType === 11
              ? [0, first.windowNumber]
              : [first.windowNumber];
          expect(allowed, JSON.stringify(value)).toContain(value.eventWindowNumber);
        }
      }
    };
    validateReceipts = preserved;
    preserved();
    runtime ??= new GlideRuntime({
      helperPath: join(root, "apps/desktop/native/build", process.arch, "mac-glide"),
      allowedApps: ["com.cafecode.glide-background-fixture"],
      inputMode: "background",
    });
    const execute = async (code: string) => {
      if (receiptFailure) throw receiptFailure;
      const result = await runtime!.execute({ code });
      if (receiptFailure) throw receiptFailure;
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      await readReceipts();
      preserved();
      return {
        result,
        text: result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n"),
      };
    };
    phase = "background screenshot and AX";
    const observation = await execute(
      `nodeRepl.write(await glide.listApps({emit:false})); nodeRepl.write(await glide.listWindows("com.cafecode.glide-background-fixture",{emit:false})); var app = await glide.getApp("com.cafecode.glide-background-fixture",{windowId:${first.windowNumber}}); await app.${requireScreenshot ? "getAXStateAndScreenshot" : "getAXState"}();`,
    );
    if (requireScreenshot) {
      expect(
        observation.result.content.some((item) => item.type === "image"),
        "Screen Recording permission must produce a real target-window screenshot.",
      ).toBe(true);
    } else {
      expect(observation.text).toContain("screenshot=omitted (AX-only)");
      const omitted = await execute(
        `var axOnly = await sky.get_app_state({app:"com.cafecode.glide-background-fixture",windowId:${first.windowNumber},includeScreenshot:false}); nodeRepl.write(axOnly.screenshot === null);`,
      );
      expect(omitted.text).toBe("true");
    }
    if (launchThroughGlide) {
      await readReceipts();
      preserved();
      return;
    }
    if (offSpace) {
      const center = (name: "field" | "apply" | "pointer") => {
        const value = first.controls[name];
        expect(value.width).toBeGreaterThan(0);
        expect(value.height).toBeGreaterThan(0);
        return [value.x + value.width / 2, value.y + value.height / 2];
      };
      const artifacts = join(root, ".logs");
      await mkdir(artifacts, { recursive: true });
      const initialImage = observation.result.content.find((value) => value.type === "image");
      expect(initialImage).toBeDefined();
      await writeFile(
        join(artifacts, "glide-offspace-initial.png"),
        Buffer.from(initialImage!.data, "base64"),
      );
      phase = "off-Space coordinate field and Unicode input";
      const typed = awaitReceipt(
        (values) =>
          values.some(
            (value) => value.kind === "field changed" && value.field === "offspace 👩‍💻 café",
          ),
        "Off-Space field did not accept actual Unicode input.",
      );
      await execute(
        `await app.click(${JSON.stringify(center("field"))}); await app.pressKey("super+a"); await app.typeText("offspace 👩‍💻 café");`,
      );
      await typed;
      phase = "off-Space native key and caret insertion";
      const edited = awaitReceipt(
        (values) =>
          values.some(
            (value) => value.kind === "field changed" && value.field === "offspace 👩‍💻 caf!é",
          ),
        "Off-Space native key/caret edit was not accepted.",
      );
      await execute('await app.pressKey("left"); await app.typeText("!");');
      await edited;
      phase = "off-Space coordinate button";
      const applied = awaitReceipt(
        (values) =>
          values.some(
            (value) => value.kind === "applied" && value.status === "applied: offspace 👩‍💻 caf!é",
          ),
        "Off-Space coordinate button did not accept the click.",
      );
      await execute(`await app.click(${JSON.stringify(center("apply"))});`);
      await applied;
      phase = "off-Space coordinate scroll";
      const scrolled = awaitReceipt(
        (values) => values.some((value) => value.kind === "pointer scrolled down"),
        "Off-Space pointer view did not accept the native scroll.",
      );
      await execute(`await app.scroll(${JSON.stringify(center("pointer"))},"down",0.25);`);
      await scrolled;
      phase = "final off-Space capture";
      const final = await execute("await app.getAXStateAndScreenshot({disableDiffing:true});");
      const image = final.result.content.find((value) => value.type === "image");
      expect(image).toBeDefined();
      await writeFile(
        join(artifacts, "glide-offspace-final.png"),
        Buffer.from(image!.data, "base64"),
      );
      await writeFile(
        join(artifacts, "glide-offspace-receipts.json"),
        JSON.stringify(
          { initial, initialObservation: observation.text, finalObservation: final.text, receipts },
          null,
          2,
        ),
      );
      preserved();
      expect(
        receipts.some((value) => value.kind === "window input" && value.eventType === 10),
      ).toBe(true);
      expect(receipts.some((value) => value.kind === "window input" && value.eventType === 1)).toBe(
        true,
      );
      expect(
        receipts.some((value) => value.kind === "window input" && value.eventType === 22),
      ).toBe(true);
      return;
    }
    let field = observation.text
      .split("\n")
      .find((line) => line.includes("AXTextField") && line.includes("initial"))
      ?.match(/\b(\d+): AXTextField/)?.[1];
    expect(field, observation.text).toBeDefined();
    const window = observation.text
      .split("\n")
      .find((line) => line.includes("AXWindow") && line.includes("AXRaise"))
      ?.match(/\b(\d+): AXWindow/)?.[1];
    expect(window, observation.text).toBeDefined();
    let noOp = observation.text
      .split("\n")
      .find((line) => line.includes("AXTextField") && line.includes("no-op initial"))
      ?.match(/\b(\d+): AXTextField/)?.[1];
    const refreshAfterFailure = async () => {
      const fresh = await execute("await app.getAXState({disableDiffing:true});");
      field = fresh.text
        .split("\n")
        .find((line) => line.includes("AXTextField") && line.includes('value="initial"'))
        ?.match(/\b(\d+): AXTextField/)?.[1];
      noOp = fresh.text
        .split("\n")
        .find((line) => line.includes("AXTextField") && line.includes("no-op initial"))
        ?.match(/\b(\d+): AXTextField/)?.[1];
      expect(field, fresh.text).toBeDefined();
      expect(noOp, fresh.text).toBeDefined();
      return fresh.text;
    };
    const actionReceipts = (result: Awaited<ReturnType<GlideRuntime["execute"]>>) =>
      result.content.flatMap((item) =>
        item.type === "text" && item.text.startsWith("Glide action ")
          ? [actionReceiptSchema.parse(JSON.parse(item.text.slice("Glide action ".length)))]
          : [],
      );
    const qualifyLifecycle = async (recovered: string) => {
      const prepareOwnedState = async (index: string) => {
        const result = await runtime!.execute({
          code: `await app.performSecondaryAction(${index}, "AXPress");`,
        });
        // Setup can have the same timeout-after-effect behavior as a real app.
        // Only the exact preinstalled visibility receipt admits the next step;
        // an outside-input/ownership failure is never accepted as setup success.
        if (result.isError)
          expect(actionReceipts(result)).toMatchObject([
            {
              status: "uncertain",
              osAcceptance: "rejected",
              progress: { axAttempted: 1, axAccepted: 0 },
              message: expect.stringContaining("Accessibility action was not confirmed"),
            },
          ]);
        await readReceipts();
        preserved();
      };
      phase = "hidden window observation and explicit restoration";
      const hide = recovered
        .split("\n")
        .find((line) => line.includes("Hide fixture"))
        ?.match(/\b(\d+): AXButton/)?.[1];
      expect(hide, recovered).toBeDefined();
      const hiddenEffect = awaitReceipt(
        (values) => values.some((value) => value.visibility.hidden),
        "Fixture did not become hidden.",
      );
      await prepareOwnedState(hide!);
      await hiddenEffect;
      const hidden = await execute("await app.getAXState({disableDiffing:true});");
      expect(hidden.text).toContain("hidden=true");
      expect(hidden.text).toContain("blockedActions=");
      const restored = await execute("await app.restoreWindow();");
      expect(actionReceipts(restored.result)).toMatchObject([
        {
          method: "restore_window",
          status: "verified",
          verification: { kind: "window", matched: true },
        },
      ]);
      const staleInput = await runtime!.execute({ code: `await app.click(${field});` });
      expect(staleInput.isError).toBe(true);
      expect(actionReceipts(staleInput)).toMatchObject([
        { status: "refused", dispatch: "not-dispatched" },
      ]);
      recovered = await refreshAfterFailure();
      expect(recovered).toContain("hidden=false minimized=false");
      phase = "minimized window observation and explicit restoration";
      const minimize = recovered
        .split("\n")
        .find((line) => line.includes("Minimize fixture"))
        ?.match(/\b(\d+): AXButton/)?.[1];
      expect(minimize, recovered).toBeDefined();
      const minimizedEffect = awaitReceipt(
        (values) => values.some((value) => value.visibility.minimized),
        "Fixture did not become minimized.",
      );
      await prepareOwnedState(minimize!);
      await minimizedEffect;
      const minimized = await execute("await app.getAXState({disableDiffing:true});");
      expect(minimized.text).toContain("minimized=true");
      const unminimized = await execute("await app.restoreWindow();");
      expect(actionReceipts(unminimized.result)).toMatchObject([
        {
          method: "restore_window",
          status: "verified",
          verification: { kind: "window", matched: true },
        },
      ]);
      await refreshAfterFailure();
    };
    if (lifecycleOnly) {
      await qualifyLifecycle(observation.text);
      preserved();
      return;
    }
    phase = "background raise refusal";
    const raised = await runtime.execute({
      code: `await app.performSecondaryAction(${window}, "AXRaise");`,
    });
    expect(raised.isError).toBe(true);
    expect(actionReceipts(raised)).toMatchObject([
      {
        status: "refused",
        dispatch: "not-dispatched",
        message: "Raising a window requires explicit foreground mode.",
      },
    ]);
    await readReceipts();
    preserved();
    phase = "accepted AX no-op detection";
    expect(noOp, observation.text).toBeDefined();
    const ignoredWrite = await runtime.execute({
      code: `await app.setValue(${noOp}, "must not appear"); await app.typeText("must not run");`,
    });
    expect(ignoredWrite.isError, JSON.stringify(ignoredWrite.content)).toBe(true);
    expect(actionReceipts(ignoredWrite)).toMatchObject([
      {
        method: "set_value",
        status: "not-observed",
        osAcceptance: "accepted",
        progress: { axAttempted: 1, axAccepted: 1, textScalarsPosted: 0 },
        verification: {
          kind: "value",
          matched: false,
          before: "no-op initial",
          after: "no-op initial",
        },
      },
    ]);
    const afterWrite = await refreshAfterFailure();
    const unfocusable = afterWrite
      .split("\n")
      .find((line) => line.includes("Unfocusable fixture input"))
      ?.match(/\b(\d+): AXTextField/)?.[1];
    expect(unfocusable, afterWrite).toBeDefined();
    const ignoredFocus = await runtime.execute({
      code: `await app.typeInto(${unfocusable}, "must not be typed");`,
    });
    expect(ignoredFocus.isError, JSON.stringify(ignoredFocus.content)).toBe(true);
    expect(actionReceipts(ignoredFocus)).toMatchObject([
      {
        method: "type_into",
        status: "not-observed",
        progress: { textScalarsPosted: 0 },
        verification: { kind: "focus", matched: false },
      },
    ]);
    const afterFocus = await refreshAfterFailure();
    phase = "actionable coordinate ambiguity";
    const overlapBounds = afterFocus
      .split("\n")
      .find((line) => line.includes("no-op initial"))
      ?.match(/bounds=\[([^\]]+)\]/)?.[1]
      ?.split(",")
      .map(Number);
    expect(overlapBounds?.length, afterFocus).toBe(4);
    const [overlapX, overlapY, overlapWidth, overlapHeight] = overlapBounds!;
    const ambiguous = await runtime.execute({
      code: `await app.click([${overlapX! + overlapWidth! / 2},${overlapY! + overlapHeight! / 2}]);`,
    });
    expect(ambiguous.isError).toBe(true);
    const ambiguity = actionReceipts(ambiguous)[0]!;
    expect(ambiguity.candidates).toHaveLength(2);
    expect(new Set(ambiguity.candidates!.map((candidate) => candidate.index)).size).toBe(2);
    expect(ambiguity.candidates!.every((candidate) => candidate.role === "AXTextField")).toBe(true);
    let recovered = await refreshAfterFailure();
    phase = "unconfirmed AX action with an actual side effect";
    const uncertainButton = recovered
      .split("\n")
      .find((line) => line.includes("Unconfirmed fixture action"))
      ?.match(/\b(\d+): AXButton/)?.[1];
    expect(uncertainButton, recovered).toBeDefined();
    const actionEffect = awaitReceipt(
      (values) =>
        values.some(
          (value) => value.kind === "unconfirmed action" && value.status === "unconfirmed count=1",
        ),
      "Unconfirmed AX action did not publish its actual effect.",
    );
    let uncertainAction: Awaited<ReturnType<GlideRuntime["execute"]>>;
    try {
      uncertainAction = await runtime.execute({
        code: `await app.performSecondaryAction(${uncertainButton}, "AXPress"); await app.typeText("must not run");`,
      });
    } finally {
      await appendFile(receiptPath + ".unconfirmed-release", "release");
    }
    await actionEffect;
    expect(uncertainAction.isError, JSON.stringify(uncertainAction.content)).toBe(true);
    expect(actionReceipts(uncertainAction)).toMatchObject([
      {
        status: "uncertain",
        dispatch: "dispatched",
        osAcceptance: "rejected",
        progress: { axAttempted: 1, axAccepted: 0 },
      },
    ]);
    recovered = await refreshAfterFailure();
    expect(recovered).toContain("unconfirmed count=1");
    expect(receipts.filter((value) => value.kind === "unconfirmed action")).toHaveLength(1);
    phase = "background AX value";
    const set = await execute(
      `await app.setValue(${field}, "AX café"); await app.getAXState({disableDiffing:true});`,
    );
    expect(set.text).toContain("AX café");
    expect(actionReceipts(set.result)).toMatchObject([
      {
        method: "set_value",
        status: "verified",
        osAcceptance: "accepted",
        verification: { kind: "value", matched: true, after: "AX café" },
      },
    ]);
    phase = "targeted verified Unicode replacement";
    const clearedReceipt = awaitReceipt(
      (values) => values.some((value) => value.kind === "field changed" && value.field === ""),
      "Empty replacement did not clear the exact field.",
    );
    const cleared = await execute(`await app.typeInto(${field}, "", {replace:true});`);
    await clearedReceipt;
    expect(actionReceipts(cleared.result)).toMatchObject([
      {
        method: "type_into",
        status: "verified",
        verification: { kind: "text", matched: true, after: "" },
      },
    ]);
    const targetedReceipt = awaitReceipt(
      (values) => values.some((value) => value.kind === "field changed" && value.field === "é👩‍💻"),
      "Targeted text replacement did not reach the actual field.",
    );
    const targeted = await execute(`await app.typeInto(${field}, "é👩‍💻", {replace:true});`);
    await targetedReceipt;
    expect(actionReceipts(targeted.result)).toMatchObject([
      {
        method: "type_into",
        status: "verified",
        verification: { kind: "text", matched: true, after: "é👩‍💻" },
      },
    ]);
    phase = "background click and Unicode typing";
    const typedReceipt = awaitReceipt(
      (values) =>
        values.some((value) => value.kind === "field changed" && value.field === "typed 👩‍💻"),
      "The background field did not accept actual Unicode key input.",
    );
    await execute(
      `await app.click(${field}); await app.pressKey("super+a"); await app.typeText("typed 👩‍💻");`,
    );
    await typedReceipt;
    phase = "background selection and paste";
    const selected = await execute(
      `await app.selectText(${field}, "typed", {selectionType:"cursor_after"}); await app.typeText(" café"); await app.getAXState({disableDiffing:true});`,
    );
    expect(selected.text).toContain("typed café 👩‍💻");
    const pastedReceipt = awaitReceipt(
      (values) =>
        values.some(
          (value) => value.kind === "field changed" && value.field === "background pasted",
        ),
      "The background field did not accept actual paste input.",
    );
    const pasted = await execute(
      'await app.pressKey("super+a"); await app.paste("background pasted"); await app.getAXState({disableDiffing:true});',
    );
    await pastedReceipt;
    expect(pasted.text).toContain("background pasted");
    const button = pasted.text
      .split("\n")
      .find((line) => line.includes("AXButton") && line.includes("Apply background fixture"))
      ?.match(/\b(\d+): AXButton/)?.[1];
    expect(button, pasted.text).toBeDefined();
    phase = "background advertised action";
    const appliedReceipt = awaitReceipt(
      (values) =>
        values.some(
          (value) => value.kind === "applied" && value.status === "applied: background pasted",
        ),
      "The background AX action did not reach the actual button.",
    );
    const applied = await execute(
      `await app.performSecondaryAction(${button}, "AXPress"); await app.getAXState({disableDiffing:true});`,
    );
    await appliedReceipt;
    const area = applied.text.split("\n").find((line) => line.includes("Background pointer area"));
    const bounds = area
      ?.match(/bounds=\[([^\]]+)\]/)?.[1]
      ?.split(",")
      .map(Number);
    expect(bounds?.length, applied.text).toBe(4);
    const [x, y, width, height] = bounds!;
    const center = [x! + width! / 2, y! + height! / 2];
    phase = "background coordinate click";
    const clickReceipt = awaitReceipt(
      (values) => values.some((value) => value.kind === "pointer clicked"),
      "The background pointer view did not accept the targeted click.",
    );
    await execute(`await app.click(${JSON.stringify(center)});`);
    await clickReceipt;
    phase = "background drag";
    const dragReceipt = awaitReceipt(
      (values) => values.some((value) => value.kind === "pointer dragged"),
      "The background pointer view did not accept targeted dragging.",
    );
    await execute(
      `await app.drag(${JSON.stringify([x! + 10, center[1]])},${JSON.stringify([x! + width! - 10, center[1]])});`,
    );
    await dragReceipt;
    phase = "background scroll";
    const scrollReceipt = awaitReceipt(
      (values) => values.some((value) => value.kind === "pointer scrolled down"),
      "The background pointer view did not accept targeted scrolling.",
    );
    // Move the target app's internal pointer focus back to the field before
    // scrolling the pointer view; this catches routing based on last click.
    await execute(
      `await app.click(${field}); await app.scroll(${JSON.stringify(center)},"down",0.25);`,
    );
    await scrollReceipt;
    phase = "final background observation";
    const final = await execute(
      `await app.${requireScreenshot ? "getAXStateAndScreenshot" : "getAXState"}({disableDiffing:true});`,
    );
    expect(final.text).toContain("background pasted");
    expect(final.text).toContain("pointer scrolled down");
    await readReceipts();
    preserved();
    expect(receipts.some((value) => value.kind === "window input" && value.eventType === 10)).toBe(
      true,
    );
    expect(receipts.some((value) => value.kind === "window input" && value.eventType === 1)).toBe(
      true,
    );
    expect(receipts.some((value) => value.kind === "window input" && value.eventType === 22)).toBe(
      true,
    );
    if (requireScreenshot) {
      const image = final.result.content.find((item) => item.type === "image");
      expect(image, "Final observation must retain a real target-window PNG.").toBeDefined();
      const artifacts = join(root, ".logs");
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        join(artifacts, "glide-background-fixture.png"),
        Buffer.from(image!.data, "base64"),
      );
      await writeFile(
        join(artifacts, "glide-background-receipts.json"),
        JSON.stringify({ initial, receipts }, null, 2) + "\n",
      );
    }
  } catch (error) {
    const latest = await readFile(receiptPath, "utf8")
      .then((text) => JSON.parse(text) as Receipt[])
      .catch(() => []);
    await mkdir(join(root, ".logs"), { recursive: true });
    await writeFile(
      join(root, ".logs/glide-background-failure.json"),
      JSON.stringify(
        {
          phase,
          cachedCount: receipts.length,
          latestCount: latest.length,
          tail: latest
            .slice(-3)
            .map((value) => ({ sequence: value.sequence, kind: value.kind, field: value.field })),
        },
        null,
        2,
      ),
    );
    if (offSpace) {
      await mkdir(join(root, ".logs"), { recursive: true });
      await writeFile(
        join(root, ".logs/glide-offspace-failure.json"),
        JSON.stringify({ phase, receipts }, null, 2),
      );
    }
    throw new Error(
      `Native background qualification failed during ${phase}. Last target receipts: ${JSON.stringify(receipts.slice(-16))}`,
      { cause: error },
    );
  } finally {
    await cleanup();
  }
}
