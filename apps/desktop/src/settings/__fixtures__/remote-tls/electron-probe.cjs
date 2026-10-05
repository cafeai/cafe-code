// Synthetic native test only. No real app profile, password or server is used.
const { app, BrowserWindow } = require("electron");
const https = require("node:https");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const assert = require("node:assert/strict");
const directory = process.argv[2];
const userData = path.join(directory, "profile");
fs.mkdirSync(userData);
app.setPath("userData", userData);
let window, primary, remote, other;
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const timeout = setTimeout(() => {
  console.error("probe timed out");
  app.exit(1);
}, 20000);
(async () => {
  const { acceptsPinnedRemoteCertificate } = await import(
    pathToFileURL(path.join(directory, "policy.mjs")).href
  );
  const cert = fs.readFileSync(path.join(directory, "test-only-cert.pem"), "utf8");
  const key = fs.readFileSync(path.join(directory, "test-only-key.pem"), "utf8");
  const pins = new Map();
  let accepted = 0,
    rejected = 0;
  app.on("certificate-error", (event, _contents, url, error, certificate, callback) => {
    if (acceptsPinnedRemoteCertificate(pins, url, error, certificate.data)) {
      accepted++;
      event.preventDefault();
      callback(true);
    } else {
      rejected++;
    }
  });
  await app.whenReady();
  primary = http.createServer((_req, res) =>
    res.end("<html><body>Isolated TLS fixture</body></html>"),
  );
  const handler = (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(JSON.stringify({ fixture: true }));
  };
  remote = https.createServer({ cert, key }, handler);
  other = https.createServer({ cert, key }, handler);
  remote.on("upgrade", (req, socket) => {
    const accept = crypto
      .createHash("sha1")
      .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
        accept +
        "\r\n\r\n",
    );
    socket.write(Buffer.from([0x81, 7, ...Buffer.from("fixture")]));
    socket.on("data", () => socket.destroy());
  });
  const primaryPort = await listen(primary),
    remotePort = await listen(remote),
    otherPort = await listen(other);
  const origin = "https://127.0.0.1:" + remotePort;
  window = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  await window.loadURL("http://127.0.0.1:" + primaryPort);
  const fetchFixture = (url) =>
    window.webContents.executeJavaScript(
      `fetch(${JSON.stringify(url)},{credentials:'omit'}).then(r=>r.json()).catch(()=>null)`,
    );
  assert.equal(await fetchFixture(origin), null);
  pins.set(origin, new crypto.X509Certificate(cert).fingerprint256);
  assert.deepEqual(await fetchFixture(origin + "/?approved=1"), { fixture: true });
  assert.equal(await fetchFixture("https://127.0.0.1:" + otherPort), null);
  const wsResult = await window.webContents.executeJavaScript(
    `new Promise(resolve=>{const s=new WebSocket(${JSON.stringify("wss://127.0.0.1:" + remotePort + "/")});s.onmessage=e=>{resolve(e.data);s.close()};s.onerror=()=>resolve(null);setTimeout(()=>resolve('timeout'),5000)})`,
  );
  assert.equal(wsResult, "fixture");
  console.log(
    JSON.stringify({
      https: "passed",
      wss: "passed",
      unapprovedPort: "rejected",
      accepted,
      rejected,
    }),
  );
  clearTimeout(timeout);
  window.destroy();
  for (const server of [primary, remote, other]) {
    server.closeAllConnections();
    server.close();
  }
  app.exit(0);
})().catch((error) => {
  console.error(error);
  clearTimeout(timeout);
  app.exit(1);
});
