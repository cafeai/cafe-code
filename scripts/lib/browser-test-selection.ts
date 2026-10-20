import { createRequire } from "node:module";
import { resolve, sep } from "node:path";
import { configDefaults } from "vitest/config";
import browserPolicy from "../../apps/web/browser-test-policy.json" with { type: "json" };

export interface BrowserSelectionPolicy {
  readonly desktopInclude: readonly string[];
  readonly touchTimelineFile: string;
  readonly visualizationFluidFile: string;
  readonly reducedMotionFiles: readonly string[];
  readonly browserStressPattern: string;
  readonly mermaidSecurityFiles: readonly string[];
  readonly mermaidFamilyFiles: readonly string[];
  readonly imageExportFiles: readonly string[];
  readonly inlineFiles: readonly string[];
}

export interface CompleteLocalBrowserSelection {
  readonly desktopFiles: readonly string[];
  readonly touchFiles: readonly string[];
  readonly fluidFiles: readonly string[];
  readonly reducedMotionFiles: readonly string[];
  readonly mermaidSecurityFiles: readonly string[];
  readonly mermaidFamilyFiles: readonly string[];
  readonly imageExportFiles: readonly string[];
  readonly inlineFiles: readonly string[];
}

// These are admission bounds, not an inventory of today's tests. Refuse a
// growing/ambiguous command rather than silently truncating its qualification.
const maximumBrowserFiles = 4_096;
const maximumFilterBytes = 24_000;

export function browserTestMode(args: readonly string[]): "native-ci" | "complete-local" {
  if (args.length === 0) return "native-ci";
  if (args.length === 1 && args[0] === "--complete-local") return "complete-local";
  throw new Error("Browser tests accept only the optional --complete-local mode.");
}

function admittedFile(file: string): boolean {
  return (
    file.length <= 1_024 &&
    file.startsWith("src/components/") &&
    file.endsWith(".browser.tsx") &&
    !file.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(file) &&
    file.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** Partition the complete discovered set, not a hand-maintained ordinary list.
 * Every declared specialized file must exist and have exactly one owner. */
export function partitionCompleteBrowserFiles(
  discoveredFiles: readonly string[],
  policy: BrowserSelectionPolicy,
): CompleteLocalBrowserSelection {
  if (
    discoveredFiles.length === 0 ||
    discoveredFiles.length > maximumBrowserFiles ||
    discoveredFiles.some((file) => !admittedFile(file)) ||
    new Set(discoveredFiles).size !== discoveredFiles.length
  ) {
    throw new Error("Complete browser discovery is empty, excessive or malformed.");
  }
  const discovered = new Set(discoveredFiles);
  const claimed = new Set<string>();
  const own = (files: readonly string[]): readonly string[] => {
    if (files.length === 0) throw new Error("A required browser qualification group is empty.");
    for (const file of files) {
      if (!admittedFile(file) || !discovered.has(file) || claimed.has(file))
        throw new Error("A browser qualification file is missing or has conflicting owners.");
      claimed.add(file);
    }
    return [...files].sort();
  };
  const touchFiles = own([policy.touchTimelineFile]);
  const fluidFiles = own([policy.visualizationFluidFile]);
  const reducedMotionFiles = own(policy.reducedMotionFiles);
  const mermaidSecurityFiles = own(policy.mermaidSecurityFiles);
  const mermaidFamilyFiles = own(policy.mermaidFamilyFiles);
  const imageExportFiles = own(policy.imageExportFiles);
  const inlineFiles = own(policy.inlineFiles);
  const desktopFiles = discoveredFiles.filter((file) => !claimed.has(file)).sort();
  if (desktopFiles.length === 0) throw new Error("The ordinary browser qualification is empty.");

  // Vitest's positional filenames are case-insensitive substring filters, not
  // exact include globs. A newly named sibling must not accidentally cause a
  // deferred desktop file to run in two invocations on any host.
  const desktopGroups = [
    desktopFiles,
    mermaidSecurityFiles,
    mermaidFamilyFiles,
    imageExportFiles,
    inlineFiles,
  ];
  const eligibleDesktop = desktopGroups.flat();
  for (const files of desktopGroups) {
    const expected = new Set(files);
    const filters = files.map((file) => file.toLowerCase());
    if (
      eligibleDesktop.some(
        (file) =>
          filters.some((filter) => file.toLowerCase().includes(filter)) !== expected.has(file),
      )
    ) {
      throw new Error("Browser filename filters overlap qualification groups.");
    }
    if (Buffer.byteLength(files.join("\0"), "utf8") > maximumFilterBytes)
      throw new Error("The browser filename selection exceeds the native command bound.");
  }
  if (Buffer.byteLength([...desktopFiles, ...touchFiles].join("\0"), "utf8") > maximumFilterBytes) {
    throw new Error("The browser filename selection exceeds the native command bound.");
  }
  return {
    desktopFiles,
    touchFiles,
    fluidFiles,
    reducedMotionFiles,
    mermaidSecurityFiles,
    mermaidFamilyFiles,
    imageExportFiles,
    inlineFiles,
  };
}

interface VitestGlobber {
  readonly globSync: (
    include: readonly string[],
    options: {
      readonly cwd: string;
      readonly dot: boolean;
      readonly ignore: readonly string[];
      readonly expandDirectories: boolean;
    },
  ) => string[];
}

export function resolveCompleteLocalBrowserSelection(
  repositoryRoot: string,
  policy: BrowserSelectionPolicy = browserPolicy,
): CompleteLocalBrowserSelection {
  const require = createRequire(import.meta.url);
  // Resolve the declared dependency from Vitest's own package scope. This
  // deliberately uses the pinned runner's glob engine without adding a second
  // matcher, new package or dependence on accidental root hoisting.
  const vitestRequire = createRequire(require.resolve("vitest/package.json"));
  const { globSync } = vitestRequire("tinyglobby") as VitestGlobber;
  const files = globSync(policy.desktopInclude, {
    cwd: resolve(repositoryRoot, "apps/web"),
    dot: true,
    ignore: [...configDefaults.exclude, policy.browserStressPattern],
    expandDirectories: false,
  }).map((file) => file.split(sep).join("/"));
  return partitionCompleteBrowserFiles(files, policy);
}
