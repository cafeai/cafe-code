// Native fixture owns exact child argv, stdio handles and retirement; keep that process boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn, spawnSync } from "node:child_process";
// Native fixture exercises actual file identity, namespace and cleanup behavior.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { watch, type FSWatcher } from "node:fs";
// Native fixture exercises actual file identity, namespace and cleanup behavior.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as DateTime from "effect/DateTime";
// Native fixture paths retain host drive, separator and namespace semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { GlideRuntime, glideChildEnvironment } from "../src/glide/runtime.ts";
import { actionReceiptSchema } from "../src/glide/protocol.ts";

interface Receipt {
  sequence: number;
  kind: string;
  pid: number;
  birth: { seconds: number; microseconds: number };
  foreground: { pid: number; birth: { seconds: number; microseconds: number } };
  pointer: { x: number; y: number };
  windowNumber: number;
  onActiveSpace: boolean;
  status: string;
  selection: string;
  eventType?: number;
  eventWindowNumber?: number;
}

interface AXInspection {
  root: number;
  birth: Receipt["birth"];
  foreground: Receipt["foreground"];
  pointer: Receipt["pointer"];
  elements: {
    logicalPID: number;
    actualPID: number;
    birth: Receipt["birth"];
    windowId: number;
    windowOwner: number;
    role: string;
    title: string;
  }[];
}

// Explicit opt-in native UI qualification. Only fresh LS-owned fixture menus
// receive input. Menu coordinates are read from an admitted AX observation;
// no global pointer, foreground activation or user application is controlled.
it
  .skipIf(process.platform !== "darwin")
  .each(["popup", "context", "file-picker", "unframed-picker"] as const)(
  "qualifies owned %s with window-addressed background input",
  async (journey) => {
    const directory = await mkdtemp(join(tmpdir(), "cafe-glide-owned-menus-"));
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const bundle = join(directory, "OwnedMenus.app");
    const executable = join(bundle, "Contents/MacOS/OwnedMenus");
    const receiptPath = join(directory, "events");
    let owner: ReturnType<typeof spawn> | undefined;
    let ownerExit: Promise<void> | undefined;
    let runtime: GlideRuntime | undefined;
    let watcher: FSWatcher | undefined;
    let retired = false;
    let receipts: Receipt[] = [];
    let receiptError: unknown;
    let phase = "setup";
    let lastObservation = "";
    const observations: { phase: string; text: string }[] = [];
    const nativePhases: string[] = [];
    const hostedInspections: unknown[] = [];
    let hostedQualification:
      | {
          newlyBorn: number;
          dynamicNotificationObserved: boolean;
          dynamicAdmissionObserved: boolean;
        }
      | undefined;
    const artifact = async (outcome: string) => {
      if (process.env.CAFE_GLIDE_NATIVE_RECEIPTS !== "1") return;
      await mkdir(join(root, ".logs"), { recursive: true });
      await writeFile(
        join(root, `.logs/glide-owned-${journey}-receipts.json`),
        JSON.stringify(
          {
            journey,
            outcome,
            phase,
            receipts,
            nativePhases,
            hostedInspections,
            hostedQualification,
            lastObservation,
            observations,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    };
    const waiters = new Set<{
      accept: (values: Receipt[]) => boolean;
      resolve: () => void;
      reject: (error: unknown) => void;
    }>();
    const fail = (error: unknown) => {
      receiptError = error;
      for (const waiter of waiters) waiter.reject(error);
      waiters.clear();
      void runtime?.close();
    };
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        retired = true;
        watcher?.close();
        for (const waiter of waiters) waiter.reject(new Error("Owned menu fixture retired."));
        waiters.clear();
        await runtime?.close();
        if (owner && ownerExit) {
          owner.stdin?.end();
          // Native opt-in fixture retains its exact wall-clock deadline, callback and child cleanup.
          // @effect-diagnostics-next-line globalTimers:off
          const force = setTimeout(() => owner?.kill("SIGKILL"), 1500);
          try {
            await ownerExit;
          } finally {
            clearTimeout(force);
          }
        }
        await rm(directory, { recursive: true, force: true });
      })());
    onTestFinished(cleanup);
    const bounded = async <A>(promise: Promise<A>, label: string): Promise<A> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_resolve, reject) => {
            // Native opt-in fixture retains its exact wall-clock deadline, callback and child cleanup.
            // @effect-diagnostics-next-line globalTimers:off
            timer = setTimeout(() => reject(new Error(label)), 10_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const preserved = (values: Receipt[]) => {
      const initial = values[0];
      if (!initial) return;
      for (const value of values) {
        expect(value.pid).toBe(initial.pid);
        expect(value.birth).toEqual(initial.birth);
        expect(value.foreground, JSON.stringify(value)).toEqual(initial.foreground);
        expect(value.pointer, JSON.stringify(value)).toEqual(initial.pointer);
        expect(value.windowNumber).toBe(initial.windowNumber);
      }
    };
    const readReceipts = async () => {
      const text = await readFile(receiptPath, "utf8").catch(() => undefined);
      if (retired || text === undefined) return;
      const values = JSON.parse(text) as Receipt[];
      expect(Array.isArray(values) && values.length <= 128).toBe(true);
      if (values.length < receipts.length) return;
      receipts = values;
      preserved(values);
      for (const waiter of waiters)
        if (waiter.accept(values)) {
          waiters.delete(waiter);
          waiter.resolve();
        }
    };
    const until = (accept: (values: Receipt[]) => boolean) => {
      if (receiptError) return Promise.reject(receiptError);
      if (accept(receipts)) return Promise.resolve();
      const result = new Promise<void>((resolveReady, reject) => {
        waiters.add({ accept, resolve: resolveReady, reject });
      });
      void result.catch(() => undefined);
      return result;
    };
    try {
      await mkdir(dirname(executable), { recursive: true });
      await writeFile(join(directory, "Owned Choice.txt"), "private owned picker marker\n", {
        mode: 0o600,
      });
      await writeFile(
        join(bundle, "Contents/Info.plist"),
        '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.cafecode.glide-owned-menus-fixture</string><key>CFBundleExecutable</key><string>OwnedMenus</string><key>CFBundleName</key><string>OwnedMenus</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
      );
      const compiler = spawnSync(
        "xcrun",
        [
          "swiftc",
          "-target",
          `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`,
          fileURLToPath(new URL("./fixtures/glide-hosted-menu.fixture.swift", import.meta.url)),
          "-o",
          executable,
        ],
        { shell: false, timeout: 30_000, encoding: "utf8" },
      );
      expect(compiler.status, compiler.stderr).toBe(0);
      const launcher = join(directory, "Owner");
      await copyFile(executable, launcher);
      watcher = watch(directory, (_event, name) => {
        if (name === "events") void readReceipts().catch(fail);
      });
      watcher.once("error", fail);
      const ready = until((values) => values.some((value) => value.kind === "ready"));
      owner = spawn(launcher, ["--launch-owned", bundle, receiptPath], {
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
        env: {
          ...glideChildEnvironment(process.env),
          HOME: directory,
          CFFIXED_USER_HOME: directory,
          TMPDIR: directory,
          CAFE_GLIDE_UNFRAMED_ROOT: journey === "unframed-picker" ? "1" : "0",
        },
      });
      ownerExit = new Promise<void>((resolveExit, reject) => {
        owner!.once("exit", () => {
          fail(new Error("Owned menu fixture owner exited."));
          resolveExit();
        });
        owner!.once("error", reject);
      });
      void ownerExit.catch(() => undefined);
      phase = "fixture readiness";
      await bounded(ready, "Owned menu readiness deadline.");
      const initial = JSON.parse(await readFile(receiptPath + ".initial", "utf8")) as {
        foreground: Receipt["foreground"];
        pointer: Receipt["pointer"];
      };
      expect(receipts[0]!.foreground).toEqual(initial.foreground);
      expect(receipts[0]!.pointer).toEqual(initial.pointer);
      expect(receipts[0]!.pid).not.toBe(initial.foreground.pid);
      expect(
        receipts[0]!.onActiveSpace,
        "Menu/picker qualification requires an ordinary active desktop; it never joins fullscreen or switches Spaces.",
      ).toBe(true);
      runtime = new GlideRuntime({
        helperPath: join(root, "apps/desktop/native/build", process.arch, "mac-glide"),
        allowedApps: ["com.cafecode.glide-owned-menus-fixture"],
        inputMode: "background",
        onNativePhase: (value) => {
          if (nativePhases.length < 64) nativePhases.push(value);
        },
      });
      const execute = async (code: string) => {
        if (receiptError) throw receiptError;
        const result = await runtime!.execute({ code });
        if (receiptError) throw receiptError;
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
        await readReceipts();
        return result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
      };
      const observe = async () => {
        lastObservation = await execute("await app.getAXState({disableDiffing:true});");
        if (observations.length < 8) observations.push({ phase, text: lastObservation });
        return lastObservation;
      };
      const inspect = (label: string) => {
        const first = receipts[0]!;
        const inspected = spawnSync(
          executable,
          [
            "--inspect-hosted",
            String(first.pid),
            String(first.birth.seconds),
            String(first.birth.microseconds),
          ],
          {
            shell: false,
            timeout: 10_000,
            encoding: "utf8",
            env: {
              ...glideChildEnvironment(process.env),
              HOME: directory,
              CFFIXED_USER_HOME: directory,
              TMPDIR: directory,
              CAFE_GLIDE_CAPTURE_GEOMETRY: process.env.CAFE_GLIDE_CAPTURE_GEOMETRY ?? "0",
            },
          },
        );
        expect(inspected.status, inspected.stderr).toBe(0);
        const inspection = JSON.parse(inspected.stdout) as AXInspection;
        hostedInspections.push({ label, ...inspection });
        expect(inspection.root).toBe(first.pid);
        expect(inspection.birth).toEqual(first.birth);
        expect(inspection.foreground).toEqual(initial.foreground);
        expect(inspection.pointer).toEqual(initial.pointer);
        return inspection;
      };
      const element = (text: string, role: string, label: string) => {
        const line = text
          .split("\n")
          .find((value) => value.includes(role) && value.includes(label));
        const index = line?.match(/\b(\d+): AX\w+/)?.[1];
        expect(index, text).toBeDefined();
        return { index, line: line! };
      };
      const coordinates = (line: string) => {
        const bounds = line.match(/bounds=\[([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+)\]/);
        expect(bounds, line).not.toBeNull();
        const [x, y, width, height] = bounds!.slice(1).map(Number);
        expect(width! > 0 && height! > 0).toBe(true);
        return [x! + width! / 2, y! + height! / 2];
      };
      phase = "initial observation";
      lastObservation = await execute(
        `var app = await glide.getApp("com.cafecode.glide-owned-menus-fixture",{windowId:${receipts[0]!.windowNumber}}); await app.getAXState({disableDiffing:true});`,
      );
      if (journey === "popup") {
        const popup = element(lastObservation, "AXPopUpButton", "Owned popup");
        phase = "popup open";
        const opened = until((values) => values.some((value) => value.kind === "popup opened"));
        await execute(`await app.click(${popup.index});`);
        await bounded(opened, "Native popup did not open.");
        inspect("popup before native-window binding");
        phase = "popup menu observation";
        const capturedPopup = await runtime.execute({
          code: "await app.getAXStateAndScreenshot({disableDiffing:true});",
        });
        expect(capturedPopup.isError, JSON.stringify(capturedPopup.content)).not.toBe(true);
        const popupImage = capturedPopup.content.find((value) => value.type === "image");
        expect(popupImage, "Popup observation requires a real PNG as well as AX.").toBeDefined();
        if (popupImage?.type === "image" && process.env.CAFE_GLIDE_NATIVE_RECEIPTS === "1") {
          await mkdir(join(root, ".logs"), { recursive: true });
          await writeFile(
            join(root, ".logs/glide-owned-popup.png"),
            Buffer.from(popupImage.data, "base64"),
            { mode: 0o600 },
          );
        }
        await readReceipts();
        const popupState = capturedPopup.content
          .filter((value) => value.type === "text")
          .map((value) => value.text)
          .join("\n");
        lastObservation = popupState;
        inspect("popup before coordinate input");
        const two = element(popupState, "AXMenuItem", "Fixture Two");
        const [twoX, twoY] = coordinates(two.line);
        phase = "popup addressed coordinate input";
        const selected = until((values) =>
          values.some(
            (value) => value.kind === "popup selected" && value.selection === "Fixture Two",
          ),
        );
        await execute(`await app.click([${twoX},${twoY}]);`);
        await bounded(selected, "Native popup coordinate input did not select Fixture Two.");
        phase = "popup keyboard input";
        const again = element(await observe(), "AXPopUpButton", "Owned popup");
        const beforeKeyboardOpen = receipts.at(-1)!.sequence;
        const keyboardOpened = until((values) =>
          values.some(
            (value) => value.sequence > beforeKeyboardOpen && value.kind === "popup opened",
          ),
        );
        const keyboardSelection = until((values) =>
          values.some(
            (value) => value.kind === "popup selected" && value.selection === "Fixture Three",
          ),
        );
        await execute(`await app.click(${again.index});`);
        await bounded(keyboardOpened, "The keyboard popup did not reopen.");
        await observe();
        await execute('await app.pressKey("down"); await app.pressKey("enter");');
        await bounded(
          keyboardSelection,
          "Native popup keyboard input did not select Fixture Three.",
        );
        expect(receipts.some((value) => value.kind === "popup closed")).toBe(true);
      }
      if (journey === "context") {
        phase = "context menu open";
        const context = element(await observe(), "AXGroup", "Owned context area");
        const contextOpened = until((values) =>
          values.some((value) => value.kind === "context opened"),
        );
        await execute(`await app.click(${context.index},{mouseButton:"right"});`);
        await bounded(contextOpened, "Native context menu did not open.");
        phase = "context menu observation";
        const beta = element(await observe(), "AXMenuItem", "Context Beta");
        const [betaX, betaY] = coordinates(beta.line);
        const contextSelected = until((values) =>
          values.some(
            (value) =>
              value.kind === "context selected" && value.status === "context: Context Beta",
          ),
        );
        phase = "context menu addressed coordinate input";
        await execute(`await app.click([${betaX},${betaY}]);`);
        await bounded(
          contextSelected,
          "Native context coordinate input did not select Context Beta.",
        );
        expect(receipts.some((value) => value.kind === "context closed")).toBe(true);
      }
      if (journey === "file-picker" || journey === "unframed-picker") {
        phase = "owned hosted panel open";
        const panelButton = element(await observe(), "AXButton", "Open owned hosted panel");
        const panelStarted = until((values) =>
          values.some((value) => value.kind === "panel started"),
        );
        const panelStart = DateTime.toEpochMillis(DateTime.nowUnsafe());
        const panelPhaseStart = nativePhases.length;
        const openedPanel = await runtime.execute({
          code: `await app.click(${panelButton.index});`,
        });
        // A modal-opening AX call can time out after dispatch. Never replay
        // it: only the exact native panel-start receipt establishes the effect.
        if (openedPanel.isError) {
          expect(openedPanel.content).toHaveLength(2);
          const receipt = openedPanel.content[0];
          if (receipt?.type !== "text") throw new Error("Missing panel action receipt.");
          expect(
            actionReceiptSchema.parse(JSON.parse(receipt.text.slice("Glide action ".length))),
          ).toMatchObject({
            status: "uncertain",
            dispatch: "dispatched",
            progress: { axAttempted: 1, axAccepted: 0 },
            message: expect.stringContaining("Accessibility action was not confirmed"),
          });
          expect(openedPanel.content[1]).toMatchObject({
            type: "text",
            text: expect.stringContaining("Accessibility action was not confirmed"),
          });
        }
        await bounded(panelStarted, "The owned NSOpenPanel did not start.");
        await readReceipts();
        phase = "owned hosted panel AX proof";
        const panelState = await observe();
        element(panelState, "AXButton", "Cancel");
        const sheet = element(panelState, "AXSheet", "owned glide hosted panel");
        const rectangle = sheet.line
          .match(/bounds=\[([^\]]+)\]/)![1]!
          .split(",")
          .map(Number);
        const windows = JSON.parse(
          await execute(
            'nodeRepl.write(JSON.stringify(await glide.listWindows("com.cafecode.glide-owned-menus-fixture", {emit:false})));',
          ),
        ) as { id: number; bounds: { x: number; y: number; width: number; height: number } }[];
        const sheetWindows = windows.filter(({ bounds }) =>
          [bounds.x, bounds.y, bounds.width, bounds.height].every(
            (value, index) => Math.abs(value - rectangle[index]!) < 1,
          ),
        );
        expect(sheetWindows).toHaveLength(1);
        lastObservation = await execute(
          `var app = await glide.getApp("com.cafecode.glide-owned-menus-fixture", {windowId:${sheetWindows[0]!.id}}); await app.getAXState({disableDiffing:true});`,
        );
        const first = receipts[0]!;
        const inspection = inspect("hosted panel before input");
        const hosted = inspection.elements.filter(
          (value) =>
            value.logicalPID === first.pid &&
            value.actualPID !== first.pid &&
            value.actualPID > 0 &&
            value.birth.seconds > 0 &&
            value.windowId > 0 &&
            value.windowOwner === value.actualPID,
        );
        expect(hosted.length, JSON.stringify(inspection)).toBeGreaterThan(0);
        const newlyBorn = hosted.filter(
          (value) =>
            BigInt(value.birth.seconds) * 1_000_000n + BigInt(value.birth.microseconds) >=
            // Date.now floors the sampled millisecond. Only a later complete
            // millisecond proves birth after that pre-dispatch observation.
            BigInt(panelStart + 1) * 1000n,
        );
        phase = "owned hosted panel filename input";
        await execute('await app.pressKey("super+shift+g");');
        await observe();
        await execute(
          `await app.typeText(${JSON.stringify(join(directory, "Owned Choice.txt"))}); await app.pressKey("enter");`,
        );
        phase = "owned hosted panel coordinate acceptance";
        const capturedPanel = await runtime.execute({
          code: "await app.getAXStateAndScreenshot({disableDiffing:true});",
        });
        expect(capturedPanel.isError, JSON.stringify(capturedPanel.content)).not.toBe(true);
        lastObservation = capturedPanel.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        const image = capturedPanel.content.find((item) => item.type === "image");
        expect(image, "The selected native picker must supply a real PNG.").toBeDefined();
        if (image?.type === "image" && process.env.CAFE_GLIDE_NATIVE_RECEIPTS === "1")
          await writeFile(
            join(root, `.logs/glide-owned-${journey}.png`),
            Buffer.from(image.data, "base64"),
            { mode: 0o600 },
          );
        const open = element(lastObservation, "AXButton", 'title="Open"');
        expect(open.line, lastObservation).toContain("enabled=true");
        const [openX, openY] = coordinates(open.line);
        const accepted = until((values) =>
          values.some(
            (value) => value.kind === "panel completed" && value.status === "panel accepted",
          ),
        );
        await execute(`await app.click([${openX},${openY}]);`);
        await bounded(
          accepted,
          "The native hosted panel did not accept the exact private owned file.",
        );
        hostedQualification = {
          newlyBorn: new Set(
            newlyBorn.map((value) =>
              JSON.stringify([value.actualPID, value.birth.seconds, value.birth.microseconds]),
            ),
          ).size,
          dynamicNotificationObserved: nativePhases
            .slice(panelPhaseStart)
            .includes("incoming.observed"),
          dynamicAdmissionObserved: nativePhases
            .slice(panelPhaseStart)
            .includes("incoming.admitted"),
        };
        // New input-service birth does not imply a WindowServer focus-theft
        // notification. Require a real new service for this separate journey;
        // qualify callback-time admission only if that event actually occurs.
        if (journey === "unframed-picker") expect(newlyBorn.length).toBeGreaterThan(0);
        if (hostedQualification.dynamicNotificationObserved)
          expect(
            hostedQualification.dynamicAdmissionObserved,
            JSON.stringify({ nativePhases, hosted }),
          ).toBe(true);
        expect(
          nativePhases
            .slice(panelPhaseStart)
            .some((value) => value === "hosted.keyboard" || value === "hosted.pointer"),
          JSON.stringify(nativePhases),
        ).toBe(true);
      }
      await readReceipts();
      preserved(receipts);
      await artifact("passed");
      // Explicit native qualification output retains the existing stdout/stderr receipt protocol.
      // @effect-diagnostics-next-line globalConsole:off
      console.info(
        JSON.stringify({
          qualification: "glide-owned-menu-native",
          journey,
          receipts: receipts.length,
          root: { pid: receipts[0]!.pid, birth: receipts[0]!.birth },
          foreground: receipts[0]!.foreground,
          pointer: receipts[0]!.pointer,
          foregroundAndPointerPreserved: true,
        }),
      );
    } catch (error) {
      await artifact("failed");
      // Explicit native qualification output retains the existing stdout/stderr receipt protocol.
      // @effect-diagnostics-next-line globalConsole:off
      console.error(
        "Owned Glide menu qualification failed",
        JSON.stringify({ phase, receipts, lastObservation }),
      );
      throw error;
    } finally {
      await cleanup();
    }
  },
  60_000,
);
