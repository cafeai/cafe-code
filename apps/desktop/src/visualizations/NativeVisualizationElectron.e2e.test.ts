import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "tsdown";
import { expect, it, vi } from "vitest";
import { VISUALIZATION_FLUID_DIAGNOSTIC_COUNTER_MAX } from "@cafecode/shared/visualizationFluidRuntime";
import { VISUALIZATION_FONT_LICENSE } from "@cafecode/shared/visualizationFontData";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/** Explicit synthetic-artifact opt-in only. These five PNGs are captured from
 * exact generated guest documents, never a screen/parent/user window. Unknown
 * paths, replacement entries and unbounded bytes do not become output targets. */
async function retainFluidCaptures(directory: string): Promise<void> {
  const output = process.env.CAFE_CODE_VISUALIZATION_E2E_CAPTURE_DIR;
  if (output === undefined) return;
  if (!isAbsolute(output)) throw new Error("Native fixture capture output refused.");
  const parent = await lstat(output);
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new Error("Native fixture capture output refused.");
  for (const name of [
    "native-fluid-preview.png",
    "native-fluid-viewer.png",
    "native-inline-chart.png",
    "native-inline-chart-color.png",
    "native-inline-chart-motion.png",
    "native-bar-top5.png",
    "native-bar-top10.png",
    "native-bar-narrow.png",
    "native-font-preview.png",
    "native-font-viewer.png",
  ]) {
    const source = join(directory, name);
    let stat;
    try {
      stat = await lstat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 8 || stat.size > 1_048_576)
      throw new Error("Native fixture capture bytes refused.");
    const png = await readFile(source);
    if (
      png.length !== stat.size ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error("Native fixture capture bytes refused.");
    await writeFile(join(output, name), png, { flag: "wx", mode: 0o600 });
  }
}

/** A secondary evidence-publication failure must not replace the original
 * synthetic child failure. The raw child stream is retained before this runs;
 * the fixed secondary breadcrumb discloses neither output paths nor causes. */
async function retainAfterOutcome(
  retain: () => Promise<void>,
  primaryFailed: boolean,
): Promise<void> {
  try {
    await retain();
  } catch (error) {
    process.stderr.write("Native fixture capture retention: refused\n");
    if (!primaryFailed) throw error;
  }
}

/** Preserve a completed child's bounded raw stream even when validation, not
 * execFile, is the primary failure. Called only from the failed bar lane; a
 * successful run still publishes solely the fixed source-free report. */
function retainBarPrimaryStreams(
  error: unknown,
  completed?: { stdout: string; stderr: string },
): void {
  const candidate = completed ?? error;
  if (typeof candidate !== "object" || candidate === null) return;
  for (const key of ["stderr", "stdout"] as const) {
    const value = Reflect.get(candidate, key);
    if (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 65536 &&
      Buffer.byteLength(value) <= 65536
    ) {
      process.stderr.write(`Native bar primary ${key}:\n`);
      process.stderr.write(value);
    }
  }
}

it("retains bounded completed bar streams on validation failures and exec failures", () => {
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const completed = { stderr: "fixture diagnostic\n", stdout: "fixture invalid report\n" };
    retainBarPrimaryStreams(new Error("fixed validation failure"), completed);
    expect(write.mock.calls).toEqual([
      ["Native bar primary stderr:\n"],
      [completed.stderr],
      ["Native bar primary stdout:\n"],
      [completed.stdout],
    ]);
    write.mockClear();
    retainBarPrimaryStreams({ stderr: "fixture child failed\n", stdout: "" });
    expect(write.mock.calls).toEqual([
      ["Native bar primary stderr:\n"],
      ["fixture child failed\n"],
    ]);
    write.mockClear();
    retainBarPrimaryStreams({ stderr: "x".repeat(65537), stdout: "界".repeat(30000) });
    retainBarPrimaryStreams(null);
    expect(write).not.toHaveBeenCalled();
  } finally {
    write.mockRestore();
  }
});

it("does not mask the primary synthetic outcome with a secondary capture failure", async () => {
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const secondary = new Error("private capture failure sentinel");
  const retain = async () => {
    throw secondary;
  };
  try {
    await expect(retainAfterOutcome(retain, true)).resolves.toBeUndefined();
    await expect(retainAfterOutcome(retain, false)).rejects.toBe(secondary);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledWith("Native fixture capture retention: refused\n");
    expect(JSON.stringify(write.mock.calls)).not.toContain("private");
  } finally {
    write.mockRestore();
  }
});

const phases = new Set([
  "generated-preview-pixels",
  "app-preview-replay-pixels",
  "uncommitted-viewer-retired",
  "normal-document-watchdog-liveness",
  "native-exact-visibility-committed",
  "native-generated-tinycrop-menu-same-document",
  "native-view-focused",
  "native-character-delivered",
  "unicode-committed",
  "native-keyboard-selection",
  "semantic-accessibility",
  "viewer-capture-pixels",
  "native-clipped-full-viewport-zoom",
  "native-bounded-webgl-context-loss-retired",
  "native-generated-natural-height-same-document",
  "native-generated-normal-motion-frost-capture",
  "native-generated-transparent-capture",
  "native-four-viewers-fifth-preview-autofocus",
  "native-trusted-wheel-inner-scroll-modified-refusal",
  "native-hostile-sibling-continuation-expansion-retired",
  "startup-watchdog-retired",
  "active-watchdog-retired",
  "app-sdk-context-csp-consent-owner-hide-retired",
]);

/** Fixed-size, no-follow source admission for an explicit local replay. Holding
 * the descriptor and comparing the path/file identity before and after reading
 * rejects replacement races. A supplied exact SHA binds private replay bytes;
 * no live database, profile discovery or unbounded read is available here. */
async function readBoundedBarSource(
  source: string,
  expected?: { sha256: string; bytes: number },
): Promise<Buffer> {
  if (
    !isAbsolute(source) ||
    (expected &&
      (!/^[a-f0-9]{64}$/.test(expected.sha256) ||
        !Number.isSafeInteger(expected.bytes) ||
        expected.bytes < 8 ||
        expected.bytes > 32 * 1024))
  )
    throw new Error("Native bar fixture source refused.");
  const before = await lstat(source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size < 8n || before.size > 32n * 1024n)
    throw new Error("Native bar fixture source refused.");
  const handle = await open(
    source,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  const same = (value: BigIntStats) =>
    value.dev === before.dev &&
    value.ino === before.ino &&
    value.size === before.size &&
    value.mtimeNs === before.mtimeNs &&
    value.isFile();
  try {
    if (!same(await handle.stat({ bigint: true })))
      throw new Error("Native bar fixture source refused.");
    const buffer = Buffer.alloc(32 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const value = buffer.subarray(0, length);
    if (
      length !== Number(before.size) ||
      length > 32 * 1024 ||
      !same(await handle.stat({ bigint: true })) ||
      !same(await lstat(source, { bigint: true })) ||
      !Buffer.from(value.toString("utf8"), "utf8").equals(value) ||
      (expected &&
        (length !== expected.bytes ||
          createHash("sha256").update(value).digest("hex") !== expected.sha256))
    )
      throw new Error("Native bar fixture source refused.");
    return value;
  } finally {
    await handle.close();
  }
}

it("admits only bounded exact regular-file bytes for an optional local bar replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cafe-native-bar-source-"));
  try {
    const file = join(directory, "synthetic.html"),
      alias = join(directory, "alias.html");
    const value = Buffer.from("<section>Synthetic source only</section>");
    const sha256 = createHash("sha256").update(value).digest("hex");
    await writeFile(file, value, { flag: "wx", mode: 0o600 });
    await expect(readBoundedBarSource(file, { sha256, bytes: value.length })).resolves.toEqual(
      value,
    );
    await expect(
      readBoundedBarSource(file, { sha256: "0".repeat(64), bytes: value.length }),
    ).rejects.toThrow("source refused");
    await expect(readBoundedBarSource(file, { sha256, bytes: value.length + 1 })).rejects.toThrow(
      "source refused",
    );
    await expect(readBoundedBarSource(directory)).rejects.toThrow("source refused");
    try {
      await symlink(file, alias);
      await expect(readBoundedBarSource(alias)).rejects.toThrow("source refused");
    } catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM")
        throw error;
      // Native Windows may refuse creating even this fixture-owned symlink;
      // exact byte/identity/directory refusal assertions remain on every host.
    }
    const oversized = join(directory, "oversized.html");
    await writeFile(oversized, Buffer.alloc(32 * 1024 + 1), { flag: "wx", mode: 0o600 });
    await expect(readBoundedBarSource(oversized)).rejects.toThrow("source refused");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
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

// This exact synthetic projection is separate from production debug output.
// Unknown properties, arbitrary strings, nonfinite values and oversized counts
// never survive the successful-child output filter, including future mistakes.
const chartNumericBounds: Readonly<Record<string, readonly [number, number]>> = {
  selectedHeight: [0, 2000],
  selectedSequence: [0, 100000],
  latestHeight: [0, 2000],
  latestSequence: [0, 100000],
  ownerZoom: [0, 16],
  nativeWidth: [0, 1600],
  nativeHeight: [0, 2000],
  innerWidth: [0, 2000],
  innerHeight: [0, 2000],
  rootScrollHeight: [0, 4000],
  bodyTop: [-4000, 4000],
  bodyHeight: [0, 4000],
  bodyBottom: [-4000, 4000],
  paddingBottom: [0, 4000],
  unitHeight: [0, 4000],
  unitBottom: [-4000, 4000],
  footerBottom: [-4000, 4000],
  rootNodes: [0, 128],
  elementExtent: [0, 4000],
  textExtent: [0, 4000],
  naturalHeight: [0, 4000],
  canvasCSSWidth: [0, 1600],
  canvasCSSHeight: [0, 2000],
  canvasWidth: [0, 512],
  canvasHeight: [0, 512],
  frames: [0, VISUALIZATION_FLUID_DIAGNOSTIC_COUNTER_MAX],
  textures: [0, 8],
  programs: [0, 10],
  buffers: [0, 2],
  textureBytes: [0, 16 * 1024 * 1024],
};
const chartFlags = [
  "rootLimited",
  "raf",
  "nativeVisible",
  "nativeReduced",
  "documentHidden",
] as const;
function chartObservation(line: string): string | undefined {
  const prefix = "Native fixture chart snapshot: ";
  if (!line.startsWith(prefix) || line.length > 2048) return;
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(prefix.length));
  } catch {
    return;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
  const value = raw as Record<string, unknown>;
  const fields = Object.keys(chartNumericBounds).length + chartFlags.length + 2;
  const keys = Object.keys(value);
  if (
    keys.length !== fields ||
    keys.some(
      (key) =>
        key !== "boundary" &&
        key !== "state" &&
        !Object.hasOwn(chartNumericBounds, key) &&
        !chartFlags.includes(key as (typeof chartFlags)[number]),
    ) ||
    !["selected", "applied", "capture", "color"].includes(value.boundary as string) ||
    ![
      "running",
      "waiting",
      "paused",
      "static",
      "idle",
      "context-lost",
      "unsupported",
      "disposed",
      "unknown",
    ].includes(value.state as string)
  )
    return;
  const projection: Record<string, unknown> = { boundary: value.boundary };
  for (const [key, [min, max]] of Object.entries(chartNumericBounds)) {
    const scalar = value[key];
    if (
      scalar !== null &&
      (typeof scalar !== "number" || !Number.isFinite(scalar) || scalar < min || scalar > max)
    )
      return;
    projection[key] = scalar;
  }
  projection.state = value.state;
  for (const key of chartFlags) {
    if (value[key] !== null && typeof value[key] !== "boolean") return;
    projection[key] = value[key];
  }
  return `${prefix}${JSON.stringify(projection)}`;
}

function fixtureChartLine(value: Record<string, unknown>): string {
  return `Native fixture chart snapshot: ${JSON.stringify(value)}`;
}

/** Retain successful child observations before report interpretation, without
 * promoting arbitrary native/source diagnostics to public test output. Failure
 * stderr still follows execFile's unchanged rejected-command evidence path. */
function fixtureObservations(stderr: string): string {
  if (stderr.length > 65_536) return "";
  let phaseCount = 0;
  let lifecycleCount = 0;
  let chartCount = 0;
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
      continue;
    }
    const chart = chartCount < 4 ? chartObservation(line) : undefined;
    if (chart) {
      chartCount += 1;
      retained.push(chart);
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

it("retains only four exact finite source-free chart snapshots", () => {
  const snapshot: Record<string, unknown> = { boundary: "selected", state: "waiting" };
  for (const key of Object.keys(chartNumericBounds)) snapshot[key] = 0;
  for (const key of chartFlags) snapshot[key] = false;
  const admitted = chartObservation(fixtureChartLine(snapshot));
  expect(admitted).toBeDefined();
  expect(fixtureObservations(`${fixtureChartLine(snapshot)}\n`.repeat(20))).toBe(
    `${admitted}\n`.repeat(4),
  );
  for (const value of [
    { ...snapshot, source: "private source sentinel" },
    { ...snapshot, state: "private source sentinel" },
    { ...snapshot, boundary: "private source sentinel" },
    { ...snapshot, rootNodes: 129 },
    { ...snapshot, ownerZoom: "private source sentinel" },
    { ...snapshot, textureBytes: 16 * 1024 * 1024 + 1 },
    { ...snapshot, raf: "private source sentinel" },
  ])
    expect(fixtureObservations(fixtureChartLine(value))).toBe("");
  expect(
    chartObservation(fixtureChartLine({ ...snapshot, bodyTop: -1, frames: null, raf: null })),
  ).toBeDefined();
});

// No provider, network peer, inherited profile, installation or OS setting is
// required. Real native Electron process retirement stays explicitly opt-in.
it.runIf(
  process.env.CAFE_CODE_VISUALIZATION_E2E === "1" &&
    process.env.CAFE_CODE_VISUALIZATION_BAR_REPLAY !== "1" &&
    process.env.CAFE_CODE_VISUALIZATION_FONT_REPLAY !== "1",
)(
  "qualifies isolated native admission, capture and exact retirement",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cafe-native-visualization-"));
    let primaryFailed = false;
    try {
      await writeFile(
        join(directory, "natural-chart.html"),
        await readFile(
          fileURLToPath(
            new URL(
              "../../../web/src/components/visualizations/visualizationCommitChart.fixture.html",
              import.meta.url,
            ),
          ),
        ),
        { flag: "wx", mode: 0o600 },
      );
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
        clippingGeometry: "passed",
        ownerZoom: "passed",
        boundedWebGL: "passed",
        sustainedFluid: "passed",
        naturalHeight: "passed",
        normalMotionChart: "passed",
        viewerPool: "passed",
        automaticFocus: "passed",
        wheelHandoff: "passed",
        continuation: "passed",
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
    } catch (error) {
      primaryFailed = true;
      // This exact synthetic child has a scrubbed environment/private profile
      // and bounded fixed fixtures. Preserve its admitted raw command streams
      // before any capture finalizer can throw, not merely after interpretation.
      if (typeof error === "object" && error !== null) {
        for (const key of ["stderr", "stdout"] as const) {
          const value = Reflect.get(error, key);
          if (typeof value === "string" && value.length > 0 && value.length <= 65536) {
            process.stderr.write(`Native fixture primary ${key}:\n`);
            process.stderr.write(value);
          }
        }
      }
      throw error;
    } finally {
      try {
        await retainAfterOutcome(() => retainFluidCaptures(directory), primaryFailed);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  60_000,
);

it.runIf(
  process.env.CAFE_CODE_VISUALIZATION_E2E === "1" &&
    process.env.CAFE_CODE_VISUALIZATION_FONT_REPLAY !== "1",
)(
  "qualifies isolated ranked bars with full natural viewport and unchanged partial animation",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cafe-native-visualization-bars-"));
    let primaryFailed = false;
    let completed: { stdout: string; stderr: string } | undefined;
    try {
      const source = process.env.CAFE_CODE_VISUALIZATION_BAR_SOURCE;
      const sha256 = process.env.CAFE_CODE_VISUALIZATION_BAR_SOURCE_SHA256;
      const bytes = process.env.CAFE_CODE_VISUALIZATION_BAR_SOURCE_BYTES;
      const exact = source !== undefined || sha256 !== undefined || bytes !== undefined;
      if (
        exact &&
        (process.env.CAFE_CODE_VISUALIZATION_BAR_REPLAY !== "1" ||
          source === undefined ||
          sha256 === undefined ||
          bytes === undefined ||
          !/^[1-9][0-9]{0,4}$/.test(bytes))
      )
        throw new Error("Native bar fixture source refused.");
      const value = exact
        ? await readBoundedBarSource(source!, { sha256: sha256!, bytes: Number(bytes) })
        : await readBoundedBarSource(
            fileURLToPath(new URL("./visualizationBar.fixture.html", import.meta.url)),
          );
      await writeFile(join(directory, "bar-chart.html"), value, { flag: "wx", mode: 0o600 });
      for (const entry of ["./NativeVisualizationBarFixture.ts", "../visualizationPreload.ts"]) {
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
      // Identical scrubbed OS/locale/display inheritance to the comprehensive
      // fixture. The private source path/digest are never sent to the child.
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
      ])
        if (process.env[key] !== undefined) env[key] = process.env[key];
      env.HOME = directory;
      env.USERPROFILE = directory;
      env.APPDATA = directory;
      env.LOCALAPPDATA = directory;
      env.TMPDIR = directory;
      env.TEMP = directory;
      env.TMP = directory;
      completed = await execFileAsync(
        require("electron") as string,
        [join(directory, "NativeVisualizationBarFixture.cjs"), directory],
        { env, timeout: 45_000, killSignal: "SIGKILL", maxBuffer: 65_536, windowsHide: true },
      );
      const { stdout, stderr } = completed;
      // No arbitrary child strings are published on successful runs. Retain the
      // actual raw child stream only when the isolated primary outcome failed.
      if (stderr.trim().length > 0) throw new Error("Native bar fixture unexpected diagnostics.");
      const report = JSON.parse(stdout.trim()) as Record<string, unknown>;
      expect(Object.keys(report).sort()).toEqual(
        [
          "electron",
          "electronNode",
          "electronAbi",
          "platform",
          "arch",
          "bars",
          "naturalHeight",
          "horizontalFit",
          "darkTooltip",
          "partialContinuity",
          "menuContinuity",
          "tinyCropContinuity",
          "offscreenRetirement",
          "topFiveHeight",
          "topTenHeight",
          "narrowHeight",
          "genuineVisibilityReplay",
        ].sort(),
      );
      expect(report).toMatchObject({
        electron: "42.10.0",
        electronAbi: "146",
        platform: process.platform,
        arch: process.arch,
        bars: "passed",
        naturalHeight: "passed",
        horizontalFit: "passed",
        darkTooltip: "passed",
        partialContinuity: "passed",
        menuContinuity: "passed",
        tinyCropContinuity: "passed",
        offscreenRetirement: "passed",
        genuineVisibilityReplay: "authored",
      });
      expect(report.electronNode).toMatch(/^\d+\.\d+\.\d+$/);
      for (const key of ["topFiveHeight", "topTenHeight", "narrowHeight"])
        expect(
          Number.isSafeInteger(report[key]) &&
            (report[key] as number) >= 80 &&
            (report[key] as number) <= 2000,
        ).toBe(true);
      if (exact)
        await expect(
          readBoundedBarSource(source!, { sha256: sha256!, bytes: Number(bytes) }),
        ).resolves.toEqual(value);
      process.stdout.write(
        `Native bar qualification (${exact ? "exact-local" : "synthetic"}): ${JSON.stringify(report)}\n`,
      );
    } catch (error) {
      primaryFailed = true;
      retainBarPrimaryStreams(error, completed);
      throw error;
    } finally {
      try {
        await retainAfterOutcome(() => retainFluidCaptures(directory), primaryFailed);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  60_000,
);

/** Explicit synthetic-only font proof is separate from the comprehensive and
 * private-source bar lanes. All original native budgets and process policies
 * stay unchanged; no font/profile input is accepted from the environment. */
it.runIf(
  process.env.CAFE_CODE_VISUALIZATION_E2E === "1" &&
    process.env.CAFE_CODE_VISUALIZATION_FONT_REPLAY === "1",
)(
  "qualifies loaded binary chat faces and generated-only user-origin typography under native CSP",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cafe-native-visualization-fonts-"));
    let primaryFailed = false;
    let completed: { stdout: string; stderr: string } | undefined;
    try {
      for (const entry of ["./NativeVisualizationFontFixture.ts", "../visualizationPreload.ts"]) {
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
      // Inspect the actual native preload without executing it: the full fixed
      // license must survive bundling, while the unused portable export CSS
      // must not allocate a second payload merely because native imports the
      // loader. Runtime font admission independently hashes that full notice.
      const emittedPreload = await readFile(join(directory, "visualizationPreload.cjs"), "utf8");
      expect(emittedPreload).toContain(JSON.stringify(VISUALIZATION_FONT_LICENSE).slice(1, -1));
      expect(emittedPreload).not.toContain("data-cafe-chat-typography");
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
      ])
        if (process.env[key] !== undefined) env[key] = process.env[key];
      env.HOME = directory;
      env.USERPROFILE = directory;
      env.APPDATA = directory;
      env.LOCALAPPDATA = directory;
      env.TMPDIR = directory;
      env.TEMP = directory;
      env.TMP = directory;
      completed = await execFileAsync(
        require("electron") as string,
        [join(directory, "NativeVisualizationFontFixture.cjs"), directory],
        { env, timeout: 45_000, killSignal: "SIGKILL", maxBuffer: 65_536, windowsHide: true },
      );
      if (completed.stderr.trim().length > 0)
        throw new Error("Native font fixture unexpected diagnostics.");
      const report = JSON.parse(completed.stdout.trim()) as Record<string, unknown>;
      expect(Object.keys(report).sort()).toEqual(
        [
          "electron",
          "electronNode",
          "electronAbi",
          "platform",
          "arch",
          "binaryFaces",
          "parseReady",
          "userOriginPolicy",
          "authoredMetrics",
          "semanticMono",
          "generatedPreview",
          "appExclusion",
          "naturalFit",
          "fontReadyCapture",
          "retirement",
          "fullHeight",
          "narrowHeight",
        ].sort(),
      );
      expect(report).toMatchObject({
        electron: "42.10.0",
        electronAbi: "146",
        platform: process.platform,
        arch: process.arch,
        binaryFaces: "passed",
        parseReady: "passed",
        userOriginPolicy: "passed",
        authoredMetrics: "passed",
        semanticMono: "passed",
        generatedPreview: "passed",
        appExclusion: "passed",
        naturalFit: "passed",
        fontReadyCapture: "passed",
        retirement: "passed",
      });
      expect(report.electronNode).toMatch(/^\d+\.\d+\.\d+$/);
      for (const key of ["fullHeight", "narrowHeight"])
        expect(
          Number.isSafeInteger(report[key]) &&
            (report[key] as number) >= 80 &&
            (report[key] as number) <= 2000,
        ).toBe(true);
      expect((report.narrowHeight as number) > (report.fullHeight as number)).toBe(true);
      process.stdout.write(`Native font qualification: ${JSON.stringify(report)}\n`);
    } catch (error) {
      primaryFailed = true;
      retainBarPrimaryStreams(error, completed);
      throw error;
    } finally {
      try {
        await retainAfterOutcome(() => retainFluidCaptures(directory), primaryFailed);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  60_000,
);
