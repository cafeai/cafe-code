import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
// @effect-diagnostics nodeBuiltinImport:off
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readdir, mkdtemp, readFile, rm, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const [releaseRoot, probeRoot, version, channel] = process.argv.slice(2);
if (
  process.platform !== "linux" ||
  !releaseRoot ||
  !probeRoot ||
  !version ||
  !["latest", "nightly"].includes(channel ?? "")
)
  throw new Error("Invalid release update preflight invocation.");
const probeFiles = (await readdir(probeRoot)).filter((name) => name.endsWith(".AppImage"));
if (probeFiles.length !== 1) throw new Error("Expected one exact packaged update probe.");
const probe = resolve(probeRoot, probeFiles[0]!);
const allowed = new Set(await readdir(releaseRoot));
const root = await mkdtemp(join(tmpdir(), "cafe-release-update-"));
const server = createServer((request, response) => {
  const name = (request.url ?? "").slice(1);
  if (!allowed.has(name) || basename(name) !== name) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "content-type": name.endsWith(".yml") ? "application/yaml" : "application/octet-stream",
  });
  const stream = createReadStream(join(releaseRoot, name));
  stream.on("error", () => response.destroy());
  response.on("close", () => stream.destroy());
  stream.pipe(response);
});
try {
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Preflight feed failed to bind.");
  const home = join(root, "home");
  await mkdir(home);
  const resultPath = join(root, "result.json");
  await chmod(probe, 0o755);
  await new Promise<void>((accept, reject) => {
    const child = spawn(
      probe,
      ["--no-sandbox", "--headless", "--disable-gpu", "--cafe-update-detection-probe"],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          HOME: home,
          XDG_CONFIG_HOME: home,
          XDG_CACHE_HOME: home,
          TMPDIR: root,
          PATH: process.env.PATH,
          APPIMAGE: probe,
          APPIMAGE_EXTRACT_AND_RUN: "1",
          CAFE_CODE_UPDATE_DETECTION_CHANNEL: channel!,
          CAFE_CODE_UPDATE_DETECTION_EXPECT_VERSION: version,
          CAFE_CODE_UPDATE_DETECTION_RESULT: resultPath,
          CAFE_CODE_UPDATE_DETECTION_FEED_URL: `http://127.0.0.1:${address.port}`,
        },
      },
    );
    let output = "";
    const record = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-16_384);
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    // This native wait owns an external child/stream lifetime; a virtual
    // Effect clock must not replace its existing deadline or cleanup.
    // @effect-diagnostics-next-line globalTimers:off
    const timer = setTimeout(() => {
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      reject(new Error("Packaged candidate feed probe timed out."));
    }, 60_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not launch candidate update probe."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0 ? accept() : reject(new Error(`Packaged candidate feed probe failed: ${output}`));
    });
  });
  const result = JSON.parse(await readFile(resultPath, "utf8")) as {
    ok?: boolean;
    updateAvailable?: boolean;
    availableVersion?: string;
  };
  if (!result.ok || !result.updateAvailable || result.availableVersion !== version)
    throw new Error("Candidate update feed did not identify the exact release version.");
  Effect.runSync(Console.info("Exact candidate update feed qualified before publication."));
} finally {
  server.closeAllConnections();
  await new Promise<void>((accept) => server.close(() => accept()));
  await rm(root, { recursive: true, force: true });
}
