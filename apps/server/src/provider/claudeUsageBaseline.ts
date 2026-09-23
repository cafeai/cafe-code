import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { decodeClaudeCumulativeUsage, type ClaudeUsageBaseline } from "./claudeUsageAccounting.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITS = { bytes: 4 * 1_024 * 1_024, lineBytes: 128 * 1_024, durationMs: 1_000 };
const unavailable: ClaudeUsageBaseline = { status: "unavailable" };

/**
 * Claude Code 2.1.277+ restores the last session-matching `cost-state` record
 * before running a resumed/forked conversation. Its source `Upt`/`hZ` functions
 * in the verified 2.1.278 native artifact save/restore `modelUsage`; SDK 0.3.278
 * SDKResultMessage documents the same restored-total contract.
 *
 * Read only that numeric offset before launching the CLI. This is subtraction,
 * never a history import or an accounting backfill. The public get_usage method
 * also fetches subscription data and may race auto-resumed inference, so it is
 * not a safe zero-work baseline. An inconclusive local read loses no session:
 * the caller keeps observed input and uses conservative incomplete accounting.
 */
export async function readClaudeUsageBaseline(
  input: {
    readonly configDirectory: string;
    readonly projectKey: string;
    readonly sessionId: string;
    readonly signal?: AbortSignal;
  },
  options?: {
    readonly limits?: Partial<typeof LIMITS>;
    readonly io?: typeof fs;
    readonly now?: () => number;
  },
): Promise<ClaudeUsageBaseline> {
  const limits = { ...LIMITS, ...options?.limits };
  const io = options?.io ?? fs;
  const now = options?.now ?? Date.now;
  const deadline = now() + limits.durationMs;
  const check = () => {
    if (input.signal?.aborted || now() >= deadline) throw new Error("Baseline read expired.");
  };
  try {
    if (
      !UUID.test(input.sessionId) ||
      !input.projectKey ||
      input.projectKey === "." ||
      input.projectKey === ".." ||
      input.projectKey.includes("/") ||
      input.projectKey.includes("\\") ||
      input.projectKey.includes("\0")
    )
      return unavailable;
    const projects = path.join(input.configDirectory, "projects");
    const project = path.join(projects, input.projectKey);
    const target = path.join(project, `${input.sessionId}.jsonl`);
    const directories = [];
    // A safe leaf is insufficient if a provider-controlled ancestor redirects
    // it. Keep identities and recheck the complete configured descendant chain.
    for (const directory of [input.configDirectory, projects, project]) {
      check();
      const stat = await io.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return unavailable;
      directories.push({ directory, stat });
    }
    check();
    const before = await io.lstat(target);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      (typeof process.getuid === "function" &&
        (before.uid !== process.getuid() || (before.mode & 0o077) !== 0))
    )
      return unavailable;
    const handle = await io.open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      check();
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
        return unavailable;
      let position = opened.size;
      let readBytes = 0;
      let suffix = Buffer.alloc(0);
      let candidate: ClaudeUsageBaseline | undefined;
      const consume = (line: Buffer): ClaudeUsageBaseline | undefined => {
        if (line.length > limits.lineBytes) return unavailable;
        const text = line.toString("utf8").trim();
        if (!text) return undefined;
        // Parsing is bounded to one line, and only the numeric decoder's map
        // survives it. No prompt, output, path, error or arbitrary key escapes.
        const row: unknown = JSON.parse(text);
        if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
        const record = row as Record<string, unknown>;
        if (record.type !== "cost-state" || record.sessionId !== input.sessionId) return undefined;
        const models = decodeClaudeCumulativeUsage(record.modelUsage);
        return models ? { status: "known", models } : unavailable;
      };
      while (position > 0 && !candidate) {
        check();
        const length = Math.min(64 * 1_024, position, limits.bytes - readBytes);
        if (length <= 0) return unavailable;
        position -= length;
        const buffer = Buffer.alloc(length);
        const read = await handle.read(buffer, 0, length, position);
        if (read.bytesRead !== length) return unavailable;
        // A writer can have appended a syntactically complete object without
        // publishing its newline yet. Do not treat that in-flight final record
        // (or an older row behind it) as an authoritative saved offset.
        if (readBytes === 0 && buffer[buffer.length - 1] !== 10) return unavailable;
        readBytes += length;
        check();
        const combined = Buffer.concat([buffer, suffix]);
        let end = combined.length;
        for (let index = end - 1; index >= 0; index -= 1) {
          if (combined[index] !== 10) continue;
          candidate = consume(combined.subarray(index + 1, end));
          if (candidate) break;
          end = index;
        }
        if (!candidate) {
          if (end > limits.lineBytes) return unavailable;
          suffix = combined.subarray(0, end);
        }
      }
      if (!candidate) {
        candidate = consume(suffix);
        // Only a complete scan can prove that an old transcript has no saved
        // cost-state record. Hitting any limit must never invent a zero offset.
        if (!candidate) candidate = { status: "known", models: new Map() };
      }
      check();
      const after = await handle.stat();
      const leaf = await io.lstat(target);
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        leaf.isSymbolicLink() ||
        leaf.dev !== before.dev ||
        leaf.ino !== before.ino
      )
        return unavailable;
      for (const { directory, stat } of directories) {
        check();
        const current = await io.lstat(directory);
        if (!current.isDirectory() || current.dev !== stat.dev || current.ino !== stat.ino)
          return unavailable;
      }
      return candidate;
    } finally {
      await handle.close();
    }
  } catch {
    // Accounting enrichment is nonfatal. Never expose a provider-owned file
    // name, transcript parse error, or filesystem exception to diagnostics.
    return unavailable;
  }
}
