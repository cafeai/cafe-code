// @effect-diagnostics nodeBuiltinImport:off
import type { ExecFileOptionsWithStringEncoding } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isStandaloneStableDevice,
  parseStandaloneVolumeUuid,
  readStandaloneDeviceIdentity,
} from "./standaloneFilesystemIdentity.ts";

type DeviceStat = {
  rdev: bigint;
  isBlockDevice: () => boolean;
  isSymbolicLink: () => boolean;
};
const native = vi.hoisted(() => ({
  execFile:
    vi.fn<
      (
        command: string,
        args: string[],
        options: ExecFileOptionsWithStringEncoding,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => void
    >(),
  lstat: vi.fn<(path: string, options: { bigint: true }) => Promise<DeviceStat>>(),
}));
vi.mock("node:child_process", () => ({ execFile: native.execFile }));
vi.mock("node:fs/promises", () => ({ lstat: native.lstat }));

const deviceNode = "/dev/disk3s5";
const device = 16_777_230n;
const volumeUuid = "EC6C73DB-E617-4178-AFEE-CC06078844B4";
const identity = `darwin-volume:${volumeUuid.toLowerCase()}`;
const unavailable = "Standalone chat filesystem identity is unavailable.";
const directory = "/fixture/standalone workspace & literal;$(not-a-command)";
const df = `Filesystem 512-blocks Used Available Capacity Mounted on\n${deviceNode} 100 40 60 40% /System/Volumes/Data\n`;
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>DeviceNode</key><string>${deviceNode}</string>
  <key>VolumeName</key><string>Data &amp; inert &lt;key&gt; text</string>
  <key>VolumeUUID</key><string>${volumeUuid}</string>
</dict></plist>`;
const admittedDevice = (): DeviceStat => ({
  rdev: device,
  isBlockDevice: () => true,
  isSymbolicLink: () => false,
});
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const setPlatform = (platform: NodeJS.Platform) =>
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });

beforeEach(() => {
  // Select the policy under test without replacing the process object or
  // executing macOS helpers on Linux/Windows. All native I/O is synthetic.
  setPlatform("darwin");
  native.execFile.mockReset();
  native.lstat.mockReset();
  native.lstat.mockImplementation(async () => admittedDevice());
  native.execFile.mockImplementation((command, _args, _options, callback) => {
    callback(null, command === "/bin/df" ? df : plist, "");
  });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.unstubAllEnvs();
});

describe("standalone filesystem identity admission", () => {
  it("binds a normalized UUID to the exact block device using bounded shell-free helpers", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "private-fixture-credential");
    vi.stubEnv("NODE_OPTIONS", "--require=private-fixture-hook");
    const controller = new AbortController();
    expect(await readStandaloneDeviceIdentity(directory, device, controller.signal)).toBe(identity);
    expect(native.execFile.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ["/bin/df", ["-P", directory]],
      ["/usr/sbin/diskutil", ["info", "-plist", deviceNode]],
    ]);
    for (const [, , options] of native.execFile.mock.calls) {
      expect(options).toEqual({
        encoding: "utf8",
        shell: false,
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        signal: controller.signal,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C", LANG: "C" },
      });
    }
    expect(native.lstat.mock.calls).toEqual([
      [deviceNode, { bigint: true }],
      [deviceNode, { bigint: true }],
    ]);
  });

  it.each(["linux", "win32"] as const)(
    "preserves the exact bigint device identity without launching helpers on %s",
    async (platform) => {
      setPlatform(platform);
      expect(await readStandaloneDeviceIdentity(directory, 9_007_199_254_740_999n)).toBe(
        "9007199254740999",
      );
      expect(native.execFile).not.toHaveBeenCalled();
      expect(native.lstat).not.toHaveBeenCalled();
    },
  );

  it.each([
    "",
    "Filesystem only",
    `${df}${deviceNode} 100 40 60 40% /other\n`,
    df.replace(deviceNode, "/dev/rdisk3s5"),
    df.replace(deviceNode, "/dev/disk3s5;command"),
    df.replace(deviceNode, "server:/share"),
    df.replace(deviceNode, "/dev/../disk3s5"),
  ])("rejects inconclusive or nonlocal df output before disk lookup: %s", async (output) => {
    native.execFile.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(null, output, "");
    });
    await expect(readStandaloneDeviceIdentity(directory, device)).rejects.toThrow(unavailable);
    expect(native.execFile).toHaveBeenCalledTimes(1);
    expect(native.lstat).not.toHaveBeenCalled();
  });

  it.each([
    ["different device", { rdev: device + 1n }],
    ["ordinary file", { isBlockDevice: () => false }],
    ["symlink", { isSymbolicLink: () => true }],
  ] as const)("rejects a %s before trusting disk metadata", async (_label, changed) => {
    native.lstat.mockResolvedValueOnce({ ...admittedDevice(), ...changed });
    await expect(readStandaloneDeviceIdentity(directory, device)).rejects.toThrow(unavailable);
    expect(native.execFile).toHaveBeenCalledTimes(1);
  });

  it("rechecks the block-device binding after metadata lookup", async () => {
    native.lstat
      .mockResolvedValueOnce(admittedDevice())
      .mockResolvedValueOnce({ ...admittedDevice(), rdev: device + 1n });
    await expect(readStandaloneDeviceIdentity(directory, device)).rejects.toThrow(unavailable);
    expect(native.execFile).toHaveBeenCalledTimes(2);
    expect(native.lstat).toHaveBeenCalledTimes(2);
  });

  it.each(["/bin/df", "/usr/sbin/diskutil"])(
    "fails closed without exposing helper failure output from %s",
    async (failedCommand) => {
      native.execFile.mockImplementation((command, _args, _options, callback) => {
        callback(
          command === failedCommand ? new Error("private native timeout/error details") : null,
          command === "/bin/df" ? df : plist,
          "private stderr",
        );
      });
      await expect(readStandaloneDeviceIdentity(directory, device)).rejects.toThrow(unavailable);
      expect(native.execFile).toHaveBeenCalledTimes(failedCommand === "/bin/df" ? 1 : 2);
    },
  );

  it.each(["/bin/df", "/usr/sbin/diskutil"])(
    "passes cancellation through the in-flight %s request and stops admission",
    async (pendingCommand) => {
      let cancelPending: (() => void) | undefined;
      native.execFile.mockImplementation((command, _args, options, callback) => {
        if (command !== pendingCommand) {
          callback(null, df, "");
          return;
        }
        cancelPending = () => callback(new Error("AbortError"), "", "");
        options.signal!.addEventListener("abort", cancelPending, { once: true });
      });
      const controller = new AbortController();
      const pending = readStandaloneDeviceIdentity(directory, device, controller.signal);
      const rejected = expect(pending).rejects.toThrow(unavailable);
      // Drain only the finite awaited metadata/stat steps, never wall-clock
      // sleeps or a real child process. Attach rejection handling before abort.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(cancelPending).toBeDefined();
      controller.abort();
      await rejected;
      expect(native.execFile).toHaveBeenCalledTimes(pendingCommand === "/bin/df" ? 1 : 2);
    },
  );
});

describe("strict native volume metadata decoding", () => {
  it("accepts the native UUID spelling while ignoring unrelated inert plist fields", () => {
    expect(parseStandaloneVolumeUuid(plist, deviceNode)).toBe(identity);
    expect(isStandaloneStableDevice(identity)).toBe(true);
  });

  it.each([
    plist.replace(`<string>${deviceNode}</string>`, "<string>/dev/disk4s5</string>"),
    plist.replace("<key>DeviceNode</key>", "<key>OtherDevice</key>"),
    plist.replace("<key>VolumeUUID</key>", "<key>OtherUUID</key>"),
    plist.replace(volumeUuid, "not-a-uuid"),
    plist.replace(volumeUuid, `${volumeUuid} `),
    plist.replace(volumeUuid, "&untrusted;"),
    plist.replace(`<string>${volumeUuid}</string>`, `<integer>${volumeUuid}</integer>`),
    plist.replace("</dict>", `<key>VolumeUUID</key><string>${volumeUuid}</string></dict>`),
    plist.replace("</dict>", `<key>VolumeUUID</key><integer>1</integer></dict>`),
    plist.replace("</dict>", `<key>DeviceNode</key><string>${deviceNode}</string></dict>`),
  ])("rejects missing, malformed, foreign, or duplicate identity fields", (output) => {
    expect(() => parseStandaloneVolumeUuid(output, deviceNode)).toThrow(unavailable);
  });

  it.each(["/dev/rdisk3s5", "disk3s5", "/dev/disk3s5/../disk4s5", "/dev/disk3s5;cmd"])(
    "rejects unvalidated device names even when metadata agrees: %s",
    (deviceName) => {
      expect(() =>
        parseStandaloneVolumeUuid(plist.replace(deviceNode, deviceName), deviceName),
      ).toThrow(unavailable);
    },
  );

  it.each(["16777230", "darwin-volume:", `darwin-volume:${volumeUuid} `, `volume:${volumeUuid}`])(
    "does not classify a malformed or legacy identity as stable: %s",
    (value) => expect(isStandaloneStableDevice(value)).toBe(false),
  );
});
