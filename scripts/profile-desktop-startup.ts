// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

type ProfileChildProcess = ChildProcessByStdio<null, Readable, Readable>;

interface CpuProfileCallFrame {
  readonly functionName?: string;
  readonly url?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
}

interface CpuProfileNode {
  readonly id: number;
  readonly callFrame?: CpuProfileCallFrame;
  readonly children?: readonly number[];
}

interface CpuProfile {
  readonly nodes: readonly CpuProfileNode[];
  readonly startTime: number;
  readonly endTime: number;
  readonly samples?: readonly number[];
  readonly timeDeltas?: readonly number[];
}

interface StartupProfileMetadata {
  readonly role?: string;
  readonly pid?: number;
  readonly reason?: string;
  readonly startedAt?: string;
  readonly stoppedAt?: string;
  readonly durationMs?: number;
  readonly argv?: readonly string[];
}

interface FoldedProfile {
  readonly totalUs: number;
  readonly sampleCount: number;
  readonly stacks: ReadonlyMap<string, number>;
  readonly topSelf: readonly FrameTime[];
}

interface FrameTime {
  readonly label: string;
  readonly us: number;
}

interface FlameNode {
  readonly name: string;
  us: number;
  readonly children: Map<string, FlameNode>;
}

interface ProfileSummary {
  readonly file: string;
  readonly role: string;
  readonly pid: number | null;
  readonly reason: string;
  readonly sampleCount: number;
  readonly totalCpuMs: number;
  readonly wallDurationMs: number | null;
  readonly flamegraph: string;
  readonly folded: string;
  readonly topSelf: readonly {
    readonly label: string;
    readonly ms: number;
    readonly percent: number;
  }[];
}

interface CliOptions {
  readonly outDir: string;
  readonly durationMs: number;
  readonly flushMs: number;
  readonly build: boolean;
  readonly roles: string;
  readonly command: readonly string[];
}

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultRunId = new Date().toISOString().replace(/[:.]/g, "-");

function printUsage(): void {
  process.stdout.write(`Usage: bun run profile:desktop-startup [options] [-- command...]

Options:
  --out-dir <path>       Profile output directory (default: .startup-profiles/<timestamp>)
  --duration-ms <n>      How long to capture startup before stopping (default: 20000)
  --flush-ms <n>         Time to wait for profile files before shutdown (default: 3000)
  --roles <list>         Comma-separated roles to profile (default: *)
  --skip-build           Do not run bun run build:desktop before profiling
  --help                 Show this help

The default command is: bun run --cwd apps/desktop start
`);
}

function parsePositiveInteger(name: string, value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let outDir = path.join(repoRoot, ".startup-profiles", defaultRunId);
  let durationMs = 20_000;
  let flushMs = 3_000;
  let build = true;
  let roles = "*";
  let command: readonly string[] = ["bun", "run", "--cwd", "apps/desktop", "start"];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--") {
      command = argv.slice(index + 1);
      break;
    }
    if (arg === "--skip-build") {
      build = false;
      continue;
    }
    if (arg === "--out-dir") {
      outDir = path.resolve(repoRoot, argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--duration-ms") {
      durationMs = parsePositiveInteger("--duration-ms", argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--flush-ms") {
      flushMs = parsePositiveInteger("--flush-ms", argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--roles") {
      roles = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (command.length === 0) {
    throw new Error("Profile command cannot be empty.");
  }

  return {
    outDir,
    durationMs,
    flushMs,
    build,
    roles,
    command,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnLogged(
  command: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly stdoutPath?: string;
    readonly stderrPath?: string;
    readonly detached?: boolean;
  } = {},
): ProfileChildProcess {
  const [executable, ...args] = command;
  if (executable === undefined) {
    throw new Error("Cannot spawn an empty command.");
  }

  const child = spawn(executable, args, {
    cwd: repoRoot,
    env: options.env,
    detached: options.detached ?? false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutFile =
    options.stdoutPath === undefined ? undefined : createWriteStream(options.stdoutPath);
  const stderrFile =
    options.stderrPath === undefined ? undefined : createWriteStream(options.stderrPath);

  child.stdout.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    stdoutFile?.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    stderrFile?.write(chunk);
  });
  child.once("close", () => {
    stdoutFile?.end();
    stderrFile?.end();
  });

  return child;
}

async function runCommand(command: readonly string[]): Promise<void> {
  const child = spawnLogged(command);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode));
  });
  if (code !== 0) {
    throw new Error(`${command.join(" ")} exited with ${code ?? "signal"}.`);
  }
}

function signalProcessTree(child: ProfileChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to signaling only the direct child.
    }
  }
  child.kill(signal);
}

async function waitForExit(
  child: ProfileChildProcess,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sanitizeFileName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "profile";
}

function formatMs(us: number): number {
  return Math.round((us / 1_000) * 100) / 100;
}

function frameLabel(node: CpuProfileNode): string {
  const callFrame = node.callFrame;
  const functionName = callFrame?.functionName?.trim() || "(anonymous)";
  const url = callFrame?.url ?? "";
  const shortUrl = url.length === 0 ? "" : url.replace(/^file:\/\//, "");
  const line =
    callFrame?.lineNumber === undefined || callFrame.lineNumber < 0
      ? ""
      : `:${callFrame.lineNumber + 1}`;
  if (shortUrl.length === 0) return functionName;
  return `${functionName} ${shortUrl}${line}`;
}

function isNoiseFrame(label: string): boolean {
  return label === "(root)" || label === "" || label.startsWith("(idle)");
}

function profileToFolded(profile: CpuProfile): FoldedProfile {
  const nodesById = new Map<number, CpuProfileNode>();
  const parentById = new Map<number, number>();
  for (const node of profile.nodes) {
    nodesById.set(node.id, node);
    for (const childId of node.children ?? []) {
      parentById.set(childId, node.id);
    }
  }

  const samples = profile.samples ?? [];
  const defaultDeltaUs =
    samples.length > 0
      ? Math.max(1, Math.round((profile.endTime - profile.startTime) / samples.length))
      : 1_000;
  const stacks = new Map<string, number>();
  const selfTime = new Map<string, number>();
  let totalUs = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const sampleId = samples[index];
    if (sampleId === undefined) continue;
    const deltaUs = Math.max(1, Math.round(profile.timeDeltas?.[index] ?? defaultDeltaUs));
    const labels: string[] = [];
    let current: CpuProfileNode | undefined = nodesById.get(sampleId);
    while (current !== undefined) {
      const label = frameLabel(current);
      if (!isNoiseFrame(label)) {
        labels.push(label);
      }
      const parentId = parentById.get(current.id);
      current = parentId === undefined ? undefined : nodesById.get(parentId);
    }

    labels.reverse();
    if (labels.length === 0) continue;
    totalUs += deltaUs;
    const stack = labels.join(";");
    stacks.set(stack, (stacks.get(stack) ?? 0) + deltaUs);
    const leaf = labels[labels.length - 1];
    if (leaf !== undefined) {
      selfTime.set(leaf, (selfTime.get(leaf) ?? 0) + deltaUs);
    }
  }

  const topSelf = [...selfTime.entries()]
    .map(([label, us]) => ({ label, us }))
    .toSorted((left, right) => right.us - left.us)
    .slice(0, 30);

  return {
    totalUs,
    sampleCount: samples.length,
    stacks,
    topSelf,
  };
}

function buildFlameTree(folded: FoldedProfile): FlameNode {
  const root: FlameNode = { name: "(root)", us: 0, children: new Map() };
  for (const [stack, us] of folded.stacks) {
    root.us += us;
    let current = root;
    for (const frame of stack.split(";")) {
      let child = current.children.get(frame);
      if (child === undefined) {
        child = { name: frame, us: 0, children: new Map() };
        current.children.set(frame, child);
      }
      child.us += us;
      current = child;
    }
  }
  return root;
}

function maxDepth(node: FlameNode): number {
  if (node.children.size === 0) return 1;
  return 1 + Math.max(...[...node.children.values()].map(maxDepth));
}

function colorFor(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 68% 68%)`;
}

function renderFlameSvg(root: FlameNode): string {
  const width = 1_200;
  const frameHeight = 18;
  const depth = maxDepth(root);
  const height = Math.max(frameHeight, (depth - 1) * frameHeight);
  const minWidth = 0.4;
  const elements: string[] = [];

  function renderNode(node: FlameNode, x: number, y: number, nodeWidth: number): void {
    if (nodeWidth < minWidth) return;
    const label = node.name;
    const title = `${label}\n${formatMs(node.us)} ms (${((node.us / Math.max(root.us, 1)) * 100).toFixed(1)}%)`;
    const textCapacity = Math.max(0, Math.floor((nodeWidth - 6) / 7));
    const visibleLabel =
      textCapacity > 4 && label.length > textCapacity
        ? `${label.slice(0, Math.max(1, textCapacity - 1))}…`
        : label;
    elements.push(
      `<g><title>${escapeHtml(title)}</title><rect x="${x.toFixed(3)}" y="${y}" width="${nodeWidth.toFixed(3)}" height="${frameHeight - 1}" fill="${colorFor(label)}" stroke="rgba(0,0,0,.18)" stroke-width=".4"/>${
        textCapacity > 4
          ? `<text x="${(x + 3).toFixed(3)}" y="${y + 13}" font-size="11">${escapeHtml(visibleLabel)}</text>`
          : ""
      }</g>`,
    );
  }

  function layoutChildren(node: FlameNode, x: number, y: number, nodeWidth: number): void {
    let childX = x;
    const children = [...node.children.values()].toSorted((left, right) => right.us - left.us);
    for (const child of children) {
      const childWidth = node.us > 0 ? nodeWidth * (child.us / node.us) : 0;
      renderNode(child, childX, y, childWidth);
      layoutChildren(child, childX, y + frameHeight, childWidth);
      childX += childWidth;
    }
  }

  layoutChildren(root, 0, 0, width);
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="CPU flamegraph">${elements.join("")}</svg>`;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function maybeReadMetadata(profilePath: string): Promise<StartupProfileMetadata> {
  const metadataPath = profilePath.replace(/\.cpuprofile$/, ".meta.json");
  try {
    return await readJsonFile<StartupProfileMetadata>(metadataPath);
  } catch {
    return {};
  }
}

async function writeProfileArtifacts(input: {
  readonly profilePath: string;
  readonly profilesDir: string;
  readonly flamegraphsDir: string;
}): Promise<ProfileSummary> {
  const profile = await readJsonFile<CpuProfile>(input.profilePath);
  const metadata = await maybeReadMetadata(input.profilePath);
  const folded = profileToFolded(profile);
  const root = buildFlameTree(folded);
  const baseName = sanitizeFileName(path.basename(input.profilePath, ".cpuprofile"));
  const flamegraphPath = path.join(input.flamegraphsDir, `${baseName}.html`);
  const foldedPath = path.join(input.flamegraphsDir, `${baseName}.folded.txt`);
  const relativeProfilePath = path.relative(path.dirname(flamegraphPath), input.profilePath);
  const topSelfRows = folded.topSelf
    .map(
      (frame) =>
        `<tr><td>${escapeHtml(frame.label)}</td><td>${formatMs(frame.us).toFixed(2)}</td><td>${((frame.us / Math.max(folded.totalUs, 1)) * 100).toFixed(1)}%</td></tr>`,
    )
    .join("\n");

  await fs.writeFile(
    foldedPath,
    [...folded.stacks.entries()]
      .toSorted((left, right) => right[1] - left[1])
      .map(([stack, us]) => `${stack} ${Math.round(us)}`)
      .join("\n") + "\n",
  );
  await fs.writeFile(
    flamegraphPath,
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(metadata.role ?? baseName)} startup CPU flamegraph</title>
<style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:24px;color:#111827;background:#f9fafb}
a{color:#0f766e}svg{background:#fff;border:1px solid #d1d5db}text{fill:#111827;pointer-events:none}
table{border-collapse:collapse;margin-top:16px;width:100%;background:white}th,td{border-bottom:1px solid #e5e7eb;padding:6px 8px;text-align:left;font-size:13px}th{background:#f3f4f6}
.meta{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 16px}.meta span{background:white;border:1px solid #e5e7eb;padding:4px 8px;border-radius:4px}
</style>
</head>
<body>
<h1>${escapeHtml(metadata.role ?? "startup")} CPU Flamegraph</h1>
<p class="meta">
<span>pid ${escapeHtml(String(metadata.pid ?? "unknown"))}</span>
<span>reason ${escapeHtml(metadata.reason ?? "unknown")}</span>
<span>sampled CPU ${formatMs(folded.totalUs).toFixed(2)} ms</span>
<span>samples ${folded.sampleCount}</span>
${metadata.durationMs === undefined ? "" : `<span>wall ${metadata.durationMs.toFixed(0)} ms</span>`}
</p>
${renderFlameSvg(root)}
<h2>Top Self Time</h2>
<table><thead><tr><th>Frame</th><th>Self CPU ms</th><th>%</th></tr></thead><tbody>${topSelfRows}</tbody></table>
<p><a href="${escapeHtml(relativeProfilePath)}">Raw .cpuprofile</a></p>
</body>
</html>
`,
  );

  return {
    file: path.relative(repoRoot, input.profilePath),
    role: metadata.role ?? "unknown",
    pid: metadata.pid ?? null,
    reason: metadata.reason ?? "unknown",
    sampleCount: folded.sampleCount,
    totalCpuMs: formatMs(folded.totalUs),
    wallDurationMs: metadata.durationMs ?? null,
    flamegraph: path.relative(repoRoot, flamegraphPath),
    folded: path.relative(repoRoot, foldedPath),
    topSelf: folded.topSelf.slice(0, 10).map((frame) => ({
      label: frame.label,
      ms: formatMs(frame.us),
      percent: Math.round((frame.us / Math.max(folded.totalUs, 1)) * 10_000) / 100,
    })),
  };
}

async function findCpuProfiles(profilesDir: string): Promise<readonly string[]> {
  let entries: readonly string[] = [];
  try {
    entries = await fs.readdir(profilesDir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".cpuprofile"))
    .toSorted()
    .map((entry) => path.join(profilesDir, entry));
}

async function generateIndex(outDir: string, summaries: readonly ProfileSummary[]): Promise<void> {
  const rows = summaries
    .map(
      (summary) => `<tr>
<td>${escapeHtml(summary.role)}</td>
<td>${escapeHtml(String(summary.pid ?? ""))}</td>
<td>${escapeHtml(summary.reason)}</td>
<td>${summary.totalCpuMs.toFixed(2)}</td>
<td>${summary.wallDurationMs === null ? "" : summary.wallDurationMs.toFixed(0)}</td>
<td><a href="${escapeHtml(path.relative(outDir, path.resolve(repoRoot, summary.flamegraph)))}">flamegraph</a></td>
<td><a href="${escapeHtml(path.relative(outDir, path.resolve(repoRoot, summary.file)))}">profile</a></td>
</tr>`,
    )
    .join("\n");
  const topSections = summaries
    .map(
      (
        summary,
      ) => `<h2>${escapeHtml(summary.role)}${summary.pid === null ? "" : ` pid ${summary.pid}`}</h2>
<ol>${summary.topSelf
        .map(
          (frame) =>
            `<li><code>${escapeHtml(frame.label)}</code> ${frame.ms.toFixed(2)} ms (${frame.percent.toFixed(1)}%)</li>`,
        )
        .join("")}</ol>`,
    )
    .join("\n");

  await fs.writeFile(
    path.join(outDir, "index.html"),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Cafe Code desktop startup profiles</title>
<style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:24px;color:#111827;background:#f9fafb}
a{color:#0f766e}table{border-collapse:collapse;background:white;width:100%;margin:16px 0}th,td{border-bottom:1px solid #e5e7eb;padding:7px 8px;text-align:left;font-size:13px}th{background:#f3f4f6}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
</style>
</head>
<body>
<h1>Cafe Code Desktop Startup Profiles</h1>
<table><thead><tr><th>Role</th><th>PID</th><th>Reason</th><th>CPU ms</th><th>Wall ms</th><th>Flamegraph</th><th>Raw</th></tr></thead><tbody>${rows}</tbody></table>
${topSections}
</body>
</html>
`,
  );
}

async function generateProfileArtifacts(outDir: string): Promise<readonly ProfileSummary[]> {
  const profilesDir = path.join(outDir, "profiles");
  const flamegraphsDir = path.join(outDir, "flamegraphs");
  await fs.mkdir(flamegraphsDir, { recursive: true });
  const profilePaths = await findCpuProfiles(profilesDir);
  const summaries = await Promise.all(
    profilePaths.map((profilePath) =>
      writeProfileArtifacts({
        profilePath,
        profilesDir,
        flamegraphsDir,
      }),
    ),
  );
  await fs.writeFile(path.join(outDir, "summary.json"), `${JSON.stringify(summaries, null, 2)}\n`);
  await generateIndex(outDir, summaries);
  return summaries;
}

async function runProfile(options: CliOptions): Promise<void> {
  const profilesDir = path.join(options.outDir, "profiles");
  const stopFile = path.join(options.outDir, "stop");
  await fs.mkdir(profilesDir, { recursive: true });

  if (options.build) {
    process.stdout.write("[profile-startup] building desktop bundles...\n");
    await runCommand(["bun", "run", "build:desktop"]);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CAFE_CODE_STARTUP_PROFILE: "1",
    CAFE_CODE_STARTUP_PROFILE_DIR: profilesDir,
    CAFE_CODE_STARTUP_PROFILE_STOP_FILE: stopFile,
    CAFE_CODE_STARTUP_PROFILE_TIMEOUT_MS: String(options.durationMs),
    CAFE_CODE_STARTUP_PROFILE_ROLES: options.roles,
    CAFE_CODE_TRACE_MIN_LEVEL: process.env.CAFE_CODE_TRACE_MIN_LEVEL ?? "Debug",
    CAFE_CODE_TRACE_TIMING_ENABLED: process.env.CAFE_CODE_TRACE_TIMING_ENABLED ?? "1",
    CAFE_CODE_TRACE_FILE:
      process.env.CAFE_CODE_TRACE_FILE ?? path.join(options.outDir, "server.trace.ndjson"),
  };

  process.stdout.write(`[profile-startup] output: ${options.outDir}\n`);
  process.stdout.write(`[profile-startup] command: ${options.command.join(" ")}\n`);

  const child = spawnLogged(options.command, {
    env,
    stdoutPath: path.join(options.outDir, "start.stdout.log"),
    stderrPath: path.join(options.outDir, "start.stderr.log"),
    detached: process.platform !== "win32",
  });
  const exitPromise = waitForExit(child);
  let exited = false;
  exitPromise.then(() => {
    exited = true;
  });

  const stopAndTerminate = async (reason: string) => {
    if (!exited) {
      await fs.writeFile(stopFile, `${reason}\n`, { mode: 0o600 });
      await sleep(options.flushMs);
    }
    if (!exited) {
      signalProcessTree(child, "SIGTERM");
      await Promise.race([exitPromise, sleep(5_000)]);
    }
    if (!exited) {
      signalProcessTree(child, "SIGKILL");
      await Promise.race([exitPromise, sleep(2_000)]);
    }
  };

  const interrupt = async () => {
    await stopAndTerminate("interrupted");
    process.exit(130);
  };

  process.once("SIGINT", () => {
    void interrupt();
  });
  process.once("SIGTERM", () => {
    void interrupt();
  });

  const captureOutcome = await Promise.race([
    exitPromise.then(() => "process-exited" as const),
    sleep(options.durationMs).then(() => "duration-elapsed" as const),
  ]);
  await stopAndTerminate(captureOutcome);
  const exit = await exitPromise.catch(() => ({ code: null, signal: null }));
  await sleep(500);

  const summaries = await generateProfileArtifacts(options.outDir);
  process.stdout.write(
    `[profile-startup] captured ${summaries.length} profile(s); index: ${path.join(options.outDir, "index.html")}\n`,
  );
  if (captureOutcome === "process-exited" && (exit.code !== 0 || exit.signal !== null)) {
    throw new Error(
      `Profiled command exited with ${exit.signal ?? exit.code ?? "unknown status"}.`,
    );
  }
}

try {
  await runProfile(parseArgs(process.argv.slice(2)));
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`[profile-startup] ${message}\n`);
  process.exit(1);
}
