const { app, BrowserWindow } = require("electron");
const { createInterface } = require("node:readline");

// An owned, disposable window for opt-in native input qualification. No user
// profile, remote page, provider, clipboard or application data is involved.
app.setPath("userData", process.argv[2]);
app.commandLine.appendSwitch("disable-background-networking");
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const commands = createInterface({ input: process.stdin });
let window;
commands.on("line", async (line) => {
  const command = JSON.parse(line);
  if (command.operation === "state") {
    const state = await window.webContents.executeJavaScript(
      "({ value: document.querySelector('input').value, inputs: window.inputs, submissions: window.submissions, events: window.events, active: document.activeElement.tagName })",
    );
    reply({ id: command.id, ...state });
  } else if (command.operation === "close") {
    app.quit();
  }
});
commands.on("close", () => app.quit());
app.on("window-all-closed", () => app.quit());
app.whenReady().then(async () => {
  window = new BrowserWindow({
    width: 640,
    height: 360,
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
      <p id="status">No input received</p></form><script>
      window.inputs=[]; window.submissions=[]; window.events=[];
      for (const type of ['focusin','click','mousedown','keydown']) document.addEventListener(type,(event)=>window.events.push({type,target:event.target.id,key:event.key,x:event.clientX,y:event.clientY}));
      const field=document.querySelector('input');
      field.addEventListener('input',()=>{window.inputs.push(field.value);document.querySelector('#status').textContent='Input received';});
      document.querySelector('form').addEventListener('submit',(event)=>{event.preventDefault();window.submissions.push(field.value);});
      </script></body></html>`),
  );
  app.setAccessibilitySupportEnabled(true);
  reply({ ready: true, pid: process.pid });
});
