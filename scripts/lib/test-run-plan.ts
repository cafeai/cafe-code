import { resolve } from "node:path";
import browserPolicy from "../../apps/web/browser-test-policy.json" with { type: "json" };
import type { BrowserArtifactDirectory } from "./browser-test-artifacts.ts";
import type { CompleteLocalBrowserSelection } from "./browser-test-selection.ts";

export interface TestStep {
  readonly name: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}
export const testRepositoryRoot = resolve(import.meta.dirname, "../..");
const reporter = resolve(import.meta.dirname, "test-timing-reporter.ts");
const reporters = ["--reporter=default", `--reporter=${reporter}`];

export function nodeTestPlan(platform: NodeJS.Platform): readonly TestStep[] {
  const plans =
    platform === "win32"
      ? [["test", "--concurrency=2", "--", "--maxWorkers=2", ...reporters]]
      : [
          ["test", "--filter=!effect-codex-app-server", "--", ...reporters],
          ["test", "--filter=effect-codex-app-server", "--", ...reporters],
        ];
  return plans.map((args, index) => ({ name: `Node tests ${index + 1}`, args }));
}

export function browserTestPlan(
  platform: NodeJS.Platform,
  completeLocal?: {
    readonly selection: CompleteLocalBrowserSelection;
    readonly artifacts: BrowserArtifactDirectory;
  },
): readonly TestStep[] {
  const browser = (name: string, args: readonly string[]): TestStep => ({
    name,
    args: ["workspace", "@cafecode/web", "test:browser", ...args, "--maxWorkers=2", ...reporters],
  });
  const nativeSubset = platform !== "linux" || completeLocal !== undefined;
  const selection = completeLocal?.selection;
  return [
    completeLocal
      ? {
          name: "Prepare isolated MCP bridge fixtures",
          args: [
            "exec",
            "node",
            resolve(import.meta.dirname, "../prepare-browser-test-bridges.ts"),
            completeLocal.artifacts.path,
            completeLocal.artifacts.device,
            completeLocal.artifacts.inode,
          ],
        }
      : { name: "Build desktop fixtures", args: ["build:desktop"] },
    browser("Desktop and touch features", [
      ...(selection
        ? [...selection.desktopFiles, ...selection.touchFiles]
        : nativeSubset
          ? browserPolicy.nativeDesktopFiles
          : []),
      "--project=desktop",
      "--project=touch",
    ]),
    browser("Ordinary-motion fluid", ["--project=visualization-fluid-motion"]),
    browser("Reduced motion", ["--project=context-reduced-motion"]),
    ...(nativeSubset
      ? [
          browser(
            "Mermaid security",
            selection?.mermaidSecurityFiles ?? browserPolicy.mermaidSecurityFiles,
          ),
          browser(
            "Mermaid families",
            selection?.mermaidFamilyFiles ?? browserPolicy.mermaidFamilyFiles,
          ),
          browser(
            "Diagram and table PNG",
            selection?.imageExportFiles ?? browserPolicy.imageExportFiles,
          ),
        ]
      : []),
    {
      name: "MCP bridge artifacts",
      args: [
        "workspace",
        "@cafeai/cafe-code",
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.e2e.config.ts",
        "integration/CafeMcpBridge.e2e.test.ts",
        ...reporters,
      ],
      env: {
        CAFE_CODE_MCP_BRIDGE_E2E: "1",
        ...(completeLocal ? { CAFE_CODE_MCP_BRIDGE_DIR: completeLocal.artifacts.path } : {}),
      },
    },
    ...(nativeSubset
      ? [
          browser(
            "Full-access inline visualizations",
            selection?.inlineFiles ?? browserPolicy.inlineFiles,
          ),
        ]
      : []),
  ];
}
