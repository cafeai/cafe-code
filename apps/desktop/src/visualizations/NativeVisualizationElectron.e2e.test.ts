import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "tsdown";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const phases = new Set([
  "generated-preview-pixels",
  "app-preview-replay-pixels",
  "uncommitted-viewer-retired",
  "normal-document-watchdog-liveness",
  "native-exact-visibility-committed",
  "native-view-focused",
  "native-character-delivered",
  "unicode-committed",
  "native-keyboard-selection",
  "semantic-accessibility",
  "viewer-capture-pixels",
  "startup-watchdog-retired",
  "active-watchdog-retired",
  "app-sdk-context-csp-consent-owner-hide-retired",
]);
const lifecycleLabels = new Set([
  "owner-native-hide",
  "owner-native-show",
  "owner-native-minimize",
  "owner-native-closed",
  "owner-native-focus",
  "owner-native-blur",
  "owner-js-hide",
  "owner-js-show",
  "app-js-hide",
  "app-native-active",
  "app-native-inactive",
]);

/** Retain successful child observations before report interpretation, without
 * promoting arbitrary native/source diagnostics to public test output. Failure
 * stderr still follows execFile's unchanged rejected-command evidence path. */
function fixtureObservations(stderr: string): string {
  if (stderr.length > 65_536) return "";
  let phaseCount = 0;
  let lifecycleCount = 0;
  const retained: string[] = [];
  const phasePrefix = "Native fixture phase: ";
  for (const line of stderr.split(/\r?\n/)) {
    if (line.length > 2_048) continue;
    const phase = line.startsWith(phasePrefix) ? line.slice(phasePrefix.length) : undefined;
    if (phase && phases.has(phase) && phaseCount < 32) {
      phaseCount += 1;
      retained.push(line);
      continue;
    }
    // Match only this exact fixed scalar projection. No JSON parser, error
    // payload, private ID, path, stack, source or arbitrary property is emitted.
    const lifecycle =
      /^Native fixture lifecycle: \{"label":"([a-z-]+)","appHidden":(?:true|false),"appActive":(?:true|false),"ownerVisible":(?:true|false),"ownerMinimized":(?:true|false),"ownerDestroyed":(?:true|false)\}$/.exec(
        line,
      );
    if (lifecycle && lifecycleLabels.has(lifecycle[1]!) && lifecycleCount < 64) {
      lifecycleCount += 1;
      retained.push(line);
    }
  }
  return retained.length ? `${retained.join("\n")}\n` : "";
}

it("retains only bounded fixed native fixture lifecycle observations", () => {
  const phase = "Native fixture phase: startup-watchdog-retired";
  const lifecycle =
    'Native fixture lifecycle: {"label":"owner-native-hide","appHidden":false,"appActive":true,"ownerVisible":false,"ownerMinimized":false,"ownerDestroyed":false}';
  expect(fixtureObservations(`${phase}\r\n${lifecycle}\n`)).toBe(`${phase}\n${lifecycle}\n`);
  expect(
    fixtureObservations(
      [
        "Native fixture phase: private-source-sentinel",
        lifecycle.replace("owner-native-hide", "private-source-sentinel"),
        lifecycle.replace('"appHidden":false', '"appHidden":"private JSON"'),
        lifecycle.replace("}", ',"source":"private source sentinel"}'),
        "Native fixture owned status: private bytes",
        "[native arbitrary diagnostic] private payload",
      ].join("\n"),
    ),
  ).toBe("");
  expect(fixtureObservations(`${lifecycle}\n`.repeat(100))).toBe(`${lifecycle}\n`.repeat(64));
  expect(fixtureObservations(`${phase}\n`.repeat(100))).toBe(`${phase}\n`.repeat(32));
  expect(fixtureObservations("x".repeat(65_537))).toBe("");
});

// No provider, network peer, inherited profile, installation or OS setting is
// required. Real native Electron process retirement stays explicitly opt-in.
it.runIf(process.env.CAFE_CODE_VISUALIZATION_E2E === "1")(
  "qualifies isolated native admission, capture and exact retirement",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cafe-native-visualization-"));
    try {
      for (const entry of ["./NativeVisualizationFixture.ts", "../visualizationPreload.ts"]) {
        await build({
          config: false,
          entry: [fileURLToPath(new URL(entry, import.meta.url))],
          outDir: directory,
          format: "cjs",
          outExtensions: () => ({ js: ".cjs" }),
          clean: false,
          deps: {
            alwaysBundle: (id) => id !== "electron" && !id.startsWith("node:"),
            neverBundle: ["electron"],
          },
        });
      }
      // Synthetic adversarial source receives no inherited provider secrets,
      // auth homes, loader hooks or user-selected Electron runtime switches.
      // Only OS loader, locale and the existing disposable display survive.
      const env: NodeJS.ProcessEnv = {};
      for (const key of [
        "SystemRoot",
        "WINDIR",
        "SystemDrive",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TZ",
        "DISPLAY",
        "XAUTHORITY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
      ]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      env.HOME = directory;
      env.USERPROFILE = directory;
      env.APPDATA = directory;
      env.LOCALAPPDATA = directory;
      env.TMPDIR = directory;
      env.TEMP = directory;
      env.TMP = directory;
      const { stdout, stderr } = await execFileAsync(
        require("electron") as string,
        [join(directory, "NativeVisualizationFixture.cjs"), directory],
        { env, timeout: 45_000, killSignal: "SIGKILL", maxBuffer: 65_536, windowsHide: true },
      );
      process.stderr.write(fixtureObservations(stderr));
      const report = JSON.parse(stdout.trim()) as Record<string, unknown>;
      expect(report).toMatchObject({
        electron: "42.10.0",
        platform: process.platform,
        arch: process.arch,
        preview: "passed",
        appPreviewReplay: "passed",
        viewer: "passed",
        visibilityCommit: "passed",
        nativeInput: "passed",
        semanticAccessibility: "passed",
        sameDocument: "passed",
        capture: "passed",
        retirement: "passed",
        ownerHide: "passed",
        appTransport: "passed",
        context: "passed",
        csp: "passed",
        consent: "passed",
        watchdog: "passed",
      });
      expect(report.electronNode).toMatch(/^\d+\.\d+\.\d+$/);
      expect(report.electronAbi).toBe("146");
      // Retain only fixed fixture outcomes and native runtime provenance. No
      // source, profile path, bridge credential or received private JSON is logged.
      process.stdout.write(`Native visualization qualification: ${JSON.stringify(report)}\n`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
