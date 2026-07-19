/**
 * Resolve `catalog:` dependency specs using the root Yarn catalog.
 *
 * Pure function: returns a new record with every `catalog:…` value replaced by
 * the concrete version string found in `catalog`. Throws on missing entries.
 */
export function resolveCatalogDependencies(
  dependencies: Record<string, string>,
  catalog: Record<string, string>,
  label: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, spec]) => {
      if (typeof spec !== "string" || !spec.startsWith("catalog:")) {
        return [name, spec];
      }

      const catalogKey = spec.slice("catalog:".length).trim();
      const lookupKey = catalogKey.length > 0 ? catalogKey : name;
      const resolved = catalog[lookupKey];

      if (typeof resolved !== "string" || resolved.length === 0) {
        throw new Error(
          `Unable to resolve '${spec}' for ${label} dependency '${name}'. Expected key '${lookupKey}' in the root Yarn catalog.`,
        );
      }

      return [name, resolved];
    }),
  );
}

/**
 * Materialize dependencies for a package whose internal workspace imports are
 * already bundled into its runtime output. Workspace entries must be omitted
 * because they cannot be resolved by an npm consumer; catalog entries must be
 * replaced with ordinary npm version specifications.
 */
export function resolveBundledPackageDependencies(
  dependencies: Record<string, string>,
  catalog: Record<string, string>,
  label: string,
): Record<string, string> {
  return resolveCatalogDependencies(
    Object.fromEntries(
      Object.entries(dependencies).filter(([, spec]) => !spec.startsWith("workspace:")),
    ),
    catalog,
    label,
  );
}

const npmPackageNamePattern = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i;

/**
 * Translate repository-level Yarn resolutions into metadata npm accepts in a
 * published package. Yarn permits descriptor-qualified keys and patch
 * locators; npm's `overrides` field permits neither. Descriptor-qualified
 * entries only control the repository's build tools, so they are intentionally
 * omitted from the runtime package. A patched package keeps its concrete base
 * version in the published override because the patch is already compiled into
 * Cafe Code's bundles and cannot be applied by npm consumers.
 */
export function resolveNpmOverrides(
  resolutions: Record<string, string>,
  catalog: Record<string, string>,
  label: string,
): Record<string, string> {
  const resolved = resolveCatalogDependencies(resolutions, catalog, label);

  return Object.fromEntries(
    Object.entries(resolved).flatMap(([name, spec]) => {
      if (!npmPackageNamePattern.test(name)) {
        return [];
      }

      if (!spec.startsWith("patch:")) {
        return [[name, spec]];
      }

      const locatorEnd = spec.indexOf("#");
      const locator = locatorEnd === -1 ? spec : spec.slice(0, locatorEnd);
      const npmVersionMarker = "@npm%3A";
      const markerIndex = locator.lastIndexOf(npmVersionMarker);
      if (markerIndex === -1) {
        throw new Error(`Unable to translate Yarn patch resolution '${spec}' for ${label}.`);
      }

      return [[name, decodeURIComponent(locator.slice(markerIndex + npmVersionMarker.length))]];
    }),
  );
}
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

export function readYarnCatalog(repoRoot: string): Record<string, string> {
  const configuration = parse(readFileSync(resolve(repoRoot, ".yarnrc.yml"), "utf8")) as unknown;
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    throw new Error("Root Yarn configuration must be a YAML mapping.");
  }

  const catalog = (configuration as Record<string, unknown>).catalog;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error("Root Yarn configuration must define a default catalog.");
  }

  const entries = Object.entries(catalog);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
    throw new Error("Every root Yarn catalog value must be a string.");
  }
  return Object.fromEntries(entries);
}
