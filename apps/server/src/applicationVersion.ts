import packageJson from "../package.json" with { type: "json" };

/** The bundler replaces this identifier with the validated, immutable build
 * version. Direct source execution deliberately leaves it undefined and uses
 * the source manifest instead. Never resolve this identity from process.env:
 * an environment inherited by a running backend is not release provenance. */
declare const __CAFE_CODE_BUILD_VERSION__: string | undefined;

/** Keep selection pure so source and packaged-version behavior can be tested
 * without loading a CLI, provider, profile or application runtime. Validation
 * belongs to the build boundary before its compile-time literal is emitted. */
export function resolveApplicationVersion(buildVersion: string | undefined): string {
  return buildVersion ?? packageJson.version;
}

/** One application identity is shared by CLI output, environment descriptors,
 * daemon compatibility and Cafe-owned provider client metadata. In particular,
 * copying a newer package.json beside an older bundle cannot relabel it. */
export const APPLICATION_VERSION = resolveApplicationVersion(
  typeof __CAFE_CODE_BUILD_VERSION__ === "string" ? __CAFE_CODE_BUILD_VERSION__ : undefined,
);
