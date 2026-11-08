import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const CHUNK_BYTES = 64 * 1024;
const POLL_INTERVAL_MS = 200;

function isPrivateLog(stat) {
  return (
    stat.isFile() &&
    stat.nlink === 1n &&
    stat.uid === BigInt(process.getuid()) &&
    (stat.mode & 0o077n) === 0n
  );
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Mirror only this launch's private files. The app keeps its LaunchServices
 * parent and file-backed stdio, so losing the terminal cannot retire it or
 * break a surviving native writer's stdout/stderr pipes. No PID is consulted.
 *
 * Each stream holds one no-follow, nonblocking descriptor, one 64 KiB buffer
 * and at most one native read/write. Bigint offsets avoid rounding large logs;
 * EOF polling is cancellable and never overlaps a previous read or output
 * write. File replacement/unsafe ownership fails instead of following a new
 * name, and cancellation joins admitted IO before closing the exact handle.
 */
export async function followDesktopLogs({
  stdoutPath,
  stderrPath,
  stdoutIdentity,
  stderrIdentity,
  signal,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  if (signal.aborted) return;
  const retired = new AbortController();
  const stop = () => retired.abort();
  let outputFailure;
  const onOutputError = () => {
    outputFailure = new Error("The desktop log output stream closed.");
    stop();
  };
  // Register retirement before opening either file. The destinations belong
  // to the caller; never end or destroy them during follower cleanup.
  signal.addEventListener("abort", stop, { once: true });
  stdout.on("error", onOutputError);
  stderr.on("error", onOutputError);
  stdout.on("close", stop);
  stderr.on("close", stop);

  const follow = async (path, destination, created) => {
    let file;
    try {
      if (retired.signal.aborted) return;
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const identity = await file.stat({ bigint: true });
      if (!isPrivateLog(identity) || !sameFile(created, identity))
        throw new Error("Unsafe desktop log file.");
      const buffer = Buffer.alloc(CHUNK_BYTES);
      let position = 0n;
      while (!retired.signal.aborted) {
        const held = await file.stat({ bigint: true });
        const named = await lstat(path, { bigint: true });
        if (
          !isPrivateLog(held) ||
          !isPrivateLog(named) ||
          !sameFile(identity, held) ||
          !sameFile(identity, named)
        )
          throw new Error("The desktop log file changed.");
        if (retired.signal.aborted) break;
        // Truncation keeps the same admitted inode. Rotation/replacement does
        // not: it fails the exact named/held identity checks above.
        if (position > held.size) position = 0n;
        const available = held.size - position;
        if (available > 0n) {
          const length = Number(available > BigInt(CHUNK_BYTES) ? BigInt(CHUNK_BYTES) : available);
          const { bytesRead } = await file.read(buffer, 0, length, position);
          if (retired.signal.aborted) break;
          if (bytesRead > 0) {
            position += BigInt(bytesRead);
            // Await actual write completion, including backpressure, before
            // reusing the buffer or releasing native file/output ownership.
            await new Promise((resolve, reject) => {
              destination.write(buffer.subarray(0, bytesRead), (error) =>
                error ? reject(error) : resolve(),
              );
            });
            continue;
          }
        }
        await delay(POLL_INTERVAL_MS, undefined, { signal: retired.signal }).catch((error) => {
          if (error?.name !== "AbortError") throw error;
        });
      }
    } finally {
      await file?.close();
    }
  };

  try {
    const results = await Promise.allSettled(
      [
        [stdoutPath, stdout, stdoutIdentity],
        [stderrPath, stderr, stderrIdentity],
      ].map(async ([path, destination, created]) => {
        try {
          await follow(path, destination, created);
        } catch {
          stop();
          // Native filesystem/output errors can contain paths or received
          // content. Retain only the fixed failure category at this boundary.
          throw new Error("Could not follow this launch's desktop logs.");
        }
      }),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Could not follow this launch's desktop logs.");
    if (outputFailure) throw outputFailure;
  } finally {
    stop();
    signal.removeEventListener("abort", stop);
    stdout.off("error", onOutputError);
    stderr.off("error", onOutputError);
    stdout.off("close", stop);
    stderr.off("close", stop);
  }
}
