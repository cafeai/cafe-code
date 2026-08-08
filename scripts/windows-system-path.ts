import * as NodePath from "node:path";

interface EnvironmentValue {
  readonly state: "missing" | "present" | "ambiguous";
  readonly value?: string;
}

function readUniqueEnvironmentValue(env: NodeJS.ProcessEnv, name: string): EnvironmentValue {
  const matches = Object.entries(env).filter(([key, value]) => {
    return key.toLowerCase() === name.toLowerCase() && value !== undefined;
  });
  if (matches.length === 0) return { state: "missing" };
  const values = new Set(matches.map(([, value]) => String(value).trim().toLowerCase()));
  if (values.size !== 1) return { state: "ambiguous" };
  return { state: "present", value: String(matches[0]?.[1]) };
}

function parseWindowsRoot(value: string | undefined): string | null {
  if (
    value === undefined ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    return null;
  }
  const match = /^([A-Za-z]):[\\/]Windows[\\/]?$/iu.exec(value.trim());
  return match?.[1] ? `${match[1].toUpperCase()}:\\Windows` : null;
}

export function validatedWindowsSystemRoot(env: NodeJS.ProcessEnv = process.env): string {
  const systemRootValue = readUniqueEnvironmentValue(env, "SystemRoot");
  const windowsDirectoryValue = readUniqueEnvironmentValue(env, "windir");
  const systemDriveValue = readUniqueEnvironmentValue(env, "SystemDrive");
  if (
    systemRootValue.state === "ambiguous" ||
    windowsDirectoryValue.state === "ambiguous" ||
    systemDriveValue.state === "ambiguous"
  ) {
    throw new Error("Windows system directory environment is ambiguous.");
  }

  const systemRoot =
    systemRootValue.state === "present" ? parseWindowsRoot(systemRootValue.value) : undefined;
  const windowsDirectory =
    windowsDirectoryValue.state === "present"
      ? parseWindowsRoot(windowsDirectoryValue.value)
      : undefined;
  if (systemRoot === null || windowsDirectory === null) {
    throw new Error("Windows system directory environment is invalid.");
  }
  if (systemRoot && windowsDirectory && systemRoot !== windowsDirectory) {
    throw new Error("Windows system directory environment disagrees.");
  }

  let configuredDrive: string | undefined;
  if (systemDriveValue.state === "present") {
    const driveMatch = /^\s*([A-Za-z]):\s*$/u.exec(systemDriveValue.value ?? "");
    configuredDrive = driveMatch?.[1]?.toUpperCase();
    if (!configuredDrive) throw new Error("Windows system drive is invalid.");
  }

  const root = systemRoot ?? windowsDirectory;
  if (!root) {
    if (configuredDrive && configuredDrive !== "C") {
      throw new Error("A non-default Windows system drive requires a matching Windows directory.");
    }
    return String.raw`C:\Windows`;
  }
  const rootDrive = root.slice(0, 1).toUpperCase();
  if (configuredDrive && configuredDrive !== rootDrive) {
    throw new Error("Windows system root and drive disagree.");
  }
  if (rootDrive !== "C" && !configuredDrive) {
    throw new Error("A non-default Windows system root requires its matching system drive.");
  }
  return NodePath.win32.normalize(root);
}

export function resolveWindowsSystemExecutable(
  relativePath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (
    NodePath.win32.isAbsolute(relativePath) ||
    relativePath
      .split(/[\\/]/u)
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Windows system executable path must be a normalized relative path.");
  }
  return NodePath.win32.join(validatedWindowsSystemRoot(env), "System32", relativePath);
}
