// @effect-diagnostics nodeBuiltinImport:off
/**
 * Observatory tests run entirely against a synthetic temporary workspace that
 * this file creates and removes. No real user project is ever scanned.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ProjectId } from "@cafecode/contracts";
import {
  WORKSPACE_OBSERVATORY_LIMITS,
  WorkspaceObservatoryFileInput,
  WorkspaceObservatoryTreeResult,
} from "@cafecode/contracts";

import { WorkspaceObservatoryDeniedError } from "../Services/WorkspaceObservatory.ts";
import {
  isAmbiguousSegment,
  isContained,
  isContainedIn,
  makeObservatoryAdmission,
  makeWorkspaceObservatory,
  redactObservedText,
  WORKSPACE_OBSERVATORY_ENTRY_METADATA_BUDGET,
} from "./WorkspaceObservatory.ts";

const KNOWN_PROJECT = "project-observatory-fixture" as ProjectId;
const UNKNOWN_PROJECT = "project-not-registered" as ProjectId;

let fixtureRoot = "";
let workspaceRoot = "";
let outsideRoot = "";
let symlinksAvailable = true;

/** Windows without developer mode refuses `symlink` with EPERM. */
async function trySymlink(
  target: string,
  linkPath: string,
  type: "file" | "dir",
): Promise<boolean> {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch (cause) {
    if (
      process.platform === "win32" &&
      cause instanceof Error &&
      "code" in cause &&
      (cause as NodeJS.ErrnoException).code === "EPERM"
    ) {
      return false;
    }
    throw cause;
  }
}

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "cafe-observatory-"));
  workspaceRoot = join(fixtureRoot, "workspace");
  outsideRoot = join(fixtureRoot, "outside");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await mkdir(join(workspaceRoot, "node_modules", "left-pad"), { recursive: true });
  await mkdir(join(workspaceRoot, ".git"), { recursive: true });
  await mkdir(join(workspaceRoot, "dist"), { recursive: true });

  await writeFile(join(workspaceRoot, "README.md"), "# Fixture\nsecond line\n", "utf8");
  await writeFile(join(workspaceRoot, " README.md"), "leading-space file\n", "utf8");
  await writeFile(join(workspaceRoot, "src", "index.ts"), "export const value = 1;\n", "utf8");
  await writeFile(join(workspaceRoot, ".env"), "API_KEY=abcdef0123456789\n", "utf8");
  await writeFile(join(workspaceRoot, "session.pem"), "not-a-real-key\n", "utf8");
  await writeFile(join(workspaceRoot, "node_modules", "left-pad", "index.js"), "module\n", "utf8");
  await writeFile(join(workspaceRoot, ".git", "config"), "[core]\n", "utf8");
  await writeFile(join(workspaceRoot, "dist", "bundle.js"), "bundled\n", "utf8");
  await writeFile(join(workspaceRoot, "binary.bin"), Buffer.from([0x41, 0x00, 0x42]));
  await writeFile(
    join(workspaceRoot, "config.yml"),
    "host: example.test\napi_key = sk-live-not-a-real-value\n",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, "large.txt"),
    "x".repeat(WORKSPACE_OBSERVATORY_LIMITS.textBytes + 4096),
    "utf8",
  );
  await writeFile(join(outsideRoot, "secret.txt"), "outside content\n", "utf8");
  symlinksAvailable = await trySymlink(
    join(outsideRoot, "secret.txt"),
    join(workspaceRoot, "escape.txt"),
    "file",
  );
});

afterAll(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

function observatory() {
  return makeWorkspaceObservatory((projectId) =>
    Effect.succeed(projectId === KNOWN_PROJECT ? workspaceRoot : null),
  );
}

/** Poll a predicate with a bounded deadline; no fake timers are involved. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met before the deadline");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

async function denial(effect: Effect.Effect<unknown, WorkspaceObservatoryDeniedError>) {
  const error = await Effect.runPromise(Effect.flip(effect));
  expect(error).toBeInstanceOf(WorkspaceObservatoryDeniedError);
  return error;
}

describe("WorkspaceObservatory authorization", () => {
  it("lists the selected project root", async () => {
    const result = await Effect.runPromise(observatory().tree({ projectId: KNOWN_PROJECT }));
    expect(result.relativePath).toBe("");
    const names = result.entries.map((entry) => entry.name);
    expect(names).toContain("README.md");
    expect(names).toContain("src");
  });

  it("denies a project the server projection does not know", async () => {
    const error = await denial(observatory().tree({ projectId: UNKNOWN_PROJECT }));
    expect(error.reason).toBe("unknown-project");
  });

  it("denies a file read for an unknown project", async () => {
    const error = await denial(
      observatory().readFile({ projectId: UNKNOWN_PROJECT, relativePath: "README.md" }),
    );
    expect(error.reason).toBe("unknown-project");
  });

  it("denies every request when the resolved root no longer exists", async () => {
    const missingRoot = makeWorkspaceObservatory(() =>
      Effect.succeed(join(fixtureRoot, "does-not-exist")),
    );
    const error = await denial(missingRoot.tree({ projectId: KNOWN_PROJECT }));
    expect(error.reason).toBe("root-unavailable");
  });
});

describe("WorkspaceObservatory path handling", () => {
  it("reads a regular file below the root", async () => {
    const file = await Effect.runPromise(
      observatory().readFile({ projectId: KNOWN_PROJECT, relativePath: "src/index.ts" }),
    );
    expect(file.relativePath).toBe("src/index.ts");
    expect(file.content).toBe("export const value = 1;\n");
    expect(file.truncated).toBe(false);
  });

  it.each([
    "../outside/secret.txt",
    "src/../../outside/secret.txt",
    "..",
    "src/..",
    "./../outside/secret.txt",
  ])("denies traversal attempt %s", async (relativePath) => {
    const error = await denial(observatory().readFile({ projectId: KNOWN_PROJECT, relativePath }));
    expect(error.reason).toBe("outside-root");
  });

  it("denies an absolute path", async () => {
    const error = await denial(
      observatory().readFile({
        projectId: KNOWN_PROJECT,
        relativePath: join(outsideRoot, "secret.txt"),
      }),
    );
    expect(error.reason).toBe("outside-root");
  });

  it("denies a malformed path containing a NUL byte", async () => {
    const error = await denial(
      observatory().readFile({
        projectId: KNOWN_PROJECT,
        relativePath: `src/index${String.fromCodePoint(0)}.ts`,
      }),
    );
    expect(error.reason).toBe("outside-root");
  });

  it.each([
    "node_modules/left-pad/index.js",
    ".git/config",
    "dist/bundle.js",
    ".env",
    "session.pem",
  ])("denies the excluded path %s", async (relativePath) => {
    const error = await denial(observatory().readFile({ projectId: KNOWN_PROJECT, relativePath }));
    expect(error.reason).toBe("sensitive-path");
  });

  it("omits excluded and hidden names from the listing and reports redaction", async () => {
    const result = await Effect.runPromise(observatory().tree({ projectId: KNOWN_PROJECT }));
    const names = result.entries.map((entry) => entry.name);
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    expect(names).not.toContain("dist");
    expect(names).not.toContain(".env");
    expect(names).not.toContain("session.pem");
    expect(result.redacted).toBe(true);
  });

  it("denies a symlink that escapes the root", async () => {
    if (!symlinksAvailable) return;
    const error = await denial(
      observatory().readFile({ projectId: KNOWN_PROJECT, relativePath: "escape.txt" }),
    );
    expect(error.reason).toBe("link");
    const listing = await Effect.runPromise(observatory().tree({ projectId: KNOWN_PROJECT }));
    expect(listing.entries.map((entry) => entry.name)).not.toContain("escape.txt");
  });

  it("denies reading a directory as a file", async () => {
    const error = await denial(
      observatory().readFile({ projectId: KNOWN_PROJECT, relativePath: "src" }),
    );
    expect(["not-a-file", "unreadable"]).toContain(error.reason);
  });

  it("denies listing a file as a directory", async () => {
    const error = await denial(
      observatory().tree({ projectId: KNOWN_PROJECT, relativePath: "README.md" }),
    );
    expect(error.reason).toBe("not-a-directory");
  });
});

describe("WorkspaceObservatory payload bounds", () => {
  it("truncates an oversize file at the byte limit", async () => {
    const file = await Effect.runPromise(
      observatory().readFile({ projectId: KNOWN_PROJECT, relativePath: "large.txt" }),
    );
    expect(file.truncated).toBe(true);
    expect(Buffer.byteLength(file.content, "utf8")).toBeLessThanOrEqual(
      WORKSPACE_OBSERVATORY_LIMITS.textBytes,
    );
  });

  it("refuses to display a binary file", async () => {
    const error = await denial(
      observatory().readFile({ projectId: KNOWN_PROJECT, relativePath: "binary.bin" }),
    );
    expect(error.reason).toBe("binary");
  });

  it("masks an obvious credential assignment on a best-effort basis", async () => {
    const file = await Effect.runPromise(
      observatory().readFile({ projectId: KNOWN_PROJECT, relativePath: "config.yml" }),
    );
    expect(file.redacted).toBe(true);
    expect(file.content).not.toContain("sk-live-not-a-real-value");
    expect(file.content).toContain("host: example.test");
  });
});

describe("WorkspaceObservatory containment", () => {
  /**
   * `relative` returns an absolute path whenever the two inputs share no common
   * prefix. On Windows that covers a different drive letter and a UNC share, and
   * the UNC form carries no drive-letter prefix, so a drive-letter regexp
   * accepts it as contained. These cases use win32 spellings directly so the
   * assertion holds on every host.
   */
  it("rejects a win32 result that escapes to another drive", () => {
    expect(isContainedIn(win32, "C:\\workspace", "D:\\elsewhere\\secret.txt")).toBe(false);
  });

  it("rejects a win32 result that escapes to a UNC share", () => {
    // `relative` returns this target unchanged, and it has no drive letter, so
    // only an absoluteness check on the result rejects it.
    expect(isContainedIn(win32, "C:\\workspace", "\\\\attacker\\share\\secret.txt")).toBe(false);
  });

  it("applies win32 parent-walk and descendant rules from any host", () => {
    expect(isContainedIn(win32, "C:\\workspace", "C:\\outside")).toBe(false);
    expect(isContainedIn(win32, "C:\\workspace", "C:\\workspace\\src\\index.ts")).toBe(true);
    expect(isContainedIn(win32, "C:\\workspace", "C:\\workspace")).toBe(true);
  });

  it("applies posix parent-walk and descendant rules from any host", () => {
    expect(isContainedIn(posix, "/workspace", "/outside/secret.txt")).toBe(false);
    expect(isContainedIn(posix, "/workspace", "/workspace/src/index.ts")).toBe(true);
    expect(isContainedIn(posix, "/workspace", "/workspace")).toBe(true);
  });

  it("agrees with the host path rules for the live fixture root", () => {
    expect(isContained(workspaceRoot, join(workspaceRoot, "src", "index.ts"))).toBe(true);
    expect(isContained(workspaceRoot, join(outsideRoot, "secret.txt"))).toBe(false);
  });

  it("treats Windows-ambiguous segment spellings as unusable", () => {
    // NTFS alternate data stream, which no directory listing reveals.
    expect(isAmbiguousSegment("notes.txt:hidden")).toBe(true);
    // Drive-relative reintroduction.
    expect(isAmbiguousSegment("C:file")).toBe(true);
    // Win32 strips the trailing dot, so this is a second spelling of secret.pem.
    expect(isAmbiguousSegment("secret.pem.")).toBe(true);
    expect(isAmbiguousSegment("trailing ")).toBe(true);
    expect(isAmbiguousSegment("NUL")).toBe(true);
    expect(isAmbiguousSegment("com1.txt")).toBe(true);
    expect(isAmbiguousSegment("wild*card")).toBe(true);
    expect(isAmbiguousSegment("README.md")).toBe(false);
    expect(isAmbiguousSegment("index.ts")).toBe(false);
  });

  it("denies an alternate-data-stream path through the service", async () => {
    const error = await denial(
      observatory().readFile({ projectId: KNOWN_PROJECT, relativePath: "README.md:hidden" }),
    );
    expect(error.reason).toBe("outside-root");
    expect(error.detail).not.toContain(workspaceRoot);
  });

  it("denies a reserved Windows device name through the service", async () => {
    const error = await denial(
      observatory().readFile({ projectId: KNOWN_PROJECT, relativePath: "NUL" }),
    );
    expect(error.reason).toBe("outside-root");
  });
});

describe("WorkspaceObservatory exact path spelling", () => {
  it("preserves leading spaces through tree and request schemas and reads that exact file", async () => {
    const tree = Schema.decodeUnknownSync(WorkspaceObservatoryTreeResult)(
      await Effect.runPromise(observatory().tree({ projectId: KNOWN_PROJECT })),
    );
    const entry = tree.entries.find((item) => item.name === " README.md");
    expect(entry?.relativePath).toBe(" README.md");
    const input = Schema.decodeUnknownSync(WorkspaceObservatoryFileInput)({
      projectId: KNOWN_PROJECT,
      relativePath: " README.md",
    });
    const file = await Effect.runPromise(observatory().readFile(input));
    expect(file.content).toBe("leading-space file\n");
  });

  it("refuses a trailing space without silently reading the trimmed name", async () => {
    const input = Schema.decodeUnknownSync(WorkspaceObservatoryFileInput)({
      projectId: KNOWN_PROJECT,
      relativePath: "README.md ",
    });
    const error = await denial(observatory().readFile(input));
    expect(error.reason).toBe("outside-root");
  });
});

describe("WorkspaceObservatory text masking", () => {
  it("handles a maximum-size non-assignment without repeated sensitive-key backtracking", () => {
    const content = "token".repeat(Math.floor(WORKSPACE_OBSERVATORY_LIMITS.textBytes / 5));
    const started = performance.now();
    expect(redactObservedText(content)).toEqual({ value: content, redacted: false });
    // A generous ceiling for an in-memory 128 KiB scan, not a throughput benchmark.
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("masks sensitive assignments while preserving ordinary values and line breaks", () => {
    const result = redactObservedText(
      'host: example.test\n\n  const "api_key" = example-value\nSESSION_TOKEN: second-value\n',
    );
    expect(result).toEqual({
      value: 'host: example.test\n\n  const "api_key" = [redacted]\nSESSION_TOKEN: [redacted]\n',
      redacted: true,
    });
  });
});

describe("WorkspaceObservatory admission control", () => {
  it("refuses a request once the concurrent pool is full instead of queueing it", async () => {
    const admission = makeObservatoryAdmission({ maxConcurrent: 1, timeoutMs: 10_000 });
    let release: (() => void) | undefined;
    const held = admission.run(
      () =>
        new Promise<string>((resolvePromise) => {
          release = () => resolvePromise("done");
        }),
    );
    expect(admission.active()).toBe(1);

    const refused = await admission
      .run(async () => "second")
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    expect(refused).toBeInstanceOf(WorkspaceObservatoryDeniedError);
    expect((refused as WorkspaceObservatoryDeniedError).reason).toBe("busy");

    release?.();
    await expect(held).resolves.toBe("done");
    // The slot is returned only after the real operation settles.
    await Promise.resolve();
    expect(admission.active()).toBe(0);
  });

  it("fails a request past its deadline but keeps the slot until the work settles", async () => {
    const admission = makeObservatoryAdmission({ maxConcurrent: 1, timeoutMs: 20 });
    let release: (() => void) | undefined;
    const stuck = admission.run(
      () =>
        new Promise<string>((resolvePromise) => {
          release = () => resolvePromise("eventually");
        }),
    );

    const timedOut = await stuck.then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(timedOut).toBeInstanceOf(WorkspaceObservatoryDeniedError);
    expect((timedOut as WorkspaceObservatoryDeniedError).reason).toBe("timed-out");

    // This is the property that stops stuck I/O from being retried into an
    // ever-growing pile of blocked libuv workers: the capacity is still held.
    expect(admission.active()).toBe(1);
    const refused = await admission
      .run(async () => "third")
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    expect((refused as WorkspaceObservatoryDeniedError).reason).toBe("busy");

    release?.();
    await waitUntil(() => admission.active() === 0);
    expect(admission.active()).toBe(0);
  });

  it("releases the slot when an operation throws synchronously", async () => {
    const admission = makeObservatoryAdmission({ maxConcurrent: 1, timeoutMs: 1_000 });
    await expect(
      admission.run(() => {
        throw new Error("immediate");
      }),
    ).rejects.toThrow("immediate");
    expect(admission.active()).toBe(0);
  });
});

describe("WorkspaceObservatory special files", () => {
  /**
   * `open` on a FIFO with no writer blocks on an uncancellable libuv worker, so
   * the read path must establish the file type before opening. Node has no
   * portable FIFO constructor, and Windows named pipes are not created through
   * the filesystem namespace, so this coverage stays POSIX-only; the Windows
   * equivalent of the same precheck is covered by the directory case below.
   */
  it.skipIf(process.platform === "win32")(
    "denies a named pipe without blocking on open",
    async () => {
      const fifoPath = join(workspaceRoot, "pipe.txt");
      const made = await new Promise<boolean>((resolvePromise) => {
        execFile("mkfifo", [fifoPath], (error) => resolvePromise(!error));
      });
      if (!made) return;
      try {
        const started = Date.now();
        const error = await denial(
          observatory().readFile({ projectId: KNOWN_PROJECT, relativePath: "pipe.txt" }),
        );
        expect(error.reason).toBe("not-a-file");
        // A blocking open would have been cut off by the admission deadline
        // instead of returning a precise denial almost immediately.
        expect(Date.now() - started).toBeLessThan(2_000);
      } finally {
        await rm(fifoPath, { force: true });
      }
    },
  );

  it("denies a directory presented as a file on every platform", async () => {
    const error = await denial(
      observatory().readFile({ projectId: KNOWN_PROJECT, relativePath: "src" }),
    );
    expect(error.reason).toBe("not-a-file");
  });
});

describe("WorkspaceObservatory listing bounds", () => {
  /**
   * The listing previously issued `lstat` + `realpath` + `stat` for every name,
   * so one 500-entry directory could run up to 1500 sequential filesystem
   * operations while holding a single admission slot. The directory read now
   * supplies the entry kind, and the `lstat` fallback for entries of unknown
   * kind is capped. Completing inside the admission deadline is the assertion
   * that the bound holds.
   */
  it("lists a directory larger than the entry limit within the request deadline", async () => {
    const wide = join(workspaceRoot, "wide");
    await mkdir(wide, { recursive: true });
    const total = WORKSPACE_OBSERVATORY_LIMITS.treeEntries + 20;
    await Promise.all(
      Array.from({ length: total }, (_unused, index) =>
        writeFile(join(wide, `entry-${index}.txt`), "x\n", "utf8"),
      ),
    );
    try {
      const result = await Effect.runPromise(
        observatory().tree({ projectId: KNOWN_PROJECT, relativePath: "wide" }),
      );
      expect(result.entries.length).toBeLessThanOrEqual(WORKSPACE_OBSERVATORY_LIMITS.treeEntries);
      expect(result.truncated).toBe(true);
      expect(result.entries.every((entry) => entry.kind === "file")).toBe(true);
      // The fallback budget exists to bound metadata work, not to shrink the
      // listing: entries of known kind never consume it.
      expect(result.entries.length).toBeGreaterThan(WORKSPACE_OBSERVATORY_ENTRY_METADATA_BUDGET);
    } finally {
      await rm(wide, { recursive: true, force: true });
    }
  });
});
