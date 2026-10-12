const { app, BrowserWindow } = require("electron");
const { screen } = require("electron");
const { createInterface } = require("node:readline");

// An owned, disposable window for opt-in native input qualification. No user
// profile, remote page, provider, clipboard or application data is involved.
app.setPath("userData", process.argv[2]);
app.commandLine.appendSwitch("disable-background-networking");
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const commands = createInterface({ input: process.stdin });
let window;
let occluder;
commands.on("line", async (line) => {
  const command = JSON.parse(line);
  if (command.operation === "state") {
    const state = await window.webContents.executeJavaScript(
      "({ value: document.querySelector('input').value, inputs: window.inputs, submissions: window.submissions, events: window.events, wheelClicks: window.wheelClicks, active: document.activeElement.tagName })",
    );
    reply({
      id: command.id,
      ...state,
      pointer: screen.getCursorScreenPoint(),
      bounds: window.getBounds(),
      windowId: Number(window.getMediaSourceId().split(":")[1]),
    });
  } else if (command.operation === "reveal") {
    window.show();
    app.focus({ steal: true });
    window.moveTop();
    window.focus();
    // AppKit activation/z-order completes asynchronously. This is fixture
    // scene setup, before native observation/input, rather than action replay.
    await new Promise((resolve) => setTimeout(resolve, 150));
    reply({ id: command.id, revealed: true });
  } else if (command.operation === "resize") {
    window.setBounds({ x: 80, y: 100, width: 700, height: 500 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    reply({ id: command.id, bounds: window.getBounds() });
  } else if (command.operation === "occlude") {
    const b = window.getBounds();
    occluder = new BrowserWindow({
      x: b.x + 60,
      y: b.y + 60,
      width: 250,
      height: 200,
      title: "Cafe owned occlusion fixture",
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
    });
    await occluder.loadURL(
      "data:text/html,<title>Cafe owned occlusion fixture</title>Owned fixture",
    );
    occluder.moveTop();
    occluder.focus();
    await new Promise((resolve) => setTimeout(resolve, 150));
    reply({ id: command.id, occluded: true });
  } else if (command.operation === "unocclude") {
    occluder?.destroy();
    occluder = undefined;
    app.focus({ steal: true });
    window.moveTop();
    window.focus();
    await new Promise((resolve) => setTimeout(resolve, 150));
    reply({ id: command.id, occluded: false });
  } else if (command.operation === "fullscreen" || command.operation === "exit-fullscreen") {
    const entered = command.operation === "fullscreen";
    const transitioned = new Promise((resolve, reject) => {
      const event = entered ? "enter-full-screen" : "leave-full-screen";
      const timeout = setTimeout(() => reject(new Error("Owned fullscreen scene timed out")), 5000);
      window.once(event, () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    window.setFullScreen(entered);
    await transitioned;
    await new Promise((resolve) => setTimeout(resolve, 150));
    reply({ id: command.id, bounds: window.getBounds() });
  } else if (command.operation === "close") {
    app.quit();
  }
});
commands.on("close", () => app.quit());
app.on("window-all-closed", () => app.quit());
app.whenReady().then(async () => {
  window = new BrowserWindow({
    width: 640,
    height: 480,
    title: "Cafe isolated computer-use field",
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  await window.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
      <title>Cafe isolated computer-use field</title>
      <style>body{font:18px system-ui;padding:40px;background:white;color:black}input{font:inherit;width:480px;padding:12px}</style>
      </head><body><form><label for="field">Cafe fixture field</label>
      <input id="field" aria-label="Cafe fixture field" autocomplete="off">
      <p id="status">No input received</p></form>
      <canvas id="wheel" role="button" aria-label="Cafe fixture color wheel" width="320" height="70" style="background:linear-gradient(90deg,#f33,#3f3,#33f)"></canvas><script>
      window.wheelClicks=[]; document.querySelector('#wheel').addEventListener('click',event=>{const b=event.target.getBoundingClientRect();window.wheelClicks.push({x:event.clientX-b.x,y:event.clientY-b.y});});
      window.inputs=[]; window.submissions=[]; window.events=[];
      for (const type of ['focusin','click','mousedown','keydown']) document.addEventListener(type,(event)=>window.events.push({type,target:event.target.id,key:event.key,x:event.clientX,y:event.clientY}));
      const field=document.querySelector('input');
      field.addEventListener('input',()=>{window.inputs.push(field.value);document.querySelector('#status').textContent='Input received';});
      document.querySelector('form').addEventListener('submit',(event)=>{event.preventDefault();window.submissions.push(field.value);});
      </script></body></html>`),
  );
  app.setAccessibilitySupportEnabled(true);
  reply({
    ready: true,
    pid: process.pid,
    windowId: Number(window.getMediaSourceId().split(":")[1]),
  });
});
