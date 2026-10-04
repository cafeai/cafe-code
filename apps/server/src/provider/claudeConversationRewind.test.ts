// @effect-diagnostics nodeBuiltinImport:off
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  chmod,
  open,
  readFile,
  rename,
  lstat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { forkSession, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { describe, it, expect, vi } from "vitest";
import {
  readClaudeRewindSnapshot,
  readClaudeRewindMessageIds,
  remapClaudeRewindMessageIds,
  selectClaudeRewindCutoff,
  publishClaudeRewindCandidate,
} from "./claudeConversationRewind.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat) };
});

const sessionId = "70000000-0000-4000-8000-000000000001";
const first = "70000000-0000-4000-8000-000000000002";
const assistant = "70000000-0000-4000-8000-000000000003";
const attachment = "70000000-0000-4000-8000-000000000004";
const second = "70000000-0000-4000-8000-000000000005";

function transcript(): SessionStoreEntry[] {
  return [
    {
      type: "user",
      uuid: first,
      parentUuid: null,
      sessionId,
      isSidechain: false,
      message: { role: "user", content: "keep me" },
    },
    {
      type: "assistant",
      uuid: assistant,
      parentUuid: first,
      sessionId,
      isSidechain: false,
      message: { role: "assistant", content: [{ type: "text", text: "kept answer" }] },
    },
    {
      type: "attachment",
      uuid: attachment,
      parentUuid: assistant,
      sessionId,
      isSidechain: false,
      attachment: { type: "structured_output", data: { answer: "retained" } },
    },
    {
      type: "user",
      uuid: second,
      parentUuid: attachment,
      sessionId,
      isSidechain: false,
      message: { role: "user", content: "remove me" },
    },
  ];
}

describe("Claude conversation rewind boundary", () => {
  it("retains the final structured attachment instead of guessing the last assistant", () => {
    expect(
      selectClaudeRewindCutoff({ entries: transcript(), sessionId, firstRemovedTurnId: second }),
    ).toBe(attachment);
    expect(
      selectClaudeRewindCutoff({ entries: transcript(), sessionId, firstRemovedTurnId: first }),
    ).toBeNull();
  });

  it("rejects missing, duplicate, foreign-session and detached native prompt identities", () => {
    for (const entries of [
      transcript().slice(0, 3),
      [...transcript(), transcript()[3]!],
      transcript().map((entry) =>
        entry.uuid === second ? Object.assign({}, entry, { sessionId: first }) : entry,
      ),
      transcript().map((entry) =>
        entry.uuid === second ? Object.assign({}, entry, { isSidechain: true }) : entry,
      ),
      transcript().filter((entry) => entry.uuid !== attachment),
    ]) {
      expect(() =>
        selectClaudeRewindCutoff({ entries, sessionId, firstRemovedTurnId: second }),
      ).toThrow();
    }
  });

  it("uses the real public SDK to preserve the prefix and remap stable prompts on successive forks", async () => {
    let stored = transcript();
    let sourceSession = sessionId;
    let lineage: Record<string, string> | undefined;
    for (let generation = 0; generation < 2; generation += 1) {
      const oldSession = sourceSession;
      let output: SessionStoreEntry[] = [];
      const target = await forkSession(oldSession, {
        dir: process.cwd(),
        ...(generation === 0 ? { upToMessageId: attachment } : {}),
        sessionStore: {
          load: async () => structuredClone(stored),
          append: async (_key, entries) => {
            output = entries;
          },
        },
      });
      const next = remapClaudeRewindMessageIds({
        sourceSessionId: oldSession,
        targetSessionId: target.sessionId,
        entries: output,
        ...(lineage ? { previous: lineage } : {}),
      });
      expect(next[first]).toBeDefined();
      expect(next[first]).not.toBe(first);
      expect(next[second]).toBeUndefined();
      expect(output.some((entry) => entry.type === "attachment")).toBe(true);
      expect(JSON.stringify(output)).not.toContain("remove me");
      lineage = { ...next };
      stored = output;
      sourceSession = target.sessionId;
    }
  });

  it("rejects forged lineage, duplicate native targets and resource overflow", () => {
    expect(() => readClaudeRewindMessageIds({ [first]: "not-a-uuid" })).toThrow();
    expect(() => readClaudeRewindMessageIds({ [first]: second, [assistant]: second })).toThrow();
    expect(() => readClaudeRewindMessageIds(Array(4_097).fill(first))).toThrow();
    expect(() =>
      remapClaudeRewindMessageIds({
        sourceSessionId: sessionId,
        targetSessionId: second,
        entries: transcript(),
      }),
    ).toThrow();
  });

  it("commits private exact file identity and content, and rejects incomplete/nonprivate publication", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cafe-claude-rewind-"));
    try {
      const directory = path.join(root, "project");
      await mkdir(directory, { mode: 0o700 });
      const filePath = path.join(directory, `${sessionId}.jsonl`);
      const contents = `${transcript()
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`;
      await writeFile(filePath, contents, { mode: 0o600 });
      const input = { filePath, directories: [root, directory] };
      const before = await readClaudeRewindSnapshot(input);
      expect((await readClaudeRewindSnapshot(input)).commitment).toBe(before.commitment);
      await writeFile(filePath, contents.replace("remove me", "changed"));
      expect((await readClaudeRewindSnapshot(input)).commitment).not.toBe(before.commitment);
      await writeFile(filePath, contents.trimEnd());
      await expect(readClaudeRewindSnapshot(input)).rejects.toThrow("completely published");
      if (process.platform !== "win32") {
        await writeFile(filePath, contents);
        await chmod(filePath, 0o644);
        await expect(readClaudeRewindSnapshot(input)).rejects.toThrow("not private");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never writes conversation bytes after the destination directory moves during exclusive open", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const root = await mkdtemp(path.join(os.tmpdir(), "cafe-claude-rewind-race-"));
    try {
      const directory = path.join(root, "project");
      const displaced = path.join(root, "displaced-project");
      await mkdir(directory, { mode: 0o700 });
      const sourcePath = path.join(directory, `${sessionId}.jsonl`);
      const sourceBytes = `${transcript()
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`;
      await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
      const snapshot = await readClaudeRewindSnapshot({
        filePath: sourcePath,
        directories: [root, directory],
      });
      const targetName = "70000000-0000-4000-8000-000000000009.jsonl";
      const targetPath = path.join(directory, targetName);
      let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
      let windowsRenameRefusal: unknown;
      vi.mocked(open).mockImplementation(async (file, flags, mode) => {
        const handle = await actual.open(file, flags, mode);
        if (file === targetPath) {
          targetHandle = handle;
          try {
            try {
              await rename(directory, displaced);
            } catch (error) {
              // Some Windows filesystems refuse this precise namespace move
              // while the candidate handle is held. That is an observed OS
              // refusal, not evidence that Cafe's revalidation ran. Every
              // other error still fails the original guard assertion below.
              if (
                process.platform === "win32" &&
                error instanceof Error &&
                "code" in error &&
                error.code === "EPERM"
              ) {
                windowsRenameRefusal = error;
              }
              throw error;
            }
            await mkdir(directory, { mode: 0o700 });
          } catch (error) {
            // The production caller cannot close a handle the injected open
            // never returns. Retire this exact fixture-owned handle before
            // propagating any injection failure, including Windows EPERM.
            await handle.close();
            throw error;
          }
        }
        return handle;
      });
      const failure = await publishClaudeRewindCandidate({
        filePath: targetPath,
        snapshot,
        entries: transcript(),
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(targetHandle).toBeDefined();
      expect(targetHandle?.fd).toBe(-1);
      if (windowsRenameRefusal !== undefined) {
        // Admit only the exact error observed at the exact injected rename;
        // do not turn unrelated permission failures into passing coverage.
        expect(failure).toBe(windowsRenameRefusal);
        expect(await readFile(targetPath, "utf8")).toBe("");
        expect(await readFile(sourcePath, "utf8")).toBe(sourceBytes);
        await expect(lstat(displaced)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(failure).toBeInstanceOf(Error);
        expect(failure).toMatchObject({ message: expect.stringContaining("directory changed") });
        expect(await readFile(path.join(displaced, targetName), "utf8")).toBe("");
        await expect(readFile(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(path.join(displaced, `${sessionId}.jsonl`), "utf8")).toBe(
          sourceBytes,
        );
      }
    } finally {
      vi.mocked(open).mockImplementation(actual.open);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a post-open directory identity mismatch before writing on every host", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const root = await mkdtemp(path.join(os.tmpdir(), "cafe-claude-rewind-identity-"));
    try {
      const directory = path.join(root, "project");
      await mkdir(directory, { mode: 0o700 });
      const sourcePath = path.join(directory, `${sessionId}.jsonl`);
      const sourceBytes = `${transcript()
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`;
      await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
      const snapshot = await readClaudeRewindSnapshot({
        filePath: sourcePath,
        directories: [root, directory],
      });
      const targetPath = path.join(directory, "70000000-0000-4000-8000-000000000009.jsonl");
      let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
      let injectedChecks = 0;
      vi.mocked(open).mockImplementation(async (file, flags, mode) => {
        const handle = await actual.open(file, flags, mode);
        if (file === targetPath) targetHandle = handle;
        return handle;
      });
      vi.mocked(lstat).mockImplementation(async (file, options) => {
        const metadata = await actual.lstat(file, options);
        if (file === directory && targetHandle !== undefined) {
          // Leave all pre-open checks and all other paths' real metadata alone.
          // This exact post-open identity substitution proves Cafe's pre-write
          // fence even on hosts whose native handle locking prevents rename.
          injectedChecks += 1;
          return Object.assign(metadata, {
            ino: typeof metadata.ino === "bigint" ? metadata.ino + 1n : metadata.ino + 1,
          });
        }
        return metadata;
      });
      await expect(
        publishClaudeRewindCandidate({ filePath: targetPath, snapshot, entries: transcript() }),
      ).rejects.toThrow("directory changed");
      expect(injectedChecks).toBe(1);
      expect(targetHandle).toBeDefined();
      expect(targetHandle?.fd).toBe(-1);
      expect(await readFile(targetPath, "utf8")).toBe("");
      expect(await readFile(sourcePath, "utf8")).toBe(sourceBytes);
    } finally {
      vi.mocked(open).mockImplementation(actual.open);
      vi.mocked(lstat).mockImplementation(actual.lstat);
      await rm(root, { recursive: true, force: true });
    }
  });
});
