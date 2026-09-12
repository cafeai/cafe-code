import { spawnSync } from "node:child_process";
import * as NodeOs from "node:os";

// Opt-in synthetic process check. Only the disposable child lowers its priority.
const moduleUrl = new URL(
  "../apps/server/src/providerDaemon/ProviderDaemonPriority.ts",
  import.meta.url,
).href;
const childSource = `
  import { spawnSync } from 'node:child_process';
  import * as os from 'node:os';
  import { lowerProviderDaemonPriority } from ${JSON.stringify(moduleUrl)};
  const status = lowerProviderDaemonPriority();
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(require("node:os").getPriority()))'], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true, timeout: 5000,
  });
  if (status === 'unavailable' || child.status !== 0) process.exit(1);
  process.stdout.write(JSON.stringify({status, parent: os.getPriority(), child: Number(child.stdout)}));
`;
const result = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], {
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf8",
  windowsHide: true,
  timeout: 10_000,
});
if (result.status !== 0) throw new Error("Synthetic provider priority check failed.");
const evidence = JSON.parse(result.stdout) as { parent: number; child: number };
if (
  !Number.isFinite(evidence.parent) ||
  !Number.isFinite(evidence.child) ||
  evidence.parent < NodeOs.constants.priority.PRIORITY_BELOW_NORMAL ||
  evidence.child < evidence.parent
) {
  throw new Error("Synthetic child did not inherit the lower scheduling priority.");
}
process.stdout.write(`${JSON.stringify(evidence)}\n`);
