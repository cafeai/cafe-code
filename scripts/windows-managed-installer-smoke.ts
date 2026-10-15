// @effect-diagnostics nodeBuiltinImport:off
import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { removePathWithRetries } from "./windows-native-artifact-smoke.ts";

const installerTracePoints = [
  ["Set-StrictMode -Version 3.0", "script-start"],
  ["# Resolve the two inbox modules", "strict-mode-complete"],
  [
    'Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Management\\',
    "management-import-start",
  ],
  ['Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Utility\\', "utility-import-start"],
  ["function Resolve-InstallerPath {", "modules-complete"],
  ["$resolvedLocalAppData = Resolve-InstallerPath", "paths-start"],
  ["$cafeRoot = Join-Path", "join-path-start"],
  ["New-Item -ItemType Directory -Path $cafeRoot", "directory-start"],
  ['Write-JsonFile -Path (Join-Path $cafeRoot "installer-options.json")', "options-start"],
  ["if (-not $Enabled) {", "options-complete"],
  ["  Assert-ManagedDirectory -Path $managedRoot", "managed-directory"],
  ["  $nodeSource = Resolve-ManagedNodeSource", "node-source"],
  ["  $guard = [IO.File]::Open($guardPath", "guard-open"],
  ['    [Environment]::SetEnvironmentVariable("NODE_OPTIONS"', "guard-held"],
  ["    $prepared = @(& $nodePath", "prepare-start"],
  ["    if ($LASTEXITCODE -ne 0", "prepare-complete"],
  ["    if (-not (Test-Path -LiteralPath $generationRoot", "generation-check"],
  ["    Assert-ManagedDirectory -Path $generationRoot", "generation-directory"],
  ["    Assert-ManagedDirectory -Path $settingsParent", "settings-directory"],
  ["      $activation = Publish-ManagedRecord", "activation-publication"],
  ["      $result = Publish-ManagedRecord", "result-publication"],
  ["      if (Test-Path -LiteralPath $settingsPath)", "settings-publication"],
  ['  try { Write-InstallerLog "Verified managed', "committed"],
  ['  try { Write-InstallerLog "Managed provider runtime bootstrap failed', "failed"],
] as const;

/** Add fixed stdout observations only to the temporary synthetic copy. Direct
 * Console calls avoid loading a diagnostic cmdlet/module before the installer.
 * Flush each marker so a later block cannot hide completed script phases. Every
 * original statement and line ending remains byte-identical after removing
 * these markers; source drift is refused before launching PowerShell. */
export function instrumentManagedInstallerFixture(source: string): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  let instrumented = source;
  for (const [anchor, phase] of installerTracePoints) {
    if (source.split(anchor).length !== 2) {
      throw new Error("Managed installer fixture source changed; trace anchors require review.");
    }
    const indentation = /^\s*/.exec(anchor)![0];
    const detail =
      phase === "prepare-complete"
        ? `${indentation}[Console]::WriteLine('cafe-installer-fixture:preparation:exit={0}:count={1}:shape={2}', $ExecutionContext.SessionState.PSVariable.GetValue('LASTEXITCODE'), $prepared.Count, ($prepared.Count -eq 1 -and $prepared[0] -cmatch '^[a-f0-9]{32}$')); [Console]::Out.Flush()${newline}`
        : phase === "failed"
          ? `${indentation}[Console]::Error.WriteLine('cafe-installer-fixture:failure:{0}', ([string]$_.Exception.Message).Substring(0, [Math]::Min(1024, ([string]$_.Exception.Message).Length))); [Console]::Error.Flush()${newline}`
          : "";
    instrumented = instrumented.replace(
      anchor,
      () =>
        `${indentation}[Console]::WriteLine('cafe-installer-fixture:${phase}:{0:o}', [DateTime]::UtcNow); [Console]::Out.Flush()${newline}${detail}${anchor}`,
    );
  }
  return instrumented;
}

/** Only system-owned PowerShell modules and fixture-owned caches/profiles may
 * participate in this native fixture, independent of the invoking shell. */
export function managedInstallerFixtureEnvironment(input: {
  readonly systemRoot: string;
  readonly powershell: string;
  readonly node: string;
  readonly profile: string;
  readonly local: string;
  readonly root: string;
}): NodeJS.ProcessEnv {
  return {
    SystemRoot: input.systemRoot,
    WINDIR: input.systemRoot,
    USERPROFILE: input.profile,
    APPDATA: join(input.profile, "AppData", "Roaming"),
    LOCALAPPDATA: input.local,
    TEMP: input.root,
    TMP: input.root,
    PATH: dirname(input.node),
    // Classify the copied Node as a native executable. Windows PowerShell's
    // document-association path can return without stdout or LASTEXITCODE.
    // Only .exe peers are used here; never inherit shell/script extensions.
    PATHEXT: ".EXE",
    PSModulePath: join(dirname(input.powershell), "Modules"),
    PSModuleAnalysisCachePath: join(input.root, "PowerShellModuleAnalysisCache"),
  };
}

/** Explicit native qualification of the real PowerShell activation/rollback
 * boundary. Only its package-preparation child is replaced with an inert peer;
 * no provider, registry, real profile or credentials participate. */
async function run() {
  if (process.platform !== "win32" || process.env.CAFE_CODE_WINDOWS_MANAGED_INSTALLER_E2E !== "1")
    throw new Error("Explicit native Windows managed-installer qualification required.");
  const root = await realpath(await mkdtemp(join(tmpdir(), "cafe-managed-installer-")));
  const installDir = join(root, "Cafe with spaces");
  const local = join(root, "local");
  const profile = join(root, "profile");
  const managed = join(local, "CafeCode", "managed");
  const settings = join(profile, ".cafe-code", "userdata", "settings.json");
  const resource = join(installDir, "resources", "managed-runtime");
  const nativeNode = join(resource, "node", process.arch === "arm64" ? "win-arm64" : "win-x64");
  const script = join(resource, "install-managed-provider-runtime.ps1");
  const powershell = join(
    process.env.SystemRoot!,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const environment = managedInstallerFixtureEnvironment({
    systemRoot: process.env.SystemRoot!,
    powershell,
    node: process.execPath,
    profile,
    local,
    root,
  });
  let invocation = 0;
  const start = (phase: string) => {
    const log = join(root, `installer-${++invocation}.log`);
    const receipt = join(root, `preparation-${invocation}.json`);
    // A file captures native output without an inherited pipe delaying the
    // primary PowerShell exit while the deliberately detached peer is paused.
    const output = openSync(log, "wx");
    console.info("managed-installer-fixture", { phase, event: "start" });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "-Enabled",
          "-InstallDir",
          installDir,
          "-LocalAppData",
          local,
          "-UserProfile",
          profile,
        ],
        {
          shell: false,
          windowsHide: true,
          env: { ...environment, CAFE_CODE_INSTALLER_FIXTURE_RECEIPT: receipt },
          stdio: ["ignore", output, output],
        },
      );
    } finally {
      closeSync(output);
    }
    const exit = new Promise<number>((accept, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 30_000);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Synthetic installer could not launch."));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        timedOut
          ? reject(new Error(`Synthetic installer exceeded its deadline (${phase}).`))
          : accept(code ?? -1);
      });
    });
    const readBoundedOutput = async (path: string, limit: number) => {
      const file = await open(path, "r");
      try {
        const bytes = Buffer.alloc(limit);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        return bytes.subarray(0, bytesRead).toString("utf8");
      } finally {
        await file.close();
      }
    };
    const reportOutput = async () => {
      const preparation = await readBoundedOutput(receipt, 512).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      console.error("managed-installer-fixture-output", {
        phase,
        output: await readBoundedOutput(log, 16 * 1024 - 512),
        preparation,
      });
    };
    const observedExit = exit.then(
      async (code) => {
        console.info("managed-installer-fixture", { phase, event: "exit", code });
        if (code !== 0) await reportOutput();
        return code;
      },
      async (error) => {
        await reportOutput();
        throw error;
      },
    );
    return { child, exit: observedExit };
  };
  const invoke = (phase: string) => start(phase).exit;
  const waitForFile = async (file: string) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        await readFile(file);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await new Promise((accept) => setTimeout(accept, 50));
    }
    throw new Error("Synthetic installer peer did not reach its bounded phase.");
  };
  const assert = (value: boolean, message: string) => {
    if (!value) throw new Error(message);
  };
  try {
    await mkdir(nativeNode, { recursive: true });
    await mkdir(local, { recursive: true });
    await mkdir(profile, { recursive: true });
    await copyFile(process.execPath, join(nativeNode, "node.exe"));
    await writeFile(
      script,
      instrumentManagedInstallerFixture(
        await readFile(
          resolve("apps/desktop/resources/managed-runtime/install-managed-provider-runtime.ps1"),
          "utf8",
        ),
      ),
    );
    await writeFile(
      join(resource, "install-runtime.mjs"),
      `
      import * as fs from 'node:fs';import * as path from 'node:path';import {randomUUID} from 'node:crypto';
      const [operation,bundle,root]=process.argv.slice(2);
      // One exclusive receipt per invocation, including refused preparations.
      // Only fixed scalars: never argv, profiles, credentials or provider data.
      fs.writeFileSync(process.env.CAFE_CODE_INSTALLER_FIXTURE_RECEIPT,JSON.stringify({
        argc:process.argv.length-2,
        operationMatches:operation==='--prepare',
        bundleMatches:bundle===${JSON.stringify(join(resource, "providers", process.arch === "arm64" ? "win-arm64" : "win-x64"))},
        rootMatches:root===${JSON.stringify(managed)},
      }),{flag:'wx'});
      if(operation!=='--prepare'||fs.existsSync(path.join(root,'fixture-fail')))process.exit(11);
      if(fs.existsSync(path.join(root,'fixture-pause'))){
        fs.writeFileSync(path.join(root,'fixture-preparing'),'');
        const deadline=Date.now()+60000;
        while(fs.existsSync(path.join(root,'fixture-pause'))){
          if(Date.now()>deadline)process.exit(12);
          await new Promise(accept=>setTimeout(accept,50));
        }
      }
      const generation=randomUUID().replaceAll('-','');
      const selected=path.join(root,'generations',generation);
      fs.mkdirSync(path.join(selected,'node'),{recursive:true});
      fs.writeFileSync(path.join(selected,'node','node.exe'),'synthetic prepared node');
      fs.writeFileSync(path.join(selected,'qualified.txt'),'qualified fixture bytes');
      console.log(generation);
      fs.writeFileSync(path.join(root,'fixture-child-completed'),'');
    `,
    );
    assert((await invoke("fresh")) === 0, "Fresh synthetic installation failed.");
    const qualifyLayout = async (expected: string) => {
      await promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          "const module=await import(process.argv[1]);const layout=module.resolveManagedProviderRuntimeLayout({provider:'codex',env:{CAFE_CODE_MANAGED_RUNTIME_ROOT:process.argv[2]}});if(process.argv[3]==='--none' ? layout!==null : layout?.installRoot!==process.argv[3])throw new Error('Native managed activation resolution failed.');",
          pathToFileURL(resolve("apps/server/src/provider/managedProviderRuntime.ts")).href,
          managed,
          expected,
        ],
        { env: environment, windowsHide: true, timeout: 30_000, maxBuffer: 65536 },
      );
    };
    const active = join(managed, "active-runtime.json");
    const result = join(managed, "install-result.json");
    const first = JSON.parse(await readFile(active, "utf8")) as { generation: string };
    assert(/^[a-f0-9]{32}$/u.test(first.generation), "Fresh activation has no exact generation.");
    await qualifyLayout(join(managed, "generations", first.generation, "providers", "codex"));
    await writeFile(settings, '{"userPreference":"preserve"}');
    assert((await invoke("repair")) === 0, "Synthetic repair failed.");
    const selected = await readFile(active, "utf8");
    const selectedResult = await readFile(result, "utf8");
    assert(
      (await readFile(settings, "utf8")) === '{"userPreference":"preserve"}',
      "Repair changed existing preferences.",
    );
    assert(
      (await readFile(join(managed, "generations", first.generation, "qualified.txt"), "utf8")) ===
        "qualified fixture bytes",
      "Repair removed a prior generation.",
    );
    await writeFile(join(managed, "fixture-fail"), "");
    assert((await invoke("preparation-failure")) !== 0, "Preparation failure reported success.");
    assert(
      (await readFile(active, "utf8")) === selected,
      "Preparation failure changed activation.",
    );
    await rm(join(managed, "fixture-fail"));
    await rm(settings);
    await mkdir(settings);
    assert(
      (await invoke("settings-failure")) !== 0,
      "Settings publication failure reported success.",
    );
    assert(
      (await readFile(active, "utf8")) === selected,
      "Settings failure did not restore activation.",
    );
    assert(
      (await readFile(result, "utf8")) === selectedResult,
      "Settings failure did not restore the prior result.",
    );
    await rm(settings, { recursive: true });
    await writeFile(settings, '{"userPreference":"preserve"}');
    await rm(result);
    await mkdir(result);
    assert((await invoke("result-failure")) !== 0, "Result publication failure reported success.");
    assert(
      (await readFile(active, "utf8")) === selected,
      "Result failure did not restore activation.",
    );
    await rm(result, { recursive: true });
    await writeFile(result, selectedResult);
    await writeFile(active, "malformed activation");
    await qualifyLayout("--none");
    await writeFile(active, selected);
    await rm(join(managed, "fixture-child-completed"));
    await writeFile(join(managed, "fixture-pause"), "");
    const interrupted = start("interruption");
    const interruptedExit = interrupted.exit;
    // Observe rejection immediately, including while awaiting peer readiness.
    const completed = interruptedExit.then(
      (code) => ({ code }),
      () => ({ code: -1 }),
    );
    let preparing = false;
    try {
      await waitForFile(join(managed, "fixture-preparing"));
      preparing = true;
      assert(
        (await invoke("competing-guard")) !== 0,
        "A competing installer bypassed the OS-held guard.",
      );
      interrupted.child.kill();
      await completed;
      await rm(join(managed, "fixture-pause"));
      await waitForFile(join(managed, "fixture-child-completed"));
      assert(
        (await readFile(active, "utf8")) === selected,
        "A detached preparation child gained activation authority.",
      );
      assert(
        (await invoke("repair-after-interruption")) === 0,
        "Repair did not reacquire a dead installer's OS guard.",
      );
    } finally {
      if (interrupted.child.exitCode === null) interrupted.child.kill();
      await completed;
      await rm(join(managed, "fixture-pause"), { force: true });
      if (preparing) await waitForFile(join(managed, "fixture-child-completed"));
    }
    console.info(
      "Native synthetic managed-installer prepare, repair, rollback, guard and interruption checks passed.",
    );
  } finally {
    await removePathWithRetries(root);
  }
}
if (import.meta.main) await run();
