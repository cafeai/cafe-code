import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type ClaudeResumeRecovery =
  | { readonly status: "found"; readonly sessionId: string }
  | { readonly status: "missing" }
  | { readonly status: "inconclusive"; readonly reason: "io" | "unsafe" | "limit" | "ambiguous" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMITS = {
  entries: 4_096,
  fileBytes: 64 * 1_024 * 1_024,
  totalBytes: 256 * 1_024 * 1_024,
  lineBytes: 1_024 * 1_024,
  depth: 8,
  durationMs: 5_000,
};
type Limits = typeof DEFAULT_LIMITS;
class InspectionFailure extends Error {
  readonly reason: "io" | "unsafe" | "limit" | "ambiguous";
  constructor(reason: "io" | "unsafe" | "limit" | "ambiguous") {
    super("Claude conversation inspection was inconclusive.");
    this.reason = reason;
  }
}

/**
 * A recovery boundary, not a second transcript implementation. Only UUID
 * metadata is inspected; transcript contents and filesystem errors never escape
 * this module. Same-cwd resumes require only a regular-file check. Legacy cwd
 * relocation copies only bounded, no-follow regular files into private targets.
 * Native Claude 2.1.223+ also supports cross-project lookup, but older configured
 * CLIs still need this relocation compatibility path.
 * https://code.claude.com/docs/en/sessions#resume-a-session
 */
export async function recoverClaudeResume(
  input: {
    readonly configDirectory: string;
    readonly projectKey: string;
    readonly sessionId: string;
    readonly checkpoint?: string;
    readonly signal?: AbortSignal;
  },
  options?: {
    readonly limits?: Partial<Limits>;
    readonly io?: typeof fs;
    readonly now?: () => number;
  },
): Promise<ClaudeResumeRecovery> {
  const io = options?.io ?? fs;
  const limits = { ...DEFAULT_LIMITS, ...options?.limits };
  const now = options?.now ?? Date.now;
  const deadline = now() + limits.durationMs;
  let inspectedEntries = 0;
  let processedBytes = 0;
  const check = () => {
    if (input.signal?.aborted || now() >= deadline) throw new InspectionFailure("limit");
  };
  const stat = async (file: string) => {
    check();
    try {
      const info = await io.lstat(file);
      check();
      if (info.isSymbolicLink()) throw new InspectionFailure("unsafe");
      return info;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const directoryEntries = async (directory: string): Promise<string[]> => {
    const info = await stat(directory);
    if (!info) return [];
    if (!info.isDirectory()) throw new InspectionFailure("unsafe");
    const result: string[] = [];
    const handle = await io.opendir(directory);
    try {
      for await (const entry of handle) {
        check();
        if (++inspectedEntries > limits.entries) throw new InspectionFailure("limit");
        result.push(entry.name);
      }
    } finally {
      await handle.close().catch(() => {});
    }
    return result.toSorted();
  };
  const readBounded = async (file: string, consume: (chunk: Uint8Array) => Promise<void>) => {
    const before = await stat(file);
    if (!before?.isFile()) throw new InspectionFailure("unsafe");
    if (before.size > limits.fileBytes) throw new InspectionFailure("limit");
    const handle = await io.open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
        throw new InspectionFailure("unsafe");
      const buffer = Buffer.alloc(64 * 1_024);
      let size = 0;
      while (true) {
        check();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        check();
        if (!bytesRead) break;
        size += bytesRead;
        processedBytes += bytesRead;
        if (size > limits.fileBytes || processedBytes > limits.totalBytes)
          throw new InspectionFailure("limit");
        await consume(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
        throw new InspectionFailure("io");
    } finally {
      await handle.close();
    }
  };
  // Compensate only a file/directory created by this invocation and still
  // carrying its exact filesystem identity. Never remove another repair's copy.
  const removeOwned = async (
    target: string,
    identity: { dev: number; ino: number },
    recursive: boolean,
  ) => {
    const current = await io.lstat(target).catch(() => undefined);
    if (
      current?.dev === identity.dev &&
      current.ino === identity.ino &&
      !current.isSymbolicLink()
    ) {
      await io.rm(target, { force: true, recursive });
    }
  };
  const copyFile = async (source: string, target: string) => {
    const existing = await stat(target);
    if (existing) {
      if (!existing.isFile()) throw new InspectionFailure("unsafe");
      return;
    }
    check();
    // A second startup must never mistake an in-progress write for a complete
    // transcript. Publish a fully flushed private staging inode exclusively by
    // hard link; unsupported filesystems fail closed rather than overwriting.
    const staging = path.join(path.dirname(target), `.cafe-resume-${randomUUID()}.tmp`);
    const handle = await io.open(
      staging,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const identity = await handle.stat();
    try {
      await readBounded(source, async (chunk) => {
        let offset = 0;
        while (offset < chunk.length) {
          check();
          const written = await handle.write(chunk, offset, chunk.length - offset, null);
          if (written.bytesWritten <= 0) throw new InspectionFailure("io");
          offset += written.bytesWritten;
        }
      });
      check();
      await handle.sync();
      check();
      await io.link(staging, target);
      check();
    } catch (error) {
      await handle.close();
      await removeOwned(target, identity, false);
      await removeOwned(staging, identity, false);
      throw error;
    }
    await handle.close();
    await removeOwned(staging, identity, false);
  };
  const copyDirectory = async (source: string, target: string, depth: number): Promise<void> => {
    if (depth > limits.depth) throw new InspectionFailure("limit");
    const sourceInfo = await stat(source);
    if (!sourceInfo) return;
    if (!sourceInfo.isDirectory()) throw new InspectionFailure("unsafe");
    const existing = await stat(target);
    if (existing) {
      if (!existing.isDirectory()) throw new InspectionFailure("unsafe");
      return;
    }
    check();
    await io.mkdir(target, { mode: 0o700 });
    const identity = await io.lstat(target);
    try {
      for (const entry of await directoryEntries(source)) {
        const from = path.join(source, entry);
        const to = path.join(target, entry);
        const info = await stat(from);
        if (info?.isDirectory()) await copyDirectory(from, to, depth + 1);
        else if (info?.isFile()) await copyFile(from, to);
        else throw new InspectionFailure("unsafe");
      }
    } catch (error) {
      await removeOwned(target, identity, true);
      throw error;
    }
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
      throw new InspectionFailure("unsafe");
    const projects = path.join(input.configDirectory, "projects");
    const project = path.join(projects, input.projectKey);
    // Validate every provider-controlled descendant before inspecting children.
    const projectsInfo = await stat(projects);
    if (!projectsInfo) return { status: "missing" };
    if (!projectsInfo.isDirectory()) throw new InspectionFailure("unsafe");
    const projectInfo = await stat(project);
    if (projectInfo && !projectInfo.isDirectory()) throw new InspectionFailure("unsafe");
    const target = path.join(project, `${input.sessionId}.jsonl`);
    const existing = await stat(target);
    if (existing) {
      if (!existing.isFile()) throw new InspectionFailure("unsafe");
      return { status: "found", sessionId: input.sessionId };
    }
    const matches: string[] = [];
    for (const entry of await directoryEntries(projects)) {
      const candidate = path.join(projects, entry);
      if (candidate === project) continue;
      const info = await stat(candidate);
      if (!info?.isDirectory()) continue;
      const transcript = await stat(path.join(candidate, `${input.sessionId}.jsonl`));
      if (transcript) {
        if (!transcript.isFile()) throw new InspectionFailure("unsafe");
        matches.push(candidate);
      }
    }
    if (matches.length > 1) throw new InspectionFailure("ambiguous");
    const source = matches[0];
    if (source) {
      if (!projectInfo) await io.mkdir(project, { mode: 0o700 });
      // Copy sidechains first. A failed copy must not leave a main transcript
      // that the next start would mistake for complete relocation.
      await copyDirectory(
        path.join(source, input.sessionId),
        path.join(project, input.sessionId),
        0,
      );
      await copyFile(path.join(source, `${input.sessionId}.jsonl`), target);
      return { status: "found", sessionId: input.sessionId };
    }
    if (!input.checkpoint || !projectInfo) return { status: "missing" };
    if (input.checkpoint.length > 512) throw new InspectionFailure("limit");
    let found: string | undefined;
    for (const name of await directoryEntries(project)) {
      if (!name.endsWith(".jsonl") || !UUID.test(name.slice(0, -6))) continue;
      let carry = Buffer.alloc(0);
      let matchesCheckpoint = false;
      const inspectLine = (line: Buffer) => {
        if (line.length > limits.lineBytes) throw new InspectionFailure("limit");
        if (line.length === 0) return;
        try {
          const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
          if (
            value &&
            typeof value === "object" &&
            "uuid" in value &&
            value.uuid === input.checkpoint
          )
            matchesCheckpoint = true;
        } catch (error) {
          if (error instanceof InspectionFailure) throw error;
          // A corrupt/incomplete frame cannot prove that the checkpoint is
          // absent. Keep the durable identity and let the user retry/recover.
          throw new InspectionFailure("io");
        }
      };
      await readBounded(path.join(project, name), async (chunk) => {
        const bytes = Buffer.concat([carry, chunk]);
        let start = 0;
        for (let index = 0; index < bytes.length; index++) {
          if (bytes[index] === 10) {
            inspectLine(bytes.subarray(start, index));
            start = index + 1;
          }
        }
        carry = Buffer.from(bytes.subarray(start));
        if (carry.length > limits.lineBytes) throw new InspectionFailure("limit");
      });
      if (carry.length) inspectLine(carry);
      if (matchesCheckpoint) {
        if (found) throw new InspectionFailure("ambiguous");
        found = name.slice(0, -6);
      }
    }
    return found ? { status: "found", sessionId: found } : { status: "missing" };
  } catch (error) {
    return {
      status: "inconclusive",
      reason: error instanceof InspectionFailure ? error.reason : "io",
    };
  }
}
