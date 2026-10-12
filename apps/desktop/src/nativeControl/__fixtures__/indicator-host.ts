import { app, BrowserWindow } from "electron";
import { createInterface } from "node:readline";
import { ThreadId } from "@cafecode/contracts";
import { NativeControlHost } from "../NativeControlHost.ts";
import { NativeControlIndicators } from "../NativeControlVisibility.ts";

// Explicit native fixture only. No provider, real profile, permission prompt or
// user application is launched. Parent stdin owns this entire process lifetime.
app.setPath("userData", process.argv[2]!);
app.commandLine.appendSwitch("disable-background-networking");
// This tray-only host has no main window. Its parent pipe owns lifetime,
// including after Stop destroys the last indicator panel.
app.on("window-all-closed", () => {});
const reply = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
let host: NativeControlHost | undefined;
const transitions: { phase: string; usingSystemPointer: boolean }[] = [];
const commands = createInterface({ input: process.stdin });
commands.on("line", (line) => {
  void (async () => {
    const command = JSON.parse(line);
    if (!host) throw new Error("Fixture unavailable");
    if (command.operation === "state") {
      const panels = BrowserWindow.getAllWindows();
      reply({
        id: command.id,
        activity: host.activity(),
        helperPid: Reflect.get(Reflect.get(host, "controller"), "child")?.pid,
        transitions,
        panels: await Promise.all(
          panels.map(async (p) => ({
            visible: p.isVisible(),
            focusable: p.isFocusable(),
            bounds: p.getBounds(),
            title: p.getTitle(),
            nativeWindowId: Number(p.getMediaSourceId().split(":")[1]),
            badge: await p.webContents.executeJavaScript(
              'document.getElementById("badge").textContent',
            ),
          })),
        ),
      });
    } else if (command.operation === "refresh") {
      await host.refreshActivityTarget(command.episode);
      reply({ id: command.id, refreshed: true });
    } else if (command.operation === "stop") {
      await host.stopActivity(command.episode);
      reply({ id: command.id, stopped: true });
    }
  })().catch(() => reply({ error: "Owned indicator fixture request failed" }));
});
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void host?.close().finally(() => app.quit());
};
commands.on("close", close);
app.on("before-quit", (event) => {
  if (host && !closing) {
    event.preventDefault();
    close();
  }
});
app
  .whenReady()
  .then(async () => {
    // A tray-only fixture is an accessory app. A second regular instance of
    // the generic Electron bundle can change the field's application group.
    app.setActivationPolicy("accessory");
    const indicators = new NativeControlIndicators({
      stop: (e) => host!.stopActivity(e),
      refresh: (e) => host!.refreshActivityTarget(e),
      inputPolicy: (p) => host!.setInputPolicy(p),
    });
    host = new NativeControlHost({
      stateDirectory: process.argv[2]!,
      runtimeRoot: process.argv[3]!,
      hostBundleId: "com.cafe.IndicatorFixture",
      visibility: indicators,
    });
    const connection = await host.listen(false);
    host.subscribeActivity((activity) => {
      transitions.push({ phase: activity.phase, usingSystemPointer: activity.usingSystemPointer });
      if (transitions.length > 32) transitions.shift();
    });
    await host.setEnabled(true);
    await host.setChatEnabled(ThreadId.make("indicator-fixture"), true);
    reply({ ready: true, connection });
  })
  .catch(() => {
    reply({ error: "Owned indicator fixture could not start" });
    app.quit();
  });
