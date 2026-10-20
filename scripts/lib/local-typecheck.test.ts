// This fixture qualifies actual native descriptor/path admission in a private
// temporary source tree, never a filesystem service substituted for that IO.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// Keep fixture paths on the same host-native grammar as the real coordinator.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join, resolve } from "node:path";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import {
  discoverLocalTypecheckPrograms,
  localTypecheckOutput,
  parseLocalTypecheckArguments,
  parseLocalTypecheckMetadata,
  prioritizeLocalTypecheckPrograms,
  runLocalTypecheckPrograms,
  type LocalCompilerExit,
  type LocalCompilerLaunch,
} from "./local-typecheck.ts";

function deferred<T>() {
  let complete!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    complete = resolveValue;
  });
  return { promise, complete };
}

const success: LocalCompilerExit = { code: 0, signal: null, transportError: false };
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const metadata = (entries: readonly { name: string; location: string }[]) =>
  entries.map((entry) => encodeJson(entry)).join("\n") + "\n";
const rootMetadata = { name: "@fixture/renamed-root", location: "." };

async function withSource(
  use: (root: string, rows: readonly { name: string; location: string }[]) => Promise<void>,
) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "cafe-local-types-"));
  const json = (path: string, value: unknown) => writeFile(path, encodeJson(value));
  try {
    await json(join(root, "package.json"), {
      name: rootMetadata.name,
      private: true,
      packageManager: "yarn@4.17.1",
      scripts: { typecheck: "this root must never be admitted" },
    });
    const compiler = join(root, "node_modules/typescript");
    await mkdir(join(compiler, "bin"), { recursive: true });
    await json(join(compiler, "package.json"), { name: "typescript", version: "5.9.3" });
    await writeFile(join(compiler, "bin/tsc"), "// inert fixture; never executed\n");
    const rows = [
      rootMetadata,
      { name: "@fixture/one", location: "packages/one" },
      { name: "@fixture/no-script", location: "packages/no-script" },
    ];
    for (const row of rows.slice(1)) {
      await mkdir(join(root, row.location), { recursive: true });
      await json(join(root, row.location, "package.json"), {
        name: row.name,
        ...(row.name === "@fixture/one" ? { scripts: { typecheck: "tsc --noEmit" } } : {}),
      });
    }
    await use(root, rows);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function ownedQueue(count: number, names?: readonly string[]) {
  const programs = Array.from({ length: count }, (_, index) => ({
    name: names?.[index] ?? `@fixture/check-${index}`,
    cwd: resolve(tmpdir(), `cafe-inert-type-workspace-${index}`),
    compiler: resolve(tmpdir(), "cafe-inert-type-compiler"),
  }));
  const peers = programs.map(() => {
    const terminationEntered = deferred<void>();
    return {
      close: deferred<LocalCompilerExit>(),
      entered: deferred<void>(),
      terminationEntered,
      terminate: vi.fn(() => terminationEntered.complete()),
    };
  });
  const launched: string[] = [];
  let active = 0;
  let maximum = 0;
  const launch: LocalCompilerLaunch = (program) => {
    const index = programs.findIndex((entry) => entry.name === program.name);
    const peer = peers[index]!;
    launched.push(program.name);
    active += 1;
    maximum = Math.max(maximum, active);
    peer.entered.complete();
    return {
      closed: peer.close.promise.then((exit) => {
        active -= 1;
        return exit;
      }),
      terminate: peer.terminate,
    };
  };
  return { programs, peers, launched, launch, maximum: () => maximum };
}

describe("bounded local typecheck admission", () => {
  it("binds interleaved compiler lines to their exact workspace without losing UTF-8 text", () => {
    const output: string[] = [];
    const one = localTypecheckOutput("@fixture/one", (text) => output.push(text));
    const two = localTypecheckOutput("@fixture/two", (text) => output.push(text));
    const unicode = Buffer.from("src/same.ts: 日本語\nunfinished");
    one.write(unicode.subarray(0, 15));
    two.write(Buffer.from("src/same.ts: other\n"));
    one.write(unicode.subarray(15));
    one.end();
    two.end();
    expect(output).toEqual([
      "[@fixture/two] src/same.ts: other\n",
      "[@fixture/one] src/same.ts: 日本語\n",
      "[@fixture/one] unfinished\n",
    ]);
  });
  it("bounds an unterminated diagnostic line and preserves every surrogate pair", () => {
    const output: string[] = [];
    const owner = localTypecheckOutput("@fixture/large", (text) => output.push(text));
    const input = "x".repeat(65_535) + "🌸" + "z".repeat(65_536);
    owner.write(Buffer.from(input));
    owner.end();
    expect(output.every((text) => text.length <= 65_536 + "[@fixture/large] ".length + 1)).toBe(
      true,
    );
    expect(output.map((text) => text.slice("[@fixture/large] ".length, -1)).join("")).toBe(input);
    expect(() => localTypecheckOutput("bad\nowner", () => undefined)).toThrow(
      "unsupported workspace",
    );
  });
  it("accepts only the finite concurrency choices without selection or compiler arguments", () => {
    expect(parseLocalTypecheckArguments([])).toBe(3);
    expect(parseLocalTypecheckArguments(["--concurrency=1"])).toBe(1);
    expect(parseLocalTypecheckArguments(["--concurrency=2"])).toBe(2);
    expect(parseLocalTypecheckArguments(["--concurrency=3"])).toBe(3);
    for (const args of [
      ["--concurrency=4"],
      ["--concurrency=02"],
      ["--concurrency=2.0"],
      ["--concurrency", "2"],
      ["--concurrency=2", "--concurrency=2"],
      ["--concurrency=3", "--concurrency=3"],
      ["--concurrency=1", "--concurrency=3"],
      ["--filter=web"],
      ["--root=/tmp"],
      ["--compiler=other"],
      ["--skip=contracts"],
    ])
      expect(() => parseLocalTypecheckArguments(args)).toThrow("accepts only");
  });

  it("excludes the renamed root, skips only missing scripts and resolves the actual shared installed entry", async () => {
    await withSource(async (root, rows) => {
      const list = vi.fn(async () => metadata(rows));
      const programs = await discoverLocalTypecheckPrograms(
        root,
        new AbortController().signal,
        list,
      );
      expect(list).toHaveBeenCalledExactlyOnceWith(root, expect.any(AbortSignal));
      expect(programs).toEqual([
        {
          name: "@fixture/one",
          cwd: join(root, "packages/one"),
          compiler: join(root, "node_modules/typescript/bin/tsc"),
        },
      ]);
    });
  });

  it("refuses future script changes rather than quietly reducing the complete graph", async () => {
    await withSource(async (root, rows) => {
      await writeFile(
        join(root, "packages/one/package.json"),
        encodeJson({
          name: "@fixture/one",
          scripts: { typecheck: "tsc --noEmit && other-command" },
        }),
      );
      await expect(
        discoverLocalTypecheckPrograms(root, new AbortController().signal, async () =>
          metadata(rows),
        ),
      ).rejects.toThrow("unsupported script");
    });
  });

  it("refuses a workspace resolving a different compiler even with the same package version", async () => {
    await withSource(async (root, rows) => {
      const alternate = join(root, "packages/one/node_modules/typescript");
      await mkdir(join(alternate, "bin"), { recursive: true });
      await writeFile(
        join(alternate, "package.json"),
        encodeJson({ name: "typescript", version: "5.9.3" }),
      );
      await writeFile(join(alternate, "bin/tsc"), "// different inert entry\n");
      await expect(
        discoverLocalTypecheckPrograms(root, new AbortController().signal, async () =>
          metadata(rows),
        ),
      ).rejects.toThrow("unsupported compiler");
    });
  });

  it("refuses an unqualified TypeScript version and a graph with no actual compiler programs", async () => {
    await withSource(async (root, rows) => {
      await writeFile(
        join(root, "node_modules/typescript/package.json"),
        encodeJson({ name: "typescript", version: "7.0.0" }),
      );
      await expect(
        discoverLocalTypecheckPrograms(root, new AbortController().signal, async () =>
          metadata(rows),
        ),
      ).rejects.toThrow("unsupported compiler");
      await writeFile(
        join(root, "node_modules/typescript/package.json"),
        encodeJson({ name: "typescript", version: "5.9.3" }),
      );
      await expect(
        discoverLocalTypecheckPrograms(root, new AbortController().signal, async () =>
          metadata([rows[0]!, rows[2]!]),
        ),
      ).rejects.toThrow("unsupported workspace");
    });
  });

  it("rejects malformed, oversized, duplicate and escaping metadata before workspace reads", () => {
    for (const location of [
      "../outside",
      "packages/../outside",
      "/absolute",
      "C:\\absolute",
      "C:relative",
      "packages//one",
      "packages/./one",
      "packages/one\nother",
    ])
      expect(() =>
        parseLocalTypecheckMetadata(metadata([rootMetadata, { name: "@fixture/one", location }])),
      ).toThrow("unsupported metadata");
    for (const output of [
      "",
      "not-json",
      metadata([{ name: "@fixture/one", location: "packages/one" }]),
      metadata([rootMetadata, rootMetadata]),
      metadata([
        rootMetadata,
        { name: "@fixture/one", location: "packages/one" },
        { name: "@fixture/two", location: "packages/one" },
      ]),
      " ".repeat(1_048_577),
      metadata(
        Array.from({ length: 257 }, (_, index) => ({
          name: `@fixture/p-${index}`,
          location: index === 0 ? "." : `packages/p-${index}`,
        })),
      ),
    ])
      expect(() => parseLocalTypecheckMetadata(output)).toThrow("unsupported metadata");
  });
});

describe("stable complete typecheck admission priority", () => {
  const names = [
    "@fixture/unknown-a",
    "@cafeai/cafe-code",
    "effect-codex-app-server",
    "@fixture/unknown-b",
  ];

  it("only permutes the admitted programs and preserves stable unknown and equal-priority owners", () => {
    const fixture = ownedQueue(4, names);
    const duplicateLabel = {
      ...fixture.programs[2]!,
      cwd: resolve(tmpdir(), "cafe-inert-type-additional-owner"),
    };
    const input = [...fixture.programs, duplicateLabel];
    const before = [...input];
    const ordered = prioritizeLocalTypecheckPrograms(input);
    expect(ordered).not.toBe(input);
    expect(input).toEqual(before);
    expect(ordered).toEqual([input[2], duplicateLabel, input[1], input[0], input[3]]);
    for (const program of input)
      expect(ordered.filter((selected) => selected === program)).toHaveLength(1);
  });

  it("admits the priorities first without changing the two-child cap, arguments or full coverage", async () => {
    const fixture = ownedQueue(4, names);
    const selected = prioritizeLocalTypecheckPrograms(fixture.programs);
    const controller = new AbortController();
    const launch = vi.fn(fixture.launch);
    const run = runLocalTypecheckPrograms(selected, 2, controller.signal, launch);
    try {
      expect(fixture.launched).toEqual([names[2], names[1]]);
      fixture.peers[2]!.close.complete(success);
      await fixture.peers[0]!.entered.promise;
      expect(fixture.launched).toEqual([names[2], names[1], names[0]]);
      fixture.peers[0]!.close.complete(success);
      await fixture.peers[3]!.entered.promise;
      fixture.peers[3]!.close.complete(success);
      fixture.peers[1]!.close.complete(success);
      expect(await run).toEqual({
        passed: true,
        cancelled: false,
        completed: 4,
        failures: [],
      });
      expect(launch.mock.calls.map(([program]) => program)).toEqual(selected);
      expect(fixture.launched).toEqual(selected.map((program) => program.name));
      expect(fixture.maximum()).toBe(2);
      expect(fixture.peers.every((peer) => peer.terminate.mock.calls.length === 0)).toBe(true);
    } finally {
      controller.abort();
      for (const peer of fixture.peers) peer.close.complete(success);
      await run;
    }
  });

  it("cancels only the two admitted priorities, fences unknown peers and joins both close receipts", async () => {
    const fixture = ownedQueue(4, names);
    const selected = prioritizeLocalTypecheckPrograms(fixture.programs);
    const controller = new AbortController();
    let settled = false;
    const run = runLocalTypecheckPrograms(selected, 2, controller.signal, fixture.launch).then(
      (result) => {
        settled = true;
        return result;
      },
    );
    try {
      controller.abort();
      expect(fixture.launched).toEqual([names[2], names[1]]);
      expect(fixture.peers[2]!.terminate).toHaveBeenCalledExactlyOnceWith();
      expect(fixture.peers[1]!.terminate).toHaveBeenCalledExactlyOnceWith();
      expect(fixture.peers[0]!.terminate).not.toHaveBeenCalled();
      expect(fixture.peers[3]!.terminate).not.toHaveBeenCalled();
      fixture.peers[2]!.close.complete(success);
      await fixture.peers[2]!.close.promise;
      expect(settled).toBe(false);
      expect(fixture.launched).toHaveLength(2);
      fixture.peers[1]!.close.complete(success);
      expect(await run).toEqual({
        passed: false,
        cancelled: true,
        completed: 2,
        failures: [],
      });
      expect(fixture.maximum()).toBe(2);
      expect(fixture.launched).toHaveLength(2);
    } finally {
      controller.abort();
      for (const peer of fixture.peers) peer.close.complete(success);
      await run;
    }
  });
});

describe("direct native compiler ownership", () => {
  it.each([1, 2, 3] as const)(
    "executes every admitted program exactly once with at most %s owned compilers",
    async (concurrency) => {
      const fixture = ownedQueue(4);
      const controller = new AbortController();
      const run = runLocalTypecheckPrograms(
        fixture.programs,
        concurrency,
        controller.signal,
        fixture.launch,
      );
      try {
        expect(fixture.launched).toHaveLength(concurrency);
        for (const peer of fixture.peers) {
          await peer.entered.promise;
          peer.close.complete(success);
        }
        expect(await run).toEqual({ passed: true, cancelled: false, completed: 4, failures: [] });
        expect(fixture.launched).toEqual(fixture.programs.map((program) => program.name));
        expect(fixture.maximum()).toBe(concurrency);
      } finally {
        controller.abort();
        for (const peer of fixture.peers) peer.close.complete(success);
        await run;
      }
    },
  );

  it("joins all selected diagnostics after an ordinary compiler failure without qualifying success", async () => {
    const fixture = ownedQueue(3);
    const controller = new AbortController();
    const run = runLocalTypecheckPrograms(fixture.programs, 2, controller.signal, fixture.launch);
    try {
      fixture.peers[0]!.close.complete({ ...success, code: 2 });
      await fixture.peers[2]!.entered.promise;
      fixture.peers[2]!.close.complete(success);
      fixture.peers[1]!.close.complete(success);
      expect(await run).toEqual({
        passed: false,
        cancelled: false,
        completed: 3,
        failures: [{ workspace: "@fixture/check-0", reason: "compiler" }],
      });
      expect(fixture.peers.every((peer) => peer.terminate.mock.calls.length === 0)).toBe(true);
    } finally {
      controller.abort();
      for (const peer of fixture.peers) peer.close.complete(success);
      await run;
    }
  });

  it("fences queued admission before cancellation signals and joins late zero closes", async () => {
    const fixture = ownedQueue(4);
    const controller = new AbortController();
    let settled = false;
    const run = runLocalTypecheckPrograms(
      fixture.programs,
      2,
      controller.signal,
      fixture.launch,
    ).then((result) => {
      settled = true;
      return result;
    });
    try {
      controller.abort();
      expect(fixture.launched).toHaveLength(2);
      for (const peer of fixture.peers.slice(0, 2))
        expect(peer.terminate).toHaveBeenCalledExactlyOnceWith();
      fixture.peers[0]!.close.complete(success);
      await fixture.peers[0]!.close.promise;
      expect(settled).toBe(false);
      expect(fixture.launched).toHaveLength(2);
      fixture.peers[1]!.close.complete(success);
      expect(await run).toEqual({ passed: false, cancelled: true, completed: 2, failures: [] });
      expect(fixture.peers[2]!.terminate).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      for (const peer of fixture.peers) peer.close.complete(success);
      await run;
    }
  });

  it("does not start a program when already cancelled and handles cancellation during spawn", async () => {
    const fixture = ownedQueue(2);
    const controller = new AbortController();
    controller.abort();
    expect(
      await runLocalTypecheckPrograms(fixture.programs, 2, controller.signal, fixture.launch),
    ).toEqual({ passed: false, cancelled: true, completed: 0, failures: [] });
    expect(fixture.launched).toEqual([]);
    const during = new AbortController();
    const peer = fixture.peers[0]!;
    const run = runLocalTypecheckPrograms(fixture.programs, 2, during.signal, (program) => {
      const child = fixture.launch(program);
      during.abort();
      return child;
    });
    try {
      expect(peer.terminate).toHaveBeenCalledExactlyOnceWith();
      expect(fixture.launched).toEqual([fixture.programs[0]!.name]);
      peer.close.complete(success);
      expect((await run).passed).toBe(false);
    } finally {
      during.abort();
      for (const entry of fixture.peers) entry.close.complete(success);
      await run;
    }
  });

  it("cancels all three held compilers, joins every close and vetoes queued admission after late zero exits", async () => {
    const fixture = ownedQueue(5);
    const controller = new AbortController();
    let settled = false;
    const run = runLocalTypecheckPrograms(
      fixture.programs,
      3,
      controller.signal,
      fixture.launch,
    ).then((result) => {
      settled = true;
      return result;
    });
    try {
      await Promise.all(fixture.peers.slice(0, 3).map((peer) => peer.entered.promise));
      expect(fixture.launched).toEqual(fixture.programs.slice(0, 3).map((program) => program.name));
      controller.abort();
      for (const peer of fixture.peers.slice(0, 3))
        expect(peer.terminate).toHaveBeenCalledExactlyOnceWith();
      for (const peer of fixture.peers.slice(3)) expect(peer.terminate).not.toHaveBeenCalled();
      // A cancelled owner may still close successfully. Neither the first nor
      // second zero close can settle the queue or admit either waiting owner.
      for (const peer of fixture.peers.slice(0, 2)) {
        peer.close.complete(success);
        await peer.close.promise;
        expect(settled).toBe(false);
        expect(fixture.launched).toHaveLength(3);
      }
      fixture.peers[2]!.close.complete(success);
      expect(await run).toEqual({ passed: false, cancelled: true, completed: 3, failures: [] });
      expect(fixture.maximum()).toBe(3);
      expect(fixture.launched).toHaveLength(3);
      for (const peer of fixture.peers.slice(3)) expect(peer.terminate).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      for (const peer of fixture.peers) peer.close.complete(success);
      await run;
    }
  });

  it("joins an already held child after a later spawn throws, without admitting another program", async () => {
    const fixture = ownedQueue(3);
    const controller = new AbortController();
    let settled = false;
    const run = runLocalTypecheckPrograms(fixture.programs, 2, controller.signal, (program) => {
      if (program.name === fixture.programs[1]!.name) throw new Error("opaque injected failure");
      return fixture.launch(program);
    }).then((result) => {
      settled = true;
      return result;
    });
    try {
      expect(fixture.peers[0]!.terminate).toHaveBeenCalledExactlyOnceWith();
      expect(settled).toBe(false);
      expect(fixture.launched).toEqual([fixture.programs[0]!.name]);
      fixture.peers[0]!.close.complete(success);
      expect(await run).toEqual({
        passed: false,
        cancelled: false,
        completed: 1,
        failures: [{ workspace: "@fixture/check-1", reason: "spawn" }],
      });
    } finally {
      controller.abort();
      for (const peer of fixture.peers) peer.close.complete(success);
      await run;
    }
  });

  it.each(["transport", "signal"] as const)(
    "retires only still-held owners after a %s failure",
    async (reason) => {
      const fixture = ownedQueue(3);
      const controller = new AbortController();
      const run = runLocalTypecheckPrograms(fixture.programs, 2, controller.signal, fixture.launch);
      try {
        fixture.peers[0]!.close.complete(
          reason === "transport"
            ? { ...success, code: null, transportError: true }
            : { ...success, code: null, signal: "SIGTERM" },
        );
        await fixture.peers[1]!.terminationEntered.promise;
        expect(fixture.peers[0]!.terminate).not.toHaveBeenCalled();
        expect(fixture.peers[1]!.terminate).toHaveBeenCalledExactlyOnceWith();
        expect(fixture.launched).toHaveLength(2);
        fixture.peers[1]!.close.complete(success);
        expect(await run).toEqual({
          passed: false,
          cancelled: false,
          completed: 2,
          failures: [{ workspace: "@fixture/check-0", reason }],
        });
      } finally {
        controller.abort();
        for (const peer of fixture.peers) peer.close.complete(success);
        await run;
      }
    },
  );

  it("does not detach or qualify a late zero exit when signalling its owned child throws", async () => {
    const fixture = ownedQueue(2);
    const controller = new AbortController();
    fixture.peers[0]!.terminate.mockImplementation(() => {
      throw new Error("opaque native signal error");
    });
    let settled = false;
    const run = runLocalTypecheckPrograms(
      fixture.programs,
      1,
      controller.signal,
      fixture.launch,
    ).then((result) => {
      settled = true;
      return result;
    });
    try {
      controller.abort();
      expect(settled).toBe(false);
      expect(fixture.launched).toHaveLength(1);
      fixture.peers[0]!.close.complete(success);
      expect(await run).toEqual({
        passed: false,
        cancelled: true,
        completed: 1,
        failures: [{ workspace: "@fixture/check-0", reason: "termination" }],
      });
    } finally {
      controller.abort();
      for (const peer of fixture.peers) peer.close.complete(success);
      await run;
    }
  });

  it("refuses invalid programmatic limits, empty programs and duplicate output owners", async () => {
    const fixture = ownedQueue(1);
    for (const concurrency of [0, 4, Number.NaN, "2"])
      await expect(
        runLocalTypecheckPrograms(
          fixture.programs,
          concurrency as 1 | 2 | 3,
          new AbortController().signal,
          fixture.launch,
        ),
      ).rejects.toThrow("accepts only");
    await expect(
      runLocalTypecheckPrograms([], 1, new AbortController().signal, fixture.launch),
    ).rejects.toThrow("unsupported workspace");
    await expect(
      runLocalTypecheckPrograms(
        [fixture.programs[0]!, fixture.programs[0]!],
        2,
        new AbortController().signal,
        fixture.launch,
      ),
    ).rejects.toThrow("unsupported workspace");
    expect(fixture.launched).toEqual([]);
  });
});
