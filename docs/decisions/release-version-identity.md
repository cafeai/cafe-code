# One application version across release components

Created: 2026-10-19 04:11:51 JST (UTC+0900)
Last updated: 2026-10-19 04:54:11 JST (UTC+0900)
Decision status: selected as an implementation choice under the user's request
to fix release-version propagation and document/test the release process.
Implementation status: implemented with local build and regression coverage.
Verification scope: source-level tests, actual emitted version-only fixtures and
desktop compilation. No release publication, native installation or
update/relaunch qualification is claimed by this decision.
Supersession: supplements the existing release workflow and trust model; does
not replace normal CI, signing, notarization or artifact verification.

## Context

Native package metadata can be correct while compiled application components
still report a source-package version. The packaging path selected the requested
release version after the source build and applied it to the staged native
package. The web build could independently use its source manifest; backend
version consumers read the server source manifest. This allowed a native
`0.2.2` package to contain components compiled with `0.2.1` identity despite
passing the existing artifact, signature and checksum checks.

The fix must propagate one selected version into compilation, reject stale
component reuse, preserve unoverridden source builds and keep release inputs
reproducible without an automatic source-manifest rewrite. An installed process
must not change its reported application version merely because an ambient
environment variable changes.

## Decision

Packaging resolves a finite valid version once, before building. Its explicit
requested version takes precedence over the server source-package fallback.
Invalid nonblank values refuse rather than silently falling back. The build
child receives that value as `APP_VERSION`; the staged native package uses the
same value. Turbo's existing hashed `globalEnv` includes `APP_VERSION`, binding
cached outputs to this build input.

The web compiler bakes `import.meta.env.APP_VERSION`; the backend compiler bakes
one `APPLICATION_VERSION` scalar used by its own CLI, runtime and environment
reporting. Runtime environment variables cannot change those emitted values.
An ordinary source build without an override retains its source manifest's
version fallback. Source package versions do not need to change to create a
versioned artifact; the existing package-version rewrite helper remains an
optional deliberate source edit, not a release prerequisite.

Each component build publishes an `application-build-version.json` manifest
from its actual successful emitted entrypoints and JavaScript chunks (plus the
web HTML entry). It binds the finite component role, resolved application
version, relative file names, exact byte counts and SHA-256 digests. Validation
rejects malformed or oversized records, duplicate/unsafe names, linked output
files and changed file/namespace observations. Receipt publication is atomic;
failure cannot mint a receipt for missing or different emitted bytes.

Packaging validates web/server component versions and bytes before staging and
after copying the backend and its bundled web payload. `--skip-build` does not
waive these checks. Missing, stale, wrong-role, mismatched-version or altered
output must be rebuilt with the intended version; editing a receipt is not a
supported repair.

Existing `.br`/`.gz` sidecars must decode to each recorded payload's exact
length and SHA-256 digest. Raw and compressed inputs share finite size budgets,
and native decompression is bounded by the raw length. This closes the case
where a valid raw renderer sits beside a stale preferred HTTP representation;
missing sidecars still permit raw delivery.

The normal release workflow still binds its exact source commit, requires normal
CI and all four platform artifacts, verifies macOS signatures/notarization and
artifact identity, and validates update manifests, sizes and checksums before
publication. Build-only runs retain their explicit narrower meaning. No branch,
tag, release, existing asset or website is modified by this implementation.

## Alternatives

- Automatically rewriting every source package version before packaging was
  rejected: it mutates the qualified source and still does not prove cached or
  copied component bytes contain the intended version.
- Setting a runtime environment variable was rejected: it relabels observation
  rather than fixing compiled identity, and makes an installed version depend
  on the launcher's environment.
- Inspecting only native package metadata, output filenames or release feeds
  was rejected: those can agree while compiled renderer/backend values differ.
- Trusting a version-only receipt was rejected: a stale or modified output
  could reuse it. Component receipts therefore bind the actual emitted bytes.
- Disabling cache reuse or banning `--skip-build` was unnecessary: verified
  same-version, byte-identical outputs may be reused without relaxing checks.

## Consequences and operating limits

Old outputs without component receipts fail packaging and require an explicit
rebuild. A version change participates in the build cache key and cannot be
applied only to native metadata. The selected release version need not match the
source manifests when an explicit override is present.

This is a local build-consistency boundary, not publisher authentication against
a same-user source editor who can forge both bytes and receipts. It does not
replace native signatures, transport/download checks or the exact-source
release evidence. It also does not prove a packaged app launched, installed or
successfully upgraded on any host.

Published versions and artifacts remain immutable. Repairing already published
`0.2.2` requires a separately authorized unused newer release, not moving the
old tag or replacing its payload. Release-branch creation and synchronizing
`main` require their own explicit scope; neither is inferred from a build.
`CafeCode.sh` updates are separate scope: inspect the website's own repository
and deployment configuration. Desktop release success is not evidence of
website changes or authority to deploy them.

## Verification requirements

Required regression evidence covers stable/nightly overrides different from
source versions, omitted override fallback, invalid values, the actual compiled
web/backend version scalars, runtime-environment invariance, and cache/reuse
behavior. Component tests must reject missing/malformed/wrong-role/wrong-version
receipts and missing/changed/unsafe emitted files before staging and after copy.
Use inert temporary outputs rather than installed apps, providers or user data.

Run the pinned Node/Corepack Yarn formatting, lint, typecheck and default tests,
plus affected browser/copied-bridge checks. The forced desktop build remains the
final local verification step. Record failed gates and their evidence rather
than treating a later build as proof they passed. Native Windows/Linux behavior,
signed macOS installation/update and future release publication remain separate
qualification boundaries. Local implementation checks alone cannot claim them.

## References

- [Desktop releases and updates](../desktop-releases-and-updates.md)
- `.github/workflows/release.yml`
- `scripts/build-desktop-artifact.ts`
- `packages/shared/src/applicationBuildVersion.ts`
- `apps/web/vite.config.ts` and `apps/server/tsdown.config.ts`
- `turbo.json`
