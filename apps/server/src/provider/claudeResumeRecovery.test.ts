import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { recoverClaudeResume } from "./claudeResumeRecovery.ts";

const SESSION = "550e8400-e29b-41d4-a716-446655440000";
const REPAIRED = "550e8400-e29b-41d4-a716-446655440001";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-recovery-test-"));
  roots.push(configDirectory);
  const project = path.join(configDirectory, "projects", "project");
  await fs.mkdir(project, { recursive: true });
  return { configDirectory, projectKey: "project", sessionId: SESSION, project };
}

describe("Claude resume inspection", () => {
  it("proves absence only after successful inspection", async () => {
    expect(await recoverClaudeResume(await fixture())).toEqual({ status: "missing" });
  });
  it("preserves identity when the directory cannot be read", async () => {
    const input = await fixture();
    const io = {
      ...fs,
      opendir: async () => {
        throw Object.assign(new Error("private path"), { code: "EACCES" });
      },
    } as typeof fs;
    expect(await recoverClaudeResume(input, { io })).toEqual({
      status: "inconclusive",
      reason: "io",
    });
  });
  it("treats existence-check failures as inconclusive, not missing", async () => {
    const input = await fixture();
    const io = {
      ...fs,
      lstat: async () => {
        throw Object.assign(new Error("private path"), { code: "EIO" });
      },
    } as typeof fs;
    expect(await recoverClaudeResume(input, { io })).toEqual({
      status: "inconclusive",
      reason: "io",
    });
  });
  it("resumes an existing large transcript without reading it", async () => {
    const input = await fixture();
    await fs.writeFile(path.join(input.project, `${SESSION}.jsonl`), "existing");
    expect(await recoverClaudeResume(input, { limits: { fileBytes: 1 } })).toEqual({
      status: "found",
      sessionId: SESSION,
    });
  });
  it("relocates a private transcript and sidechains without changing the source", async () => {
    const input = await fixture();
    const source = path.join(input.configDirectory, "projects", "old");
    await fs.mkdir(path.join(source, SESSION, "subagents"), { recursive: true });
    await fs.writeFile(path.join(source, `${SESSION}.jsonl`), "original\n");
    await fs.writeFile(path.join(source, SESSION, "subagents", "agent-a.jsonl"), "child\n");
    expect(await recoverClaudeResume(input)).toEqual({ status: "found", sessionId: SESSION });
    expect(await fs.readFile(path.join(input.project, `${SESSION}.jsonl`), "utf8")).toBe(
      "original\n",
    );
    expect(await fs.readFile(path.join(source, `${SESSION}.jsonl`), "utf8")).toBe("original\n");
  });
  it("does not publish a partial main transcript on a copy failure", async () => {
    const input = await fixture();
    const source = path.join(input.configDirectory, "projects", "old");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, `${SESSION}.jsonl`), "too large");
    expect(await recoverClaudeResume(input, { limits: { fileBytes: 2 } })).toEqual({
      status: "inconclusive",
      reason: "limit",
    });
    await expect(fs.stat(path.join(input.project, `${SESSION}.jsonl`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("compensates a failed atomic publication without modifying the source", async () => {
    const input = await fixture();
    const source = path.join(input.configDirectory, "projects", "old");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, `${SESSION}.jsonl`), "saved conversation");
    const io = {
      ...fs,
      link: async () => {
        throw Object.assign(new Error("private storage"), { code: "EACCES" });
      },
    } as typeof fs;
    expect(await recoverClaudeResume(input, { io })).toEqual({
      status: "inconclusive",
      reason: "io",
    });
    expect(await fs.readdir(input.project)).toEqual([]);
    expect(await fs.readFile(path.join(source, `${SESSION}.jsonl`), "utf8")).toBe(
      "saved conversation",
    );
  });
  it("does not choose an arbitrary duplicated relocated conversation", async () => {
    const input = await fixture();
    for (const name of ["copy-a", "copy-b"]) {
      const source = path.join(input.configDirectory, "projects", name);
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, `${SESSION}.jsonl`), name);
    }
    expect(await recoverClaudeResume(input)).toEqual({
      status: "inconclusive",
      reason: "ambiguous",
    });
  });
  it("bounds candidate enumeration", async () => {
    const input = await fixture();
    await fs.mkdir(path.join(input.configDirectory, "projects", "extra"));
    expect(await recoverClaudeResume(input, { limits: { entries: 1 } })).toEqual({
      status: "inconclusive",
      reason: "limit",
    });
  });
  it("bounds elapsed work and honors a pre-aborted operation", async () => {
    const input = await fixture();
    let now = 0;
    expect(
      await recoverClaudeResume(input, { now: () => now++, limits: { durationMs: 1 } }),
    ).toEqual({ status: "inconclusive", reason: "limit" });
    const abort = new AbortController();
    abort.abort();
    expect(await recoverClaudeResume({ ...input, signal: abort.signal })).toEqual({
      status: "inconclusive",
      reason: "limit",
    });
  });
  it("repairs only an unambiguous checkpoint and bounds line memory", async () => {
    const input = await fixture();
    const transcript = path.join(input.project, `${REPAIRED}.jsonl`);
    await fs.writeFile(transcript, JSON.stringify({ uuid: "checkpoint" }) + "\n");
    expect(await recoverClaudeResume({ ...input, checkpoint: "checkpoint" })).toEqual({
      status: "found",
      sessionId: REPAIRED,
    });
    expect(
      await recoverClaudeResume(
        { ...input, checkpoint: "checkpoint" },
        { limits: { lineBytes: 5 } },
      ),
    ).toEqual({ status: "inconclusive", reason: "limit" });
    expect(
      await recoverClaudeResume(
        { ...input, checkpoint: "checkpoint" },
        { limits: { totalBytes: 5 } },
      ),
    ).toEqual({ status: "inconclusive", reason: "limit" });
    await fs.writeFile(
      path.join(input.project, "550e8400-e29b-41d4-a716-446655440002.jsonl"),
      JSON.stringify({ uuid: "checkpoint" }),
    );
    expect(await recoverClaudeResume({ ...input, checkpoint: "checkpoint" })).toEqual({
      status: "inconclusive",
      reason: "ambiguous",
    });
  });
  it("rejects symlinked transcripts rather than following outside storage", async () => {
    const input = await fixture();
    const source = path.join(input.configDirectory, "outside");
    await fs.writeFile(source, "private");
    try {
      await fs.symlink(source, path.join(input.project, `${SESSION}.jsonl`));
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    expect(await recoverClaudeResume(input)).toEqual({ status: "inconclusive", reason: "unsafe" });
  });
  it("does not interpret malformed checkpoint data as confirmed absence", async () => {
    const input = await fixture();
    await fs.writeFile(path.join(input.project, `${REPAIRED}.jsonl`), "{incomplete");
    expect(await recoverClaudeResume({ ...input, checkpoint: "checkpoint" })).toEqual({
      status: "inconclusive",
      reason: "io",
    });
  });
});
