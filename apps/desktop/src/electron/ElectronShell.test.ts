import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { beforeEach, vi } from "vitest";

const {
  isCommandAvailableMock,
  openExternalMock,
  openPathMock,
  showItemInFolderMock,
  writeTextMock,
} = vi.hoisted(() => ({
  isCommandAvailableMock: vi.fn(),
  openExternalMock: vi.fn(),
  openPathMock: vi.fn(),
  showItemInFolderMock: vi.fn(),
  writeTextMock: vi.fn(),
}));

vi.mock("@cafecode/shared/shell", () => ({
  isCommandAvailable: isCommandAvailableMock,
}));

vi.mock("electron", () => ({
  shell: {
    openExternal: openExternalMock,
    openPath: openPathMock,
    showItemInFolder: showItemInFolderMock,
  },
  clipboard: {
    writeText: writeTextMock,
  },
}));

const resetExternalLaunchMocks = () => {
  isCommandAvailableMock.mockReset();
  openExternalMock.mockReset();
  openPathMock.mockReset();
  showItemInFolderMock.mockReset();
  writeTextMock.mockReset();

  isCommandAvailableMock.mockReturnValue(false);
};

import * as ElectronShell from "./ElectronShell.ts";

function makeProcess(options?: {
  readonly stdoutText?: string;
  readonly exitCode?: number;
}): ChildProcessSpawner.ChildProcessHandle {
  const stdout = options?.stdoutText
    ? Stream.encodeText(Stream.make(options.stdoutText))
    : Stream.empty;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout,
    stderr: Stream.empty,
    all: stdout,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(options?.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function makeShellLayer(
  onCommand?: (command: ChildProcess.Command) => ChildProcessSpawner.ChildProcessHandle,
) {
  const spawnerLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.succeed(onCommand?.(command) ?? makeProcess({ exitCode: 1 })),
    ),
  );
  return ElectronShell.layer.pipe(Layer.provide(spawnerLayer));
}

describe("ElectronShell", () => {
  beforeEach(() => {
    resetExternalLaunchMocks();
  });

  it.effect("opens safe external URLs", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("https://example.com/path");

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [["https://example.com/path"]]);
    }).pipe(Effect.provide(makeShellLayer())),
  );

  it.effect("opens loopback URLs through the Linux default browser desktop entry", () => {
    const commands: ChildProcess.Command[] = [];
    return Effect.gen(function* () {
      if (process.platform !== "linux") return;

      isCommandAvailableMock.mockImplementation(
        (command: string) => command === "xdg-settings" || command === "gio",
      );

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("http://127.0.0.1:3001");

      assert.equal(result, true);
      assert.equal(openExternalMock.mock.calls.length, 0);
      assert.equal(commands[0]?._tag, "StandardCommand");
      assert.equal(
        commands[0]?._tag === "StandardCommand" ? commands[0].command : "",
        "xdg-settings",
      );
      assert.deepEqual(commands[0]?._tag === "StandardCommand" ? commands[0].args : [], [
        "get",
        "default-web-browser",
      ]);
      assert.equal(commands[1]?._tag, "StandardCommand");
      assert.equal(commands[1]?._tag === "StandardCommand" ? commands[1].command : "", "gio");
      const gioArgs = commands[1]?._tag === "StandardCommand" ? commands[1].args : [];
      assert.equal(gioArgs[0], "launch");
      assert.equal(String(gioArgs[1]).endsWith("/zen.desktop"), true);
      assert.equal(gioArgs[2], "http://127.0.0.1:3001/");
    }).pipe(
      Effect.provide(
        makeShellLayer((command) => {
          commands.push(command);
          if (command._tag === "StandardCommand" && command.command === "xdg-settings") {
            return makeProcess({ stdoutText: "zen.desktop\n" });
          }
          if (command._tag === "StandardCommand" && command.command === "gio") {
            return makeProcess({ exitCode: 0 });
          }
          return makeProcess({ exitCode: 1 });
        }),
      ),
    );
  });

  it.effect("does not open unsafe external URLs", () =>
    Effect.gen(function* () {
      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("file:///etc/passwd");

      assert.equal(result, false);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(makeShellLayer())),
  );

  it.effect("returns false when Electron rejects openExternal", () =>
    Effect.gen(function* () {
      openExternalMock.mockRejectedValue(new Error("open failed"));

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("https://example.com/path");

      assert.equal(result, false);
    }).pipe(Effect.provide(makeShellLayer())),
  );

  it.effect("reveals valid paths in the system file manager", () =>
    Effect.gen(function* () {
      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.revealPath("C:\\repo\\artifact.zip");

      assert.equal(result, true);
      assert.deepEqual(showItemInFolderMock.mock.calls, [["C:\\repo\\artifact.zip"]]);
    }).pipe(Effect.provide(makeShellLayer())),
  );

  it.effect("does not reveal invalid paths", () =>
    Effect.gen(function* () {
      const electronShell = yield* ElectronShell.ElectronShell;

      assert.equal(yield* electronShell.revealPath(""), false);
      assert.equal(yield* electronShell.revealPath("C:\\repo\\bad\0path.txt"), false);
      assert.equal(showItemInFolderMock.mock.calls.length, 0);
    }).pipe(Effect.provide(makeShellLayer())),
  );

  it.effect("returns false when Electron cannot reveal a path", () =>
    Effect.gen(function* () {
      showItemInFolderMock.mockImplementation(() => {
        throw new Error("reveal failed");
      });

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.revealPath("C:\\repo\\missing.txt");

      assert.equal(result, false);
    }).pipe(Effect.provide(makeShellLayer())),
  );
});
