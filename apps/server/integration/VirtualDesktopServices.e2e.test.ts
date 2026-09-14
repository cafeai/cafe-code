import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { nativeRequest } from "../src/virtualDesktop/nativeClient.ts";

const enabled = process.platform === "linux" && process.env.CAFE_CODE_VIRTUAL_DESKTOP_E2E === "1";
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const helper =
  process.env.CAFE_CODE_DESKTOP_TEST_HELPER ??
  path.join(repo, "apps/server/dist/cafe-desktop-native");
const exec = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const value = await read();
      if (ready(value)) return value;
    } catch {
      /* bounded fixture startup */
    }
    await sleep(50);
  }
  throw new Error("Desktop session service fixture timed out");
}

it.skipIf(!enabled)(
  "routes credentials per client, restores bridge activation, and gives private services their display",
  async () => {
    const root = await fs.mkdtemp(`/run/user/${process.getuid?.()}/cafe-services-`);
    await fs.chmod(root, 0o700);
    const children: ChildProcess[] = [];
    let bootstrap: string | undefined;
    const launch = (command: string, args: string[], env = process.env) => {
      const child = spawn(command, args, { env, stdio: "ignore" });
      children.push(child);
      return child;
    };
    const hostAddress = `unix:path=${root}/host/bus`;
    const privateAddress = `unix:path=${root}/desktop/bus`;
    const bus = async (address: string, args: string[]) =>
      (await exec("busctl", [`--address=${address}`, "--timeout=5", ...args], { timeout: 7000 }))
        .stdout;
    try {
      const fixture = path.join(root, "service-fixture");
      const flags = execFileSync("pkg-config", ["--cflags", "--libs", "gio-2.0", "json-c"], {
        encoding: "utf8",
      })
        .trim()
        .split(/\s+/);
      execFileSync("c++", [
        "-std=c++20",
        path.join(repo, "native/virtual-desktop/session-services-fixture.cpp"),
        ...flags,
        "-o",
        fixture,
      ]);
      for (const name of ["host", "desktop"])
        await fs.mkdir(path.join(root, name, "dbus-1/services"), { recursive: true, mode: 0o700 });
      const activation = path.join(root, "desktop", "activation.json");
      await fs.writeFile(
        path.join(root, "desktop/dbus-1/services/org.cafe.Test.Activation.service"),
        `[D-BUS Service]\nName=org.cafe.Test.Activation\nExec=${fixture} activation ${activation}\n`,
        { mode: 0o600 },
      );
      const hostConfig = path.join(root, "host/bus.conf");
      // No system/user service directories: stopping the mock must never activate
      // the machine's real keyring against a synthetic bus.
      await fs.writeFile(
        hostConfig,
        `<busconfig><type>session</type><listen>${hostAddress}</listen><auth>EXTERNAL</auth><policy context="default"><allow user="*"/><allow own="*"/><allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>`,
        { mode: 0o600 },
      );
      launch(
        "dbus-daemon",
        [`--config-file=${hostConfig}`, "--nofork", `--address=${hostAddress}`],
        {
          ...process.env,
          XDG_RUNTIME_DIR: path.join(root, "host"),
        },
      );
      await until(
        () => bus(hostAddress, ["list"]),
        () => true,
      );
      let host = launch(fixture, ["host", hostAddress, path.join(root, "host-ready")]);
      await until(
        () => fs.readFile(path.join(root, "host-ready"), "utf8"),
        () => true,
      );
      const directory = path.join(root, "desktop");
      bootstrap = path.join(directory, "bootstrap.json");
      await fs.writeFile(
        bootstrap,
        JSON.stringify({
          directory,
          helper,
          socket: path.join(directory, "worker.sock"),
          token: randomBytes(32).toString("hex"),
          viewerToken: randomBytes(32).toString("hex"),
          sway: "sway",
          renderer: "pixman",
        }),
        { mode: 0o600 },
      );
      launch(helper, ["worker", bootstrap], {
        ...process.env,
        DBUS_SESSION_BUS_ADDRESS: hostAddress,
      });
      const boot = bootstrap;
      await until(
        () => nativeRequest(helper, boot, { method: "status" }),
        (status) => status.ok === true,
      );
      const environment = JSON.parse(
        await fs.readFile(path.join(directory, "environment.json"), "utf8"),
      );
      await bus(privateAddress, [
        "call",
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "StartServiceByName",
        "su",
        "org.cafe.Test.Activation",
        "0",
      ]);
      expect(JSON.parse(await fs.readFile(activation, "utf8"))).toMatchObject({
        DISPLAY: environment.DISPLAY,
        WAYLAND_DISPLAY: environment.WAYLAND_DISPLAY,
        XDG_RUNTIME_DIR: directory,
      });
      expect(
        (await exec(fixture, ["client", privateAddress], { timeout: 15000 })).stdout,
      ).toContain("verified");

      // Killing only the private bridge must reactivate the same bridge, never an
      // installed keyring daemon against the user's real credential files.
      const owner = await bus(privateAddress, [
        "call",
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "GetConnectionUnixProcessID",
        "s",
        "org.freedesktop.secrets",
      ]);
      const pid = Number(owner.trim().split(" ")[1]);
      expect(pid).toBeGreaterThan(1);
      process.kill(pid, "SIGTERM");
      await until(
        () =>
          bus(privateAddress, [
            "call",
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "NameHasOwner",
            "s",
            "org.freedesktop.secrets",
          ]),
        (value) => value.trim() === "b false",
      );
      expect(
        (await exec(fixture, ["client", privateAddress], { timeout: 15000 })).stdout,
      ).toContain("verified");

      host.kill("SIGTERM");
      await until(
        () =>
          bus(hostAddress, [
            "call",
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "NameHasOwner",
            "s",
            "org.freedesktop.secrets",
          ]),
        (value) => value.trim() === "b false",
      );
      // The synthetic host bus has no activatable keyring service.
      await exec(fixture, ["unavailable", privateAddress], { timeout: 10000 });
      host = launch(fixture, ["host", hostAddress, path.join(root, "host-ready-again")]);
      await until(
        () => fs.readFile(path.join(root, "host-ready-again"), "utf8"),
        () => true,
      );
      expect(
        (await exec(fixture, ["client", privateAddress], { timeout: 15000 })).stdout,
      ).toContain("verified");
    } finally {
      if (bootstrap)
        await nativeRequest(helper, bootstrap, { method: "terminate" }).catch(() => undefined);
      for (const child of children.toReversed()) child.kill("SIGTERM");
      await Promise.all(
        children.map((child) =>
          child.exitCode !== null || child.signalCode !== null
            ? undefined
            : new Promise<void>((resolve) => {
                child.once("exit", () => resolve());
                setTimeout(() => {
                  child.kill("SIGKILL");
                  resolve();
                }, 3000).unref();
              }),
        ),
      );
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
