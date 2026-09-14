// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { desktopError, executable } from "./nativeClient.ts";

export interface DesktopApp {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly terminal: boolean;
}

/** Desktop Entry Exec grammar, not a shell command. Field codes expand to argv. */
export function parseDesktopExec(
  exec: string,
  context: { name: string; icon?: string; file: string },
): string[] {
  const words: string[] = [];
  let word = "",
    quoted = false,
    escaped = false,
    started = false;
  for (const char of exec) {
    if (escaped) {
      word += char;
      escaped = false;
      started = true;
    } else if (char === "\\") escaped = true;
    else if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(char) && !quoted) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quoted || escaped)
    throw desktopError("invalid_request", "The application launcher has an invalid command.");
  if (started) words.push(word);
  return words.flatMap((value) => {
    if (["%f", "%F", "%u", "%U"].includes(value)) return [];
    if (value === "%i") return context.icon ? ["--icon", context.icon] : [];
    if (value === "%c") return [context.name];
    if (value === "%k") return [context.file];
    if (/%(?!%)/.test(value.replaceAll("%%", "")))
      throw desktopError(
        "invalid_request",
        "The application launcher uses unsupported field codes.",
      );
    return [value.replaceAll("%%", "%")];
  });
}

export async function listDesktopApps(): Promise<DesktopApp[]> {
  const locations = [
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"),
    ...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":"),
  ];
  const apps: DesktopApp[] = [];
  const seen = new Set<string>();
  for (const base of locations.slice(0, 12)) {
    if (!path.isAbsolute(base)) continue;
    const directory = path.join(base, "applications");
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.slice(0, 4096)) {
      if (!entry.name.endsWith(".desktop") || seen.has(entry.name)) continue;
      seen.add(entry.name);
      const file = path.join(directory, entry.name);
      try {
        const info = await fs.stat(file);
        if (!info.isFile() || info.size > 64 * 1024) continue;
        const text = await fs.readFile(file, "utf8");
        const fields: Record<string, string> = {};
        let active = false;
        for (const line of text.split(/\r?\n/)) {
          if (line.startsWith("[")) {
            active = line === "[Desktop Entry]";
            continue;
          }
          if (!active || line.startsWith("#")) continue;
          const index = line.indexOf("=");
          if (index > 0)
            fields[line.slice(0, index)] = line
              .slice(index + 1)
              .replaceAll("\\s", " ")
              .replaceAll("\\n", "\n")
              .replaceAll("\\t", "\t");
        }
        if (
          fields.Type !== "Application" ||
          fields.Hidden === "true" ||
          fields.NoDisplay === "true" ||
          !fields.Name ||
          !fields.Exec
        )
          continue;
        const args = parseDesktopExec(fields.Exec, {
          name: fields.Name,
          file,
          ...(fields.Icon ? { icon: fields.Icon } : {}),
        });
        const command = args.shift();
        if (!command) continue;
        if (
          fields.TryExec &&
          !(path.isAbsolute(fields.TryExec)
            ? await fs.access(fields.TryExec, fs.constants.X_OK).then(
                () => true,
                () => false,
              )
            : await executable(fields.TryExec))
        )
          continue;
        apps.push({
          id: entry.name,
          name: fields.Name.slice(0, 160),
          command,
          args,
          terminal: fields.Terminal === "true",
        });
      } catch {
        /* One malformed third-party desktop entry cannot break discovery. */
      }
    }
  }
  return apps.toSorted((a, b) => a.name.localeCompare(b.name));
}

export async function terminalCommand(command: string, args: readonly string[]) {
  for (const name of [
    process.env.TERMINAL,
    "konsole",
    "gnome-terminal",
    "kitty",
    "alacritty",
    "xfce4-terminal",
    "xterm",
  ]) {
    if (!name) continue;
    const resolved = await executable(name);
    if (!resolved) continue;
    const prefix =
      path.basename(name) === "konsole"
        ? ["--separate", "-e"]
        : path.basename(name) === "gnome-terminal"
          ? ["--wait", "--"]
          : ["-e"];
    return { command: resolved, args: [...prefix, command, ...args] };
  }
  throw desktopError(
    "unavailable",
    "No supported terminal was found. Install or configure a terminal first.",
  );
}
