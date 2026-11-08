import { createHash } from "node:crypto";
// Native fixture boundary: exercise actual filesystem and host-path identity semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
// Native fixture boundary: exercise actual filesystem and host-path identity semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from "node:zlib";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, onTestFailed, vi } from "vitest";

// The native fixture filesystem and crypto remain real. Observe only guard IO
// to prove that invalid receipts cannot cause payload hashing before admission.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync), renameSync: vi.fn(actual.renameSync) };
});
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});
vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return {
    ...actual,
    brotliDecompressSync: vi.fn(actual.brotliDecompressSync),
    gunzipSync: vi.fn(actual.gunzipSync),
  };
});

import {
  APPLICATION_BUILD_VERSION_MANIFEST_FILENAME,
  ApplicationBuildVersionError,
  publishApplicationBuildVersionManifest,
  resolveApplicationBuildVersion,
  verifyApplicationBuildVersionManifest,
} from "./applicationBuildVersion.ts";

const temporary: string[] = [];
interface TestManifest {
  readonly version: number;
  readonly component: "web" | "server";
  readonly applicationVersion: string;
  readonly files: readonly {
    readonly file: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
}
function output(files: Readonly<Record<string, string | Uint8Array>>, onFileWritten?: () => void) {
  const root = mkdtempSync(join(tmpdir(), "cafe-build-version-"));
  temporary.push(root);
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), bytes);
    onFileWritten?.();
  }
  return { root, files, manifest: join(root, APPLICATION_BUILD_VERSION_MANIFEST_FILENAME) };
}
function web() {
  return output({
    "index.html": '<script type="module" src="./assets/app.js"></script>\n',
    "assets/app.js": 'export const title = "日本語";\n',
  });
}
function manifestOf(fixture: ReturnType<typeof output>): TestManifest {
  return JSON.parse(readFileSync(fixture.manifest, "utf8")) as TestManifest;
}
function tamper(
  fixture: ReturnType<typeof output>,
  transform: (manifest: TestManifest) => unknown,
) {
  writeFileSync(fixture.manifest, JSON.stringify(transform(manifestOf(fixture))));
}
afterEach(() => {
  vi.clearAllMocks();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("application build version", () => {
  it.each(["0.2.2", "0.2.3-nightly.20261019.1", "9.9.9-smoke.0", "1.2.3-rc.1+build.001"])(
    "preserves an exact supported SemVer %s instead of a stale package fallback",
    (version) => expect(resolveApplicationBuildVersion(` ${version} `, "0.2.1")).toBe(version),
  );

  it.each([undefined, "", " \n\t "])(
    "uses a validated fallback for omitted override %s",
    (version) => {
      expect(resolveApplicationBuildVersion(version, "0.2.1")).toBe("0.2.1");
    },
  );

  it.each([
    "v0.2.2",
    "0.2",
    "01.2.3",
    "1.2.3-01",
    "1.2.3-",
    "1.2.3+",
    "1.2.3\nsecret",
    "9".repeat(129),
  ])("rejects a nonblank invalid override %s without falling back", (version) =>
    expect(() => resolveApplicationBuildVersion(version, "0.2.1")).toThrow(
      ApplicationBuildVersionError,
    ),
  );

  it("rejects invalid fallback and unsafe numeric version components", () => {
    expect(() => resolveApplicationBuildVersion(undefined, "not-a-version")).toThrow(
      ApplicationBuildVersionError,
    );
    expect(() => resolveApplicationBuildVersion("9007199254740992.0.0", "0.2.1")).toThrow(
      ApplicationBuildVersionError,
    );
  });

  it("binds UTF8 HTML/JavaScript bytes and binary bundler output without executing it", () => {
    const files = {
      "index.html": "<h1>Cafe</h1>\n",
      "assets/app.js": new TextEncoder().encode('export const message = "日本語";\n'),
    };
    const fixture = output(files);
    publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", files);
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).not.toThrow();
    const receipt = manifestOf(fixture);
    expect(receipt).toMatchObject({ version: 1, component: "web", applicationVersion: "0.2.2" });
    expect(receipt.files.find((entry: { file: string }) => entry.file === "assets/app.js")).toEqual(
      {
        file: "assets/app.js",
        bytes: files["assets/app.js"].byteLength,
        sha256: createHash("sha256").update(files["assets/app.js"]).digest("hex"),
      },
    );
  });

  it("admits a realistic split web closure larger than the legacy256-file bound", (context) => {
    // A synchronous outer timeout reports no internal blocked phase. Retain
    // only bounded passive call-site/return observations on failure; these are
    // not readiness proofs and do not identify an earlier timeout's cause.
    type Phase =
      | "files-prepared"
      | "fixture-start"
      | "fixture-file-written"
      | "fixture-returned"
      | "publish-start"
      | "publish-returned"
      | "verify-start"
      | "verify-returned";
    const start = performance.now();
    const observations: {
      readonly phase: Phase;
      readonly elapsedMs: number;
      readonly written: number;
      readonly opens: number;
      readonly hashes: number;
    }[] = [];
    let written = 0;
    let recording = true;
    const bounded = (count: number) => Math.max(0, Math.min(4096, count));
    const record = (phase: Phase) => {
      if (!recording || observations.length >= 16) return;
      const elapsed = performance.now() - start;
      observations.push({
        phase,
        elapsedMs: Number.isFinite(elapsed)
          ? Math.max(0, Math.min(86_400_000, Math.round(elapsed)))
          : 0,
        written: bounded(written),
        opens: bounded(vi.mocked(openSync).mock.calls.length),
        hashes: bounded(vi.mocked(createHash).mock.calls.length),
      });
    };
    const retire = () => {
      recording = false;
    };
    // Registration precedes all fixture IO. Do not retain filenames, file
    // contents, hashes, mock arguments, environment or received error objects.
    context.signal.addEventListener("abort", retire, { once: true });
    context.onTestFinished(() => {
      retire();
      context.signal.removeEventListener("abort", retire);
    });
    onTestFailed(() => {
      // Print only snapshots captured before mock cleanup, never reread mock
      // arguments or cleared histories from a later lifecycle phase.
      Effect.runSync(
        Effect.logError("Synthetic build-version closure passive phases", { observations }),
      );
    });
    if (context.signal.aborted) retire();
    const files: Record<string, string> = { "index.html": "<h1>Cafe</h1>" };
    for (let index = 0; index < 300; index++)
      files[`assets/part-${index}.js`] = `export const part = ${index};\n`;
    record("files-prepared");
    record("fixture-start");
    const fixture = output(files, () => {
      written += 1;
      if (written % 64 === 0 || written === 301) record("fixture-file-written");
    });
    record("fixture-returned");
    record("publish-start");
    publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", files);
    record("publish-returned");
    record("verify-start");
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).not.toThrow();
    record("verify-returned");
  });

  it.each(["0.2.2", "0.2.3-nightly.20261019.1"])(
    "verifies the exact preferred gzip and Brotli HTTP bytes for %s",
    (version) => {
      const fixture = web();
      // Publication precedes the existing compression script; adding valid
      // sidecars later must not require rewriting or trusting another manifest.
      publishApplicationBuildVersionManifest(fixture.root, "web", version, fixture.files);
      for (const [name, bytes] of Object.entries(fixture.files)) {
        writeFileSync(join(fixture.root, `${name}.gz`), gzipSync(bytes));
        writeFileSync(join(fixture.root, `${name}.br`), brotliCompressSync(bytes));
      }
      expect(() =>
        verifyApplicationBuildVersionManifest(fixture.root, "web", version),
      ).not.toThrow();
      expect(gunzipSync).toHaveBeenCalledWith(expect.any(Buffer), {
        maxOutputLength: Buffer.byteLength(fixture.files["index.html"]!),
      });
      expect(brotliDecompressSync).toHaveBeenCalledWith(expect.any(Buffer), {
        maxOutputLength: Buffer.byteLength(fixture.files["assets/app.js"]!),
      });
    },
  );

  it.each(["br", "gz"] as const)(
    "refuses stale %s content even when every raw byte and manifest still match",
    (encoding) => {
      const fixture = web();
      publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", fixture.files);
      const bytes = readFileSync(join(fixture.root, "assets/app.js"));
      const stale = Buffer.from(bytes);
      stale[0] = stale[0]! ^ 1;
      writeFileSync(
        join(fixture.root, `assets/app.js.${encoding}`),
        encoding === "br" ? brotliCompressSync(stale) : gzipSync(stale),
      );
      expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).toThrow(
        ApplicationBuildVersionError,
      );
    },
  );

  it.each(["br", "gz"] as const)(
    "refuses corrupt preferred %s content without changing output",
    (encoding) => {
      const fixture = web();
      publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", fixture.files);
      const invalid = Buffer.from("not a compressed application");
      const filename = join(fixture.root, `index.html.${encoding}`);
      writeFileSync(filename, invalid);
      expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).toThrow(
        ApplicationBuildVersionError,
      );
      expect(readFileSync(filename)).toEqual(invalid);
    },
  );

  it.each(["br", "gz"] as const)(
    "limits native %s expansion to the exact recorded raw length",
    (encoding) => {
      const fixture = web();
      publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", fixture.files);
      const expanded = Buffer.alloc(256 * 1024, 65);
      writeFileSync(
        join(fixture.root, `index.html.${encoding}`),
        encoding === "br" ? brotliCompressSync(expanded) : gzipSync(expanded),
      );
      expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).toThrow(
        ApplicationBuildVersionError,
      );
      const decompressor = encoding === "br" ? brotliDecompressSync : gunzipSync;
      expect(decompressor).toHaveBeenCalledWith(expect.any(Buffer), {
        maxOutputLength: Buffer.byteLength(fixture.files["index.html"]!),
      });
    },
  );

  it("admits compressed empty output only when decoding remains exactly empty", () => {
    const fixture = output({ "index.html": "", "app.js": "export const version = '0.2.2';\n" });
    publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", fixture.files);
    writeFileSync(join(fixture.root, "index.html.br"), brotliCompressSync(Buffer.alloc(0)));
    writeFileSync(join(fixture.root, "index.html.gz"), gzipSync(Buffer.alloc(0)));
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).not.toThrow();
    expect(gunzipSync).toHaveBeenCalledWith(expect.any(Buffer), { maxOutputLength: 1 });
    writeFileSync(join(fixture.root, "index.html.gz"), gzipSync("x"));
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).toThrow(
      ApplicationBuildVersionError,
    );
  });

  it("refuses an oversized sidecar before hashing or reading any candidate payload", () => {
    const fixture = web();
    publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", fixture.files);
    const filename = join(fixture.root, "index.html.gz");
    writeFileSync(filename, "");
    // A sparse fixture exercises native metadata refusal without allocating or
    // writing a128MiB buffer, and the verifier must never read this sparse file.
    truncateSync(filename, 128 * 1024 * 1024 + 1);
    vi.clearAllMocks();
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).toThrow(
      ApplicationBuildVersionError,
    );
    expect(createHash).not.toHaveBeenCalled();
    expect(gunzipSync).not.toHaveBeenCalled();
    expect(vi.mocked(openSync).mock.calls.map(([name]) => name)).toEqual([fixture.manifest]);
  });

  it("applies a combined raw/sidecar aggregate budget before any payload work", () => {
    const fixture = web();
    publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", fixture.files);
    for (const name of ["assets/app.js.br", "index.html.gz"]) {
      const filename = join(fixture.root, name);
      writeFileSync(filename, "");
      truncateSync(filename, 128 * 1024 * 1024);
    }
    vi.clearAllMocks();
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).toThrow(
      ApplicationBuildVersionError,
    );
    expect(createHash).not.toHaveBeenCalled();
    expect(gunzipSync).not.toHaveBeenCalled();
    expect(brotliDecompressSync).not.toHaveBeenCalled();
    expect(vi.mocked(openSync).mock.calls.map(([name]) => name)).toEqual([fixture.manifest]);
  });

  it("refuses a hard-linked sidecar before reading candidate content", () => {
    const fixture = web();
    publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", fixture.files);
    const filename = join(fixture.root, "index.html.gz");
    writeFileSync(filename, gzipSync(fixture.files["index.html"]!));
    linkSync(filename, join(fixture.root, "sidecar-alias"));
    vi.clearAllMocks();
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).toThrow(
      ApplicationBuildVersionError,
    );
    expect(createHash).not.toHaveBeenCalled();
  });

  it("refuses a linked compressed HTTP representation", (context) => {
    const fixture = web();
    publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", fixture.files);
    writeFileSync(join(fixture.root, "sidecar-target"), gzipSync(fixture.files["index.html"]!));
    try {
      symlinkSync(join(fixture.root, "sidecar-target"), join(fixture.root, "index.html.gz"));
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        error.code === "EPERM"
      ) {
        context.skip();
        return;
      }
      throw error;
    }
    vi.clearAllMocks();
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).toThrow(
      ApplicationBuildVersionError,
    );
    expect(createHash).not.toHaveBeenCalled();
  });

  it("requires both server executable entries and refuses another component or version", () => {
    const fixture = output({
      "bin.mjs": "export const bin = true;\n",
      "launcher.mjs": "export const launcher = true;\n",
    });
    publishApplicationBuildVersionManifest(fixture.root, "server", "0.2.2", fixture.files);
    expect(() =>
      verifyApplicationBuildVersionManifest(fixture.root, "server", "0.2.2"),
    ).not.toThrow();
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).toThrow(
      ApplicationBuildVersionError,
    );
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "server", "0.2.1")).toThrow(
      ApplicationBuildVersionError,
    );
    expect(() =>
      publishApplicationBuildVersionManifest(fixture.root, "server", "0.2.2", {
        "bin.mjs": fixture.files["bin.mjs"]!,
      }),
    ).toThrow(ApplicationBuildVersionError);
  });

  it("requires a web entry and at least one emitted JavaScript payload", () => {
    const fixture = web();
    expect(() =>
      publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", {
        "index.html": fixture.files["index.html"]!,
      }),
    ).toThrow(ApplicationBuildVersionError);
    expect(() =>
      publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", {
        "assets/app.js": fixture.files["assets/app.js"]!,
      }),
    ).toThrow(ApplicationBuildVersionError);
    expect(existsSync(fixture.manifest)).toBe(false);
  });

  it.each(["index.html", "assets/app.js"])("rejects same-length changed %s bytes", (name) => {
    const fixture = web();
    publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", fixture.files);
    const original = readFileSync(join(fixture.root, name));
    const changed = Buffer.from(original);
    changed[0] = changed[0]! ^ 1;
    writeFileSync(join(fixture.root, name), changed);
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).toThrow(
      ApplicationBuildVersionError,
    );
  });

  it("rejects a missing payload and an absent/old manifest", () => {
    const fixture = web();
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).toThrow(
      ApplicationBuildVersionError,
    );
    publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", fixture.files);
    tamper(fixture, (receipt) => ({ ...receipt, version: 0 }));
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).toThrow(
      ApplicationBuildVersionError,
    );
    publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", fixture.files);
    rmSync(join(fixture.root, "assets/app.js"));
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).toThrow(
      ApplicationBuildVersionError,
    );
  });

  it("never blesses stale on-disk code as the successful bundler output", () => {
    const fixture = web();
    publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", fixture.files);
    const previous = readFileSync(fixture.manifest, "utf8");
    expect(() =>
      publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.3", {
        ...fixture.files,
        "assets/app.js": 'export const title = "English";\n',
      }),
    ).toThrow(ApplicationBuildVersionError);
    expect(readFileSync(fixture.manifest, "utf8")).toBe(previous);
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).not.toThrow();
  });

  it("atomically replaces an earlier successful receipt and preserves it if rename fails", () => {
    const fixture = web();
    publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", fixture.files);
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("Private native rename failure");
    });
    expect(() =>
      publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.3", fixture.files),
    ).toThrow(ApplicationBuildVersionError);
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).not.toThrow();
    expect(readdirSync(fixture.root).some((name) => name.endsWith(".tmp"))).toBe(false);
    publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.3", fixture.files);
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.3")).not.toThrow();
  });

  it.each([
    "../outside.js",
    "/absolute.js",
    "assets\\outside.js",
    "assets/../outside.js",
    "assets//outside.js",
    "C:/outside.js",
  ])("refuses unsafe publisher output path %s before reading its bytes", (file) => {
    const fixture = web();
    vi.clearAllMocks();
    expect(() =>
      publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", {
        ...fixture.files,
        [file]: "",
      }),
    ).toThrow(ApplicationBuildVersionError);
    expect(openSync).not.toHaveBeenCalled();
    expect(createHash).not.toHaveBeenCalled();
  });

  it("refuses a bundler getter without invoking it", () => {
    const fixture = web();
    const getter = vi.fn(() => "unreviewed code");
    const files = { "index.html": fixture.files["index.html"]! };
    Object.defineProperty(files, "assets/app.js", { enumerable: true, get: getter });
    expect(() =>
      publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", files),
    ).toThrow(ApplicationBuildVersionError);
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects excessive publisher file count before content IO", () => {
    const fixture = web();
    const files: Record<string, string> = { "index.html": "" };
    for (let index = 0; index < 1024; index++) files[`assets/part-${index}.js`] = "";
    vi.clearAllMocks();
    expect(() =>
      publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", files),
    ).toThrow(ApplicationBuildVersionError);
    expect(openSync).not.toHaveBeenCalled();
    expect(createHash).not.toHaveBeenCalled();
  });

  it.each([
    (receipt: TestManifest) => ({ ...receipt, extra: true }),
    (receipt: TestManifest) => ({ ...receipt, files: [...receipt.files, receipt.files[0]] }),
    (receipt: TestManifest) => ({
      ...receipt,
      files: receipt.files.map((file) => ({ ...file, extra: true })),
    }),
    (receipt: TestManifest) => ({
      ...receipt,
      files: [{ ...receipt.files[0], file: "../outside.js" }, ...receipt.files.slice(1)],
    }),
    (receipt: TestManifest) => ({
      ...receipt,
      files: receipt.files.map((file) => ({ ...file, sha256: "not-a-sha256" })),
    }),
  ])(
    "rejects malformed shape, duplicate or escaping receipts before payload hashing",
    (transform) => {
      const fixture = web();
      publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", fixture.files);
      tamper(fixture, transform);
      vi.clearAllMocks();
      expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).toThrow(
        ApplicationBuildVersionError,
      );
      expect(createHash).not.toHaveBeenCalled();
      expect(vi.mocked(openSync).mock.calls.map(([name]) => name)).toEqual([fixture.manifest]);
    },
  );

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER, 128 * 1024 * 1024 + 1])(
    "rejects impossible advertised byte count %s before candidate content IO",
    (bytes) => {
      const fixture = web();
      publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", fixture.files);
      tamper(fixture, (receipt) => ({
        ...receipt,
        files: receipt.files.map((file: object) => ({ ...file, bytes })),
      }));
      vi.clearAllMocks();
      expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).toThrow(
        ApplicationBuildVersionError,
      );
      expect(createHash).not.toHaveBeenCalled();
      expect(vi.mocked(openSync).mock.calls.map(([name]) => name)).toEqual([fixture.manifest]);
    },
  );

  it("checks the complete aggregate budget before hashing an earlier valid payload", () => {
    const fixture = web();
    publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", fixture.files);
    tamper(fixture, (receipt) => ({
      ...receipt,
      files: [
        ...receipt.files,
        { file: "assets/large-a.js", bytes: 128 * 1024 * 1024, sha256: "a".repeat(64) },
        { file: "assets/large-b.js", bytes: 128 * 1024 * 1024, sha256: "b".repeat(64) },
      ],
    }));
    vi.clearAllMocks();
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).toThrow(
      ApplicationBuildVersionError,
    );
    expect(createHash).not.toHaveBeenCalled();
    expect(vi.mocked(openSync).mock.calls.map(([name]) => name)).toEqual([fixture.manifest]);
  });

  it("preflights every actual output size before hashing earlier files", () => {
    const fixture = web();
    publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", fixture.files);
    tamper(fixture, (receipt) => ({
      ...receipt,
      files: receipt.files.map((file: { file: string; bytes: number }) =>
        file.file === "index.html" ? { ...file, bytes: file.bytes + 1 } : file,
      ),
    }));
    vi.clearAllMocks();
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).toThrow(
      ApplicationBuildVersionError,
    );
    expect(createHash).not.toHaveBeenCalled();
    expect(vi.mocked(openSync).mock.calls.map(([name]) => name)).toEqual([fixture.manifest]);
  });

  it("refuses hard-linked output aliases", () => {
    const fixture = web();
    publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", fixture.files);
    linkSync(join(fixture.root, "assets/app.js"), join(fixture.root, "assets/alias.js"));
    expect(() =>
      publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", fixture.files),
    ).toThrow(ApplicationBuildVersionError);
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).toThrow(
      ApplicationBuildVersionError,
    );
  });

  it("refuses both file and intermediate-directory symlinks", (context) => {
    const fixture = web();
    try {
      symlinkSync(join(fixture.root, "assets"), join(fixture.root, "linked"), "dir");
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        error.code === "EPERM"
      ) {
        context.skip();
        return;
      }
      throw error;
    }
    expect(() =>
      publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", {
        ...fixture.files,
        "linked/app.js": fixture.files["assets/app.js"]!,
      }),
    ).toThrow(ApplicationBuildVersionError);
    symlinkSync(join(fixture.root, "assets/app.js"), join(fixture.root, "entry.js"));
    expect(() =>
      publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", {
        ...fixture.files,
        "entry.js": fixture.files["assets/app.js"]!,
      }),
    ).toThrow(ApplicationBuildVersionError);
    publishApplicationBuildVersionManifest(fixture.root, "web", "0.2.2", fixture.files);
    rmSync(join(fixture.root, "assets/app.js"));
    symlinkSync(join(fixture.root, "index.html"), join(fixture.root, "assets/app.js"));
    expect(() => verifyApplicationBuildVersionManifest(fixture.root, "web", "0.2.2")).toThrow(
      ApplicationBuildVersionError,
    );
  });
});
