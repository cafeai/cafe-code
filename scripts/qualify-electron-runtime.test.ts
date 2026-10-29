// Host-native path spelling must agree with the existing native file and tool boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  electronQualificationEnvironment,
  isElectronQualificationEntryPoint,
  resolveElectronQualificationExecutable,
  validateElectronQualificationPins,
  validateElectronRuntimeReport,
} from "./qualify-electron-runtime.ts";

// The default graph deliberately tests pure boundaries only. Actual installed
// Electron execution belongs to the explicitly selected standalone command in
// CI, not an ambient process/native-runtime assumption in a unit fixture.
const validReport = {
  electron: "43.8.4",
  node: "24.22.1",
  modules: "148",
  undici: "7.30.1",
  brotliBlockSwitch: -17,
};
const isolatedRoot = join(tmpdir(), "cafe-electron-pure-environment-fixture");

describe("installed Electron qualification validation", () => {
  it("requires the three exact synchronized and reviewed package declarations", () => {
    expect(
      validateElectronQualificationPins({
        desktop: "43.8.4",
        server: "43.8.4",
        packaging: "43.8.4",
      }),
    ).toBe("43.8.4");
    for (const field of ["desktop", "server", "packaging"] as const) {
      for (const invalid of [undefined, null, "42.11.15", "43.8.3", "^43.8.4", "44.10.0"]) {
        expect(() =>
          validateElectronQualificationPins({
            desktop: "43.8.4",
            server: "43.8.4",
            packaging: "43.8.4",
            [field]: invalid,
          }),
        ).toThrow(/All three Electron declarations/u);
      }
    }
    expect(() =>
      validateElectronQualificationPins({
        desktop: "42.10.0",
        server: "42.10.0",
        packaging: "42.10.0",
      }),
    ).toThrow(/reviewed 43\.8\.4/u);
  });

  it("verifies actual Electron, bundled Node floor and native ABI rather than standalone Node", () => {
    expect(validateElectronRuntimeReport(JSON.stringify(validReport))).toEqual(validReport);
    for (const node of ["24.22.2", "24.23.0"]) {
      expect(validateElectronRuntimeReport(JSON.stringify({ ...validReport, node })).node).toBe(
        node,
      );
    }
    for (const electron of ["42.11.15", "43.8.3"]) {
      expect(() =>
        validateElectronRuntimeReport(JSON.stringify({ ...validReport, electron })),
      ).toThrow(/Installed Electron/u);
    }
    expect(() =>
      validateElectronRuntimeReport(JSON.stringify({ ...validReport, modules: "146" })),
    ).toThrow(/unqualified native addon ABI/u);
    for (const node of [
      "24.13.1",
      "24.18.0",
      "24.18.1",
      "24.18.99",
      "24.22.0",
      "23.99.99",
      "25.0.0",
      "26.0.0",
      "24.19.0-beta.1",
      "v24.19.0",
      "024.19.0",
      "24.9007199254740992.0",
      "not a version",
    ]) {
      expect(() => validateElectronRuntimeReport(JSON.stringify({ ...validReport, node }))).toThrow(
        /Bundled Node/u,
      );
    }
  });

  it("rejects unqualified bundled Undici and missing or incorrect Brotli fix markers", () => {
    for (const undici of ["7.30.0", "8.12.2", "", undefined]) {
      expect(() =>
        validateElectronRuntimeReport(JSON.stringify({ ...validReport, undici })),
      ).toThrow();
    }
    for (const brotliBlockSwitch of [undefined, null, -16, 17, "-17"]) {
      expect(() =>
        validateElectronRuntimeReport(JSON.stringify({ ...validReport, brotliBlockSwitch })),
      ).toThrow();
    }
  });

  it("rejects malformed, noisy, overlarge or extra-field native reports without echoing their content", () => {
    for (const invalid of [
      "",
      "not JSON",
      JSON.stringify(validReport) + "\nextra output",
      "x".repeat(4097),
      "null",
      "[]",
      "{}",
      JSON.stringify({ ...validReport, modules: 146 }),
      JSON.stringify({ ...validReport, extra: "private path" }),
    ]) {
      expect(() => validateElectronRuntimeReport(invalid)).toThrow();
      try {
        validateElectronRuntimeReport(invalid);
      } catch (error) {
        expect(String(error)).not.toContain("private path");
        expect(String(error)).not.toContain("not JSON");
      }
    }
  });
});

describe("isolated Electron qualification environment", () => {
  const inherited: NodeJS.ProcessEnv = {
    HOME: "real profile",
    USERPROFILE: "real profile",
    PATH: "provider and user commands",
    NODE_OPTIONS: "--import=user-hook",
    NODE_PATH: "user module search",
    CODEX_HOME: "provider credentials",
    CLAUDE_CONFIG_DIR: "provider credentials",
    ANTHROPIC_API_KEY: "private credential",
    CAFE_CODE_BOOTSTRAP_TOKEN: "private capability",
    ELECTRON_RUN_AS_NODE: "0",
    ELECTRON_EXTRA_LAUNCH_ARGS: "--no-sandbox",
    LD_PRELOAD: "untrusted loader",
    DYLD_INSERT_LIBRARIES: "untrusted loader",
    SystemRoot: "system directory",
    WINDIR: "system directory",
  };

  it.each(["darwin", "linux"] as const)(
    "does not inherit credentials, profiles, loader overrides or Windows variables on %s",
    (platform) => {
      const environment = electronQualificationEnvironment(inherited, isolatedRoot, platform);
      expect(environment).toEqual({
        ELECTRON_RUN_AS_NODE: "1",
        HOME: join(isolatedRoot, "home"),
        USERPROFILE: join(isolatedRoot, "home"),
        APPDATA: join(isolatedRoot, "config"),
        LOCALAPPDATA: join(isolatedRoot, "local"),
        XDG_CONFIG_HOME: join(isolatedRoot, "config"),
        XDG_CACHE_HOME: join(isolatedRoot, "cache"),
        XDG_DATA_HOME: join(isolatedRoot, "data"),
        TMP: join(isolatedRoot, "temp"),
        TEMP: join(isolatedRoot, "temp"),
        TMPDIR: join(isolatedRoot, "temp"),
      });
      expect(inherited.HOME).toBe("real profile");
    },
  );

  it("retains only case-insensitive Windows system-directory entries, never PATH or Node hooks", () => {
    const environment = electronQualificationEnvironment(
      {
        ...inherited,
        SystemRoot: undefined,
        WINDIR: undefined,
        SYSTEMROOT: "system root",
        windir: "windows directory",
        Path: "untrusted path",
        node_options: "--import=user-hook",
      },
      isolatedRoot,
      "win32",
    );
    expect(environment).toEqual({
      ...electronQualificationEnvironment({}, isolatedRoot, "linux"),
      SystemRoot: "system root",
      WINDIR: "windows directory",
    });
    expect(electronQualificationEnvironment({}, isolatedRoot, "win32")).not.toHaveProperty(
      "SystemRoot",
    );
  });

  it("rejects a relative temporary scope", () => {
    expect(() => electronQualificationEnvironment({}, "relative", "linux")).toThrow(
      /absolute temporary root/u,
    );
  });
});

describe("portable opt-in entrypoint", () => {
  it("runs only for the actual script and handles URL-escaped native paths", () => {
    const script = resolve(isolatedRoot, "directory with spaces", "qualify-electron-runtime.ts");
    const url = pathToFileURL(script).href;
    expect(isElectronQualificationEntryPoint(url, script)).toBe(true);
    expect(isElectronQualificationEntryPoint(url, undefined)).toBe(false);
    expect(isElectronQualificationEntryPoint(url, resolve(isolatedRoot, "unit.test.ts"))).toBe(
      false,
    );
  });

  it("admits only the installed host-native executable metadata without loader overrides or download", () => {
    for (const [platform, nativeRelativePath] of [
      ["darwin", "Electron.app/Contents/MacOS/Electron"],
      ["win32", "electron.exe"],
      ["linux", "electron"],
    ] as const) {
      expect(
        resolveElectronQualificationExecutable(isolatedRoot, nativeRelativePath, platform),
      ).toBe(join(isolatedRoot, "dist", nativeRelativePath));
      for (const invalid of [
        "",
        "../external-executable",
        "/external-executable",
        "C:\\external.exe",
        nativeRelativePath + "\n",
        "other-executable",
      ]) {
        expect(() =>
          resolveElectronQualificationExecutable(isolatedRoot, invalid, platform),
        ).toThrow(/metadata is not qualified/u);
      }
    }
    expect(() => resolveElectronQualificationExecutable("relative", "electron", "linux")).toThrow();
    expect(() =>
      resolveElectronQualificationExecutable(isolatedRoot, "electron", "freebsd"),
    ).toThrow();
  });
});
