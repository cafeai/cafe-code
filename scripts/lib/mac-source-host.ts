// This boundary retains exact native child handles and close/signal ownership.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
// Native checkout/fixture IO retains its existing descriptor, identity and lifetime semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import {
  existsSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
// Host-native path spelling must agree with the existing native file and tool boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAC_LOCAL_NETWORK_USAGE_DESCRIPTION,
  MAC_MICROPHONE_USAGE_DESCRIPTION,
} from "./mac-app-privacy.ts";

// A native host is signed once, independently of any checkout or JS build. A
// native source/protocol change needs a new version and explicit OS consent;
// never silently replace the app that owns an existing ad hoc privacy grant.
export const MAC_SOURCE_HOST_VERSION = 1;
export const MAC_SOURCE_HOST_IDENTIFIER = "com.cafeai.cafecode.debug.source-host.v1";
const APP_NAME = "Cafe Code (Debug)";
const SOURCE_PATH = fileURLToPath(
  new URL("../../apps/desktop/native/mac-source-host.m", import.meta.url),
);

interface CommandResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly error?: Error;
}

interface HostOptions {
  readonly homeDirectory: string;
  readonly architecture?: string;
  readonly sourcePath?: string;
  readonly run?: (command: string, args: readonly string[]) => CommandResult;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function hostInfoPlist(): string {
  const strings: Record<string, string> = {
    CFBundleIdentifier: MAC_SOURCE_HOST_IDENTIFIER,
    CFBundleExecutable: APP_NAME,
    CFBundleName: APP_NAME,
    CFBundleDisplayName: APP_NAME,
    CFBundlePackageType: "APPL",
    CFBundleVersion: String(MAC_SOURCE_HOST_VERSION),
    CFBundleShortVersionString: "1.0",
    LSMinimumSystemVersion: "15.0",
    NSLocalNetworkUsageDescription: MAC_LOCAL_NETWORK_USAGE_DESCRIPTION,
    NSMicrophoneUsageDescription: MAC_MICROPHONE_USAGE_DESCRIPTION,
  };
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict>\n' +
    Object.entries(strings)
      .map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`)
      .join("\n") +
    "\n<key>LSUIElement</key><true/>\n</dict></plist>\n"
  );
}

function assertPrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error("The source host requires its own private directory.");
  }
}

function readOwnedFile(path: string, maximumBytes = 65536): Buffer {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      stat.size > maximumBytes
    ) {
      throw new Error("Invalid source host file ownership, type, or size.");
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Native clang output is a thin little-endian 64-bit Mach-O on supported Macs.
 * Refuse missing/duplicate UUIDs instead of falling back to Electron's UUID. */
export function readMacSourceHostUuid(bytes: Buffer): string {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error("The source host is not a 64-bit Mach-O executable.");
  }
  const count = bytes.readUInt32LE(16);
  const end = 32 + bytes.readUInt32LE(20);
  if (count > 256 || end > bytes.length) throw new Error("Invalid source host load commands.");
  let cursor = 32;
  const uuids: string[] = [];
  for (let index = 0; index < count; index++) {
    if (cursor + 8 > end) throw new Error("Truncated source host load command.");
    const command = bytes.readUInt32LE(cursor);
    const size = bytes.readUInt32LE(cursor + 4);
    if (size < 8 || cursor + size > end) throw new Error("Invalid source host load command.");
    if (command === 0x1b) {
      if (size !== 24) throw new Error("Invalid source host UUID command.");
      uuids.push(bytes.subarray(cursor + 8, cursor + 24).toString("hex"));
    }
    cursor += size;
  }
  if (cursor !== end || uuids.length !== 1 || /^0+$/u.test(uuids[0]!)) {
    throw new Error("The source host requires one unique main executable UUID.");
  }
  return uuids[0]!;
}

export function prepareMacSourceHost(options: HostOptions): string {
  if (!isAbsolute(options.homeDirectory)) throw new Error("The source host home must be absolute.");
  const architecture = options.architecture ?? process.arch;
  if (architecture !== "arm64" && architecture !== "x64") {
    throw new Error("Unsupported source host architecture.");
  }
  const run =
    options.run ??
    ((command, args) => spawnSync(command, [...args], { encoding: "utf8", shell: false }));
  const execute = (command: string, args: readonly string[]) => {
    const result = run(command, args);
    if (result.error || result.status !== 0) {
      throw new Error(
        result.error?.message || result.stderr.trim() || "Source host preparation failed.",
      );
    }
  };
  const sourcePath = options.sourcePath ?? SOURCE_PATH;
  const sourceDigest = digest(readFileSync(sourcePath));
  const info = hostInfoPlist();
  const expected = {
    version: MAC_SOURCE_HOST_VERSION,
    identifier: MAC_SOURCE_HOST_IDENTIFIER,
    architecture,
    sourceDigest,
    plistDigest: digest(info),
  };
  // One canonical host per user/version, across repositories and worktrees.
  const root = join(
    options.homeDirectory,
    "Library",
    "Application Support",
    "Cafe Code Source Hosts",
  );
  assertPrivateDirectory(root);
  const directory = join(root, `v${MAC_SOURCE_HOST_VERSION}-${architecture}`);
  assertPrivateDirectory(directory);
  const app = join(directory, `${APP_NAME}.app`);
  const verify = () => {
    for (const part of [
      app,
      join(app, "Contents"),
      join(app, "Contents", "MacOS"),
      join(app, "Contents", "Resources"),
    ]) {
      const stat = lstatSync(part);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) {
        throw new Error("Invalid source host bundle ownership or type.");
      }
    }
    const receipt = JSON.parse(
      readOwnedFile(join(app, "Contents", "Resources", "identity.json")).toString("utf8"),
    );
    const { uuid, ...recorded } = receipt;
    if (
      JSON.stringify(recorded) !== JSON.stringify(expected) ||
      digest(readOwnedFile(join(app, "Contents", "Info.plist"))) !== expected.plistDigest ||
      readMacSourceHostUuid(
        readOwnedFile(join(app, "Contents", "MacOS", APP_NAME), 16 * 1024 * 1024),
      ) !== uuid
    ) {
      throw new Error(
        "The immutable source host identity changed. Bump the native host policy version; do not re-sign the existing host.",
      );
    }
    execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  };
  if (existsSync(app)) {
    verify();
    return app;
  }
  const staging = mkdtempSync(join(directory, ".prepare-"));
  const candidate = join(staging, `${APP_NAME}.app`);
  try {
    const contents = join(candidate, "Contents");
    mkdirSync(join(contents, "MacOS"), { recursive: true, mode: 0o700 });
    mkdirSync(join(contents, "Resources"), { mode: 0o700 });
    writeFileSync(join(contents, "Info.plist"), info, { mode: 0o600, flag: "wx" });
    const executable = join(contents, "MacOS", APP_NAME);
    execute("/usr/bin/nice", [
      "-n",
      "10",
      "/usr/bin/xcrun",
      "clang",
      "-fobjc-arc",
      "-fblocks",
      "-O2",
      "-mmacosx-version-min=15.0",
      "-arch",
      architecture === "x64" ? "x86_64" : architecture,
      "-framework",
      "AppKit",
      "-framework",
      "Security",
      sourcePath,
      "-o",
      executable,
    ]);
    const uuid = readMacSourceHostUuid(readOwnedFile(executable, 16 * 1024 * 1024));
    writeFileSync(
      join(contents, "Resources", "identity.json"),
      `${JSON.stringify({ ...expected, uuid })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    execute("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--identifier",
      MAC_SOURCE_HOST_IDENTIFIER,
      candidate,
    ]);
    execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", candidate]);
    try {
      renameSync(candidate, app);
    } catch (error) {
      // Another checkout may have published the exact same immutable host.
      if (!existsSync(app)) throw error;
    }
    verify();
    return app;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
