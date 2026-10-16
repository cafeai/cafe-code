import { mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { Reporter, TestModule, Vitest } from "vitest/node";

export function moduleTiming(module: TestModule) {
  const diagnostic = module.diagnostic();
  return {
    file: relative(resolve(import.meta.dirname, "../.."), module.moduleId).replaceAll("\\", "/"),
    project: module.project.name,
    executionMs: diagnostic.duration,
    collectionMs: diagnostic.collectDuration,
    setupMs: diagnostic.setupDuration,
    // Vitest 5.0.2's browser prepareDuration includes reused page uptime.
    // Omit that misleading counter; retain actual wall and test durations.
    tests: [...module.children.allTests()].map((test) => ({
      name: test.fullName.slice(0, 300),
      durationMs: test.diagnostic()?.duration ?? 0,
      state: test.result().state,
    })),
  };
}

export default class TestTimingReporter implements Reporter {
  private started = performance.now();
  private cwd = "";
  onInit(ctx: Vitest) {
    this.cwd = ctx.config.root;
  }
  async onTestRunEnd(modules: readonly TestModule[]) {
    const root = resolve(import.meta.dirname, "../..");
    const output = resolve(root, ".logs/test-timings");
    const files = modules.map(moduleTiming);
    const report = {
      workspace: relative(root, this.cwd).replaceAll("\\", "/"),
      wallMs: performance.now() - this.started,
      files,
    };
    await mkdir(output, { recursive: true });
    const name = `${report.workspace.replaceAll("/", "-") || "root"}-${process.pid}-${Date.now()}.json`;
    // Timings and source test labels only: no errors, received values, snapshots,
    // environment, credentials, console output or arbitrary test metadata.
    await writeFile(resolve(output, name), JSON.stringify(report, null, 2));
    console.log("Slowest test files:");
    for (const file of [...files].sort((a, b) => b.executionMs - a.executionMs).slice(0, 10))
      console.log(`  ${(file.executionMs / 1000).toFixed(2)}s ${file.file}`);
  }
}
