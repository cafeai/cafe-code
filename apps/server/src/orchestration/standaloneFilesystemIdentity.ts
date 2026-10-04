// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";

const DEVICE_NODE = /^\/dev\/disk[0-9]+(?:s[0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNAVAILABLE = "Standalone chat filesystem identity is unavailable.";

/** Native disk metadata is local admission evidence, never provider output. */
const readNativeMetadata = (command: string, args: string[], signal?: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        shell: false,
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        signal,
        // Fixed system executables need neither provider credentials nor user
        // process hooks. A deterministic locale keeps df's field layout stable.
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C", LANG: "C" },
      },
      (error, stdout) => {
        if (error) reject(new Error(UNAVAILABLE));
        else resolve(stdout);
      },
    );
  });

/**
 * Read only strict inert identifiers from diskutil's fixed property-list shape.
 * Do not interpret arbitrary XML, expand entities, or admit duplicate keys.
 */
export function parseStandaloneVolumeUuid(plist: string, deviceNode: string): string {
  const readOne = (key: string) => {
    const keys = plist.match(new RegExp(`<key>\\s*${key}\\s*</key>`, "g"));
    const values = [
      ...plist.matchAll(new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`, "g")),
    ];
    if (keys?.length !== 1 || values.length !== 1) throw new Error(UNAVAILABLE);
    return values[0]![1]!;
  };
  if (!DEVICE_NODE.test(deviceNode) || readOne("DeviceNode") !== deviceNode)
    throw new Error(UNAVAILABLE);
  const uuid = readOne("VolumeUUID");
  if (!UUID.test(uuid)) throw new Error(UNAVAILABLE);
  return `darwin-volume:${uuid.toLowerCase()}`;
}

export const isStandaloneStableDevice = (value: string) =>
  value.startsWith("darwin-volume:") && UUID.test(value.slice("darwin-volume:".length));

/**
 * macOS st_dev identifies the current mount, not the durable volume: it can
 * change after reboot. Bind persistence to the OS volume UUID while retaining
 * raw device/inode checks around every held-directory operation at the caller.
 * Unsupported or inconclusive disks fail closed; never fall back to inode only.
 * Linux/Windows retain their existing device identity and launch no helpers.
 */
export async function readStandaloneDeviceIdentity(
  directory: string,
  device: bigint,
  signal?: AbortSignal,
): Promise<string> {
  if (process.platform !== "darwin") return String(device);
  const df = await readNativeMetadata("/bin/df", ["-P", directory], signal);
  const rows = df.trim().split(/\r?\n/);
  const deviceNode = rows.length === 2 ? rows[1]!.trim().split(/\s+/)[0] : undefined;
  if (!deviceNode || !DEVICE_NODE.test(deviceNode)) throw new Error(UNAVAILABLE);
  const checkDevice = async () => {
    const stat = await fs.lstat(deviceNode, { bigint: true });
    if (!stat.isBlockDevice() || stat.isSymbolicLink() || stat.rdev !== device)
      throw new Error(UNAVAILABLE);
  };
  await checkDevice();
  const plist = await readNativeMetadata(
    "/usr/sbin/diskutil",
    ["info", "-plist", deviceNode],
    signal,
  );
  const identity = parseStandaloneVolumeUuid(plist, deviceNode);
  await checkDevice();
  return identity;
}
