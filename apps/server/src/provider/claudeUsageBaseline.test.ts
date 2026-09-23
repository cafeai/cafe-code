import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readClaudeUsageBaseline } from "./claudeUsageBaseline.ts";

const SESSION = "550e8400-e29b-41d4-a716-446655440000";
const MODEL = "claude-sonnet-5";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(lines: string[]) {
  const configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-usage-baseline-"));
  roots.push(configDirectory);
  const project = path.join(configDirectory, "projects", "project");
  await fs.mkdir(project, { recursive: true });
  const file = path.join(project, `${SESSION}.jsonl`);
  await fs.writeFile(file, lines.join("\n") + "\n", { mode: 0o600 });
  return { configDirectory, projectKey: "project", sessionId: SESSION, file };
}
const cost = (inputTokens: number, sessionId = SESSION) =>
  JSON.stringify({
    type: "cost-state",
    sessionId,
    privateSentinel: "not retained",
    modelUsage: {
      [MODEL]: {
        inputTokens,
        outputTokens: 40,
        cacheReadInputTokens: 500,
        cacheCreationInputTokens: 10,
        thinkingTokens: 20,
        costUSD: 999,
      },
    },
  });

describe("Claude pre-launch usage baseline", () => {
  it("reads only the newest exact-session numeric record from a bounded transcript tail", async () => {
    const input = await fixture([
      JSON.stringify({ type: "user", text: "private".repeat(20000) }),
      cost(10),
      cost(100),
      cost(900, "550e8400-e29b-41d4-a716-446655440001"),
      JSON.stringify({ type: "assistant", text: "private output" }),
    ]);
    const result = await readClaudeUsageBaseline(input, { limits: { bytes: 1024 } });
    expect(result.status).toBe("known");
    if (result.status !== "known") return;
    expect([...result.models]).toEqual([
      [
        MODEL,
        {
          inputTokens: 610,
          cachedInputTokens: 500,
          cacheWriteInputTokens: 10,
          outputTokens: 40,
          reasoningOutputTokens: 20,
        },
      ],
    ]);
    expect(JSON.stringify([...result.models])).not.toMatch(/private|costUSD|sessionId/);
  });

  it("proves an absent saved offset only after a complete read", async () => {
    const input = await fixture([JSON.stringify({ type: "user", text: "new transcript" })]);
    expect(await readClaudeUsageBaseline(input)).toEqual({ status: "known", models: new Map() });
    expect(await readClaudeUsageBaseline(input, { limits: { bytes: 5 } })).toEqual({
      status: "unavailable",
    });
  });

  it("rejects malformed/oversized rows and invalid counters without falling back to older history", async () => {
    for (const line of [
      '{"type":"cost-state",',
      cost(-1),
      JSON.stringify({
        type: "cost-state",
        sessionId: SESSION,
        modelUsage: { "private/path": { inputTokens: 100 } },
      }),
    ]) {
      const input = await fixture([cost(20), line]);
      expect(await readClaudeUsageBaseline(input)).toEqual({ status: "unavailable" });
    }
    expect(
      await readClaudeUsageBaseline(await fixture([cost(20)]), { limits: { lineBytes: 8 } }),
    ).toEqual({ status: "unavailable" });
    const partial = await fixture([cost(20)]);
    await fs.appendFile(partial.file, cost(30));
    expect(await readClaudeUsageBaseline(partial)).toEqual({ status: "unavailable" });
  });

  it("does not read unsafe identity or symlinked files", async () => {
    const input = await fixture([cost(20)]);
    expect(await readClaudeUsageBaseline({ ...input, sessionId: "../other" })).toEqual({
      status: "unavailable",
    });
    expect(await readClaudeUsageBaseline({ ...input, projectKey: "../other" })).toEqual({
      status: "unavailable",
    });
    const original = input.file + ".original";
    await fs.rename(input.file, original);
    try {
      await fs.symlink(original, input.file);
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    expect(await readClaudeUsageBaseline(input)).toEqual({ status: "unavailable" });
  });

  it("keeps nonprivate POSIX transcripts and I/O/deadline failures inconclusive", async () => {
    const input = await fixture([cost(20)]);
    const aborted = new AbortController();
    aborted.abort();
    expect(await readClaudeUsageBaseline({ ...input, signal: aborted.signal })).toEqual({
      status: "unavailable",
    });
    expect(await readClaudeUsageBaseline(input, { limits: { durationMs: 0 } })).toEqual({
      status: "unavailable",
    });
    const io = {
      ...fs,
      lstat: async () => {
        throw new Error("private filesystem detail");
      },
    } as typeof fs;
    expect(await readClaudeUsageBaseline(input, { io })).toEqual({ status: "unavailable" });
    if (process.platform !== "win32") {
      await fs.chmod(input.file, 0o644);
      expect(await readClaudeUsageBaseline(input)).toEqual({ status: "unavailable" });
    }
  });

  it("rejects a file changed or replaced during inspection", async () => {
    const input = await fixture([cost(20)]);
    const io = {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args);
        const original = handle.read.bind(handle);
        handle.read = (async (...readArgs: Parameters<typeof original>) => {
          const result = await original(...readArgs);
          await fs.appendFile(input.file, cost(30) + "\n");
          return result;
        }) as typeof handle.read;
        return handle;
      },
    } as typeof fs;
    expect(await readClaudeUsageBaseline(input, { io })).toEqual({ status: "unavailable" });
  });
});
