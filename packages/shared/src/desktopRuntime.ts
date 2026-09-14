import { createHash } from "node:crypto";
import * as path from "node:path";

export const DESKTOP_RUNTIME_PATH_MAX_BYTES = 56;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Preserve all UUID bits while leaving room for application-owned Unix sockets. */
export function desktopIncarnationName(incarnation: string): string {
  if (!uuidPattern.test(incarnation)) throw new Error("Invalid desktop incarnation.");
  return Buffer.from(incarnation.replaceAll("-", ""), "hex").toString("base64url");
}

export function isDesktopIncarnationName(name: string): boolean {
  return (
    /^[A-Za-z0-9_-]{22}$/.test(name) &&
    Buffer.from(name, "base64url").toString("base64url") === name
  );
}

/** Linux-only paths use POSIX spelling even when inspected on another host.
 * Six hash bytes distinguish Cafe environments without exposing their data paths. */
export function desktopRuntimeDirectory(stateDir: string, uid: number): string {
  if (!Number.isInteger(uid) || uid < 0 || uid > 0xffff_fffe)
    throw new Error("Invalid Linux user ID.");
  return path.posix.join(
    `/run/user/${uid}`,
    `cfd-${createHash("sha256").update(stateDir).digest().subarray(0, 6).toString("base64url")}`,
  );
}

/** Linux sun_path has 108 bytes including NUL. A 56-byte directory leaves
 * 50 bytes for an application's socket basename and one slash (unix(7)). */
export function desktopInstanceDirectory(
  stateDir: string,
  uid: number,
  incarnation: string,
): string {
  const directory = path.posix.join(
    desktopRuntimeDirectory(stateDir, uid),
    desktopIncarnationName(incarnation),
  );
  if (Buffer.byteLength(directory) > DESKTOP_RUNTIME_PATH_MAX_BYTES)
    throw new Error("Desktop runtime path exceeds its socket budget.");
  return directory;
}

export function isDesktopInstanceDirectory(
  directory: string,
  stateDir: string,
  uid: number,
  incarnation: string,
): boolean {
  try {
    return directory === desktopInstanceDirectory(stateDir, uid, incarnation);
  } catch {
    return false;
  }
}
