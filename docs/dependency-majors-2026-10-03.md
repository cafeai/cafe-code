# Reviewed major dependency migrations — October 3, 2026

Created: 2026-10-03 11:29:41 JST (UTC+0900)

This is the explicitly requested major-update follow-up to the
[earlier reviewed batch](dependency-updates-2026-10-03.md), based on `dev` commit
`0cdd91eb389b96a8b28d5ab3236a3020c978a313` and
[Renovate dashboard #113](https://github.com/cafeai/cafe-code/issues/113).
It does not approve unrelated proposals, waive the seven-day npm age hold,
enable automatic merges or dependency scripts, update installed providers, or
change Cafe profiles. The [maintenance policy](dependency-updates.md) still
applies, including separate default-branch security-alert triage.

Status: local implementation, supply-chain audit and complete macOS verification
passed. Publication and remote platform results are recorded in the follow-up on
[dashboard #113](https://github.com/cafeai/cafe-code/issues/113). Local success is
not a claim that foreign-platform or published-artifact qualification has passed.

## Selected noncompiler migrations

| Area              | Selected version                                                           | Compatibility boundary                                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Babel             | Core and matching family 8.0.6, with upstream-selected 8.0.0/8.0.5 helpers | Keep the existing React compiler; enable JSX parsing only for JSX/TSX files, preserving generic arrows in plain TypeScript files.                                                                                       |
| Test runner       | Vitest and browser integration 5.0.2                                       | Explicitly preserve mock-history and locator-matching policies. The pinned Effect test adapter needs its separately reviewed cancellation/finalizer compatibility patch; do not advance the application Effect runtime. |
| TOML              | 5.0.0 in server and staged desktop manifests                               | Validate full signed-int64 user values with bigint parsing, retain the nesting bound, and preserve unrelated document bytes during Cafe block edits.                                                                    |
| Icons             | Lucide React 1.48.0                                                        | Keep existing application imports and qualify rendered controls through the browser suite.                                                                                                                              |
| Node declarations | `@types/node` 26.6.3                                                       | This is a type-only change, not a Node runtime update or permission to call APIs unavailable in Node 24.13.1.                                                                                                           |

The local verification results for these adaptations are recorded below.
Source and staged TOML pins move together.
Provider SDKs, packaging/PTY, Playwright, Node 24.13.1, Yarn 4.17.1 and
the existing Effect RPC patch remain on their established protected paths.
Electron receives a separately audited same-major security correction described
below; this is not an unrestricted native-runtime refresh.

### Test-adapter and browser compatibility

The beta.59 Effect adapter does not wait for scoped finalizers after Vitest 5
aborts a timed-out case. An isolated delayed-finalizer fixture reproduces the
next case starting before retirement. `.yarn/patches/effect-vitest.patch`
backports the cancellation-only wait from the official
[rc.113 source](https://github.com/Effect-TS/effect/blob/d3b837aee836f35d625d55205f7d6e61305fc198/packages/vitest/src/internal/internal.ts).
Normal completion and failure propagation remain unchanged; the abort listener
is removed when the Effect promise settles. The fixture must still report the
intended timeout as a failure and only then pass the next case after retirement.
This does not upgrade the application Effect runtime or its RPC patch.

The patched manifest admits exactly the qualified Vitest 5.0.2 version. Yarn
resolves peer metadata before fetching local patches, so it still emits
`YN0060` for the original adapter's Vitest 3/4 range. A package extension cannot
override that existing peer. Do not hide all peer warnings or loosen unrelated
ranges: policy tests check the exact runner, browser provider, local resolution
and installed adapter. The public adapter APIs and actual timeout/finalizer
behavior are tested separately.

Every Node workspace selects its shared or local config explicitly, because
Vitest 5 removed parent-config discovery; each consumer supplies Vite's now-required
peer. Preserve prior mock call-history and partial accessible-name matching
explicitly. Assertions intending partial text use `toMatchTextContent`, retaining
their old semantics; exact assertions remain exact. Hover-only controls are
tested by hovering their actual parent row first, not by forced clicks.
Browser dependency caches live beneath `node_modules` so application Babel
transforms cannot reprocess generated dependency bundles. React entrypoints are
prebundled before tests to avoid mid-test iframe reloads.

The shared production Babel parser configuration is exercised with plain-TS
generic arrows and actual React compiler output for typed JSX. Node 26's wider
socket-data overload requires an explicit Buffer annotation on the existing
binary IPC path, with fragmented UTF-8 frame coverage. No `setEncoding` call or
new Node-26-only runtime API is introduced. Lucide 1 retains the current imports;
its decorative `aria-hidden` defaults are qualified through actual accessible
control queries rather than introducing a new UI design.

## Immutable GitHub Actions

All 34 existing Action references move to the following official release commits.
The major aliases and exact release tags were resolved through GitHub's API and
the corresponding commits reported valid GitHub signature verification. Human
comments retain the exact reviewed release; workflow execution uses the SHA.

| Action            | Reviewed release                                                           | Immutable commit                           |
| ----------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| checkout          | [v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1)          | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| cache             | [v6.1.0](https://github.com/actions/cache/releases/tag/v6.1.0)             | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` |
| download-artifact | [v8.0.1](https://github.com/actions/download-artifact/releases/tag/v8.0.1) | `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` |
| github-script     | [v9.0.0](https://github.com/actions/github-script/releases/tag/v9.0.0)     | `3a2844b7e9c422d3c10d287c895573f7108da1b3` |
| setup-node        | [v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0)        | `820762786026740c76f36085b0efc47a31fe5020` |
| upload-artifact   | [v7.0.1](https://github.com/actions/upload-artifact/releases/tag/v7.0.1)   | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |

All six Actions declare their own `node24` execution runtime. They do not require
changing Cafe's project runtime to Node 26. Existing workflow triggers, token
permissions, concurrency, release artifact names and paths remain unchanged.

Checkout 7 adds protection against unsafe fork checkouts in privileged event
contexts. PR sizing still checks out the trusted base repository with no custom
repository/ref and fetches PR commits only as passive Git data. Do not enable
`allow-unsafe-pr-checkout`, install dependencies or execute fork code in that
`pull_request_target` job. The existing inline GitHub scripts use supported
`github.rest`, `context`, `core` and `require("node:child_process")` interfaces;
they do not require the now-ESM `@actions/github` package or shadow the injected
`getOctokit` name.

Upload 7 retains ZIP archives by default; no `archive: false` migration is made.
Download 8 now fails on artifact digest mismatch by default. Preserve that
stronger integrity failure instead of downgrading it to a warning. Same-run
artifact transfer needs no additional repository token permissions. Cache 6.1
retains safe skipped-save behavior for read-only tokens. Setup-node's auth-token
and caching changes do not require an auth or package-manager change here.

## Ubuntu 26.04 and the published artifact ABI

GitHub announced [Ubuntu 26.04 general availability](https://github.com/actions/runner-images/issues/14747)
on September 17. The audited
[runner image inventory](https://github.com/actions/runner-images/blob/6d942e630479cd99a93dadfc766af11242bfa402/images/ubuntu/Ubuntu2604-Readme.md)
and official Ubuntu Resolute main/universe package indices contain all 29 existing
Linux build/runtime prerequisite package names. The additional fixture packages
`sway`, `xwayland` and `dbus-daemon` are also available. Locked Playwright 1.61.1
[recognizes Ubuntu 26.04 explicitly](https://github.com/microsoft/playwright/blob/v1.61.1/packages/utils/hostPlatform.ts);
no browser-runtime upgrade is needed for this runner migration.

Quality, administrative, lifecycle, nonpublished artifact and reliability jobs
move to Ubuntu 26.04. The tagged-release Linux artifact producer remains on
Ubuntu 24.04. This is an intentional compatibility boundary, not an unavailable
runner: `scripts/build-virtual-desktop.ts` links the shipped helper against host
Wayland, graphics, GLib/Pango and C/C++ runtime libraries. Ubuntu 26 introduces
newer versions, including glibc 2.43 rather than 2.39. Building there does not
establish that the resulting executable will run on the older supported image.
Changing the published producer requires separate cross-distribution ABI/runtime
evidence. The nonpublished Ubuntu 26 AppImage is qualification output, not the
release baseline.

All five Yarn/Turbo cache keys and the restore prefix now include the runner
image. A Ubuntu 26 build cache must not supply native outputs to the Ubuntu 24
release producer; architecture and lock/task hashes alone do not separate that
ABI boundary. Triggers and permissions are not broadened for this change.

CI's named Ubuntu 26 native qualification step has a five-minute budget. It
executes the actual helper's `--version` path with a ten-second timeout, then
explicitly enables the existing sixty-second
`VirtualDesktopFallback.e2e.test.ts` fixture. The fixture forces a failed first
renderer attempt and checks a private headless pixman worker, PNG capture,
resize, private directory permissions and exact worker-PID exit. It uses no live
provider, credential, user application or hardware GPU. The disposable runner
gets its own missing private `/run/user/<uid>` directory if necessary; existing
paths still face production owner/type/mode admission. This reuses the existing
build and does not add another full artifact build.

Remote execution of that step is still required. Local YAML tests and a macOS
desktop build do not demonstrate Ubuntu 26 helper execution, GPU compatibility,
or Ubuntu 24-to-26 artifact portability.

## npm supply-chain audit

At `2026-10-03T02:28:51.700Z`, the reviewed lock snapshot had SHA-256
`659de79d757e0e73c31ce67f1bb93b0d9ffa5b1d10c66e2f7750bbe26584b0a1`.
This identifies the audit snapshot, not a promised final lockfile hash: the
compiler candidate was subsequently rejected. Compare the final noncompiler
resolution set with this inventory if the lockfile changes again.

A read-only Node audit parsed the baseline and working lockfiles, selected every
new noncompiler npm resolution, fetched registry version/publication metadata,
and downloaded the exact registry tarball. It did not install packages, run
package scripts, extract files onto disk or invoke providers. Results:

- 41 of 41 package versions have publication timestamps at least seven days old.
  The youngest is `@types/node@26.6.3`, published
  `2026-09-25T22:06:16.779Z`, approximately 7.18 days before the audit.
- 41 of 41 downloaded tarballs match their registry `dist.integrity` SHA-512.
- 41 of 41 npm registry signatures verify against the registry's published keys,
  binding the package name, exact version and integrity value. None were absent.
- 28 packages publish build provenance. Their attested subject SHA-512 matches
  the downloaded tarball, their source repository/commit and release workflow
  were inspected, and the DSSE signature verifies with the included certificate's
  public key. Full Sigstore certificate-chain and transparency-log verification
  was **not** performed. The other 13 packages must not be described as having
  verified build provenance.
- All declared Node engine ranges among these versions admit Node 24.13.1.
  Successful integrity checks are not proof of vulnerability absence, source
  correctness or reproducible builds.

Direct-version metadata includes Babel core 8.0.6 published
`2026-09-18T13:48:10.809Z`, Vitest 5.0.2 at
`2026-09-25T09:00:46.560Z`, TOML 5.0.0 at
`2026-07-14T18:39:21.340Z`, and Lucide React 1.48.0 at
`2026-09-24T05:53:14.788Z`. Registry evidence is available from the exact
[Babel](https://registry.npmjs.org/@babel%2fcore/8.0.6),
[Vitest](https://registry.npmjs.org/vitest/5.0.2),
[TOML](https://registry.npmjs.org/toml/5.0.0),
[Lucide](https://registry.npmjs.org/lucide-react/1.48.0) and
[Node declarations](https://registry.npmjs.org/@types%2fnode/26.6.3) records.

The complete new noncompiler resolution inventory is:

```text
@babel/code-frame@8.0.6
@babel/compat-data@8.0.5
@babel/core@8.0.6
@babel/generator@8.0.6
@babel/helper-compilation-targets@8.0.6
@babel/helper-globals@8.0.6
@babel/helper-string-parser@8.0.6
@babel/helper-validator-identifier@8.0.6
@babel/helper-validator-option@8.0.0
@babel/helpers@8.0.5
@babel/parser@8.0.6
@babel/template@8.0.0
@babel/traverse@8.0.6
@babel/types@8.0.6
@blazediff/core@1.10.0
@jridgewell/gen-mapping@0.4.0-beta.0
@jridgewell/sourcemap-codec@1.6.0
@types/gensync@1.0.5
@types/jsesc@2.5.1
@types/node@26.6.3
@vitest/browser-playwright@5.0.2
@vitest/browser@5.0.2
@vitest/mocker@5.0.2
@vitest/pretty-format@5.0.2
@vitest/spy@5.0.2
@vitest/ui@5.0.2
@vitest/utils@5.0.2
es-module-lexer@2.3.2
fflate@0.8.3
flatted@3.4.4
flru@1.0.2
import-meta-resolve@4.2.0
js-tokens@10.0.0
lucide-react@1.48.0
magic-string@1.4.2
tinybench@6.2.0
tinyrainbow@3.1.1
toml@5.0.0
undici-types@8.9.0
vitest@5.0.2
why-is-node-running@3.2.2
```

One transitive prerelease is intentional and visible: Babel generator 8.0.6
requires exactly `@jridgewell/gen-mapping@0.4.0-beta.0`. It was published May 18,
is approximately 137.59 days old, and passed the same integrity/signature checks.
No security resolution or age gate was relaxed to obtain it. Do not claim that
this stable direct-version migration introduces no transitive prereleases.

The initial protected-resolution audit found no provider/native/browser/application
Effect version moves. The only additional protected locator in that snapshot was
the explicit local `@effect/vitest@4.0.0-beta.59` compatibility patch. The subsequent
Electron security correction below intentionally changes that one runtime pin.
The existing Effect RPC
patch is byte-unchanged, and every retained nonworkspace resolution has unchanged
dependency metadata and checksum. These findings do not replace review of the
new test-adapter patch or its cancellation/finalizer regression tests.

### Separate security corrections and remaining advisory

The complete recursive Yarn registry audit initially returned 18 advisory/version
rows across 12 distinct GitHub advisories, plus 28 deprecation notices. Every
flagged version and its parsed lock entry already existed in baseline `0cdd91eb`;
none was introduced by the major migrations. Do not interpret that fact as a
reason to leave reachable vulnerabilities unfixed.

The following bounded, same-major corrections are included:

- `brace-expansion` 1.1.21, 2.1.7 and 5.0.12 retain their existing three transitive
  families while bounding pathological recursive parsing. All were published
  September 14 and passed registry-signature and tarball SHA-512 verification.
- `fast-uri` 3.1.8 fixes decoded host-name case normalization; `ip-address` 10.7.2
  includes family/length security guards and a compatible ARPA-suffix correction.
  Both were published September 15 and passed the same age, engine, signature and
  integrity checks. The existing security resolution floors are strengthened to
  `^3.1.8` and `^10.7.1`, respectively; they are not removed or relaxed.
- Electron 42.10.0 replaces 42.5.1 in desktop, server and staged-runtime manifests.
  It was published August 24. Its npm tarball SHA-512 and both registry signatures
  verify; packaged native checksums agree with official release hashes for macOS
  arm64/x64, Linux x64 and Windows x64. This audit alone did not execute those
  foreign-platform binaries. The Electron ABI remains 146, Chromium advances
  148.0.7778.271 to 148.0.7778.280, and bundled Node advances 24.17.0 to 24.18.1.
  The standalone project Node pin remains 24.13.1.

Official changes: [brace expansion](https://github.com/juliangruber/brace-expansion/compare/v5.0.9...v5.0.12),
[URI parsing](https://github.com/fastify/fast-uri/compare/v3.1.7...v3.1.8),
[IP security guards](https://github.com/beaugunderson/ip-address/compare/v10.7.0...v10.7.1),
[ARPA parsing](https://github.com/beaugunderson/ip-address/compare/v10.7.1...v10.7.2),
and [Electron 42.10.0](https://github.com/electron/electron/releases/tag/v42.10.0).

Electron's [sandboxed-preload cache-poisoning advisory](https://github.com/electron/electron/security/advisories/GHSA-qmv3-fv6v-rmhq)
has no application-side workaround and applies to the sandboxed preloads Cafe
uses if a renderer is compromised. Keep sandboxing, context isolation, popup
denial and narrow IPC admission intact; do not disable them to silence the
advisory. The custom protocol still serves bundled static assets only, and
[`corsEnabled: true` is not a security mitigation](https://github.com/electron/electron/security/advisories/GHSA-j84w-jfhq-vhvj).
The installed runtime needs actual native execution checks and platform CI in
addition to matching package declarations and desktop compilation.

The five library corrections add five verified tarballs and registry signatures
to the original 41-version audit. Only `ip-address` among those five publishes
provenance; its subject digest and included-certificate DSSE signature verify,
binding source commit `974b48d9ade9348accdb377ba0a15feba4a11361`. Full Sigstore
certificate-chain/transparency-log verification is still not claimed.

The remaining `http-cache-semantics` 4.2.0 advisory has no published fixed version.
It is confined to `electron-builder` build tooling through
`app-builder-lib -> @electron/get -> got -> cacheable-request`; it is not in the
staged application's runtime dependencies. Got enables the vulnerable shared
HTTP cache only when its `cache` option is truthy. Cafe has no download/cache
override enabling that option, and the upstream default is disabled. Ordinary
hash-validated archive caching is a separate mechanism and stays enabled.
Do not enable shared authenticated HTTP caching without a new security review,
silently suppress the audit, or claim the upstream vulnerability is fixed.
See the [upstream advisory discussion](https://github.com/kornelski/http-cache-semantics/issues/56).

Policy tests bind all three Electron declarations to the reviewed fixed release
and inspect every resolved brace/URI/IP branch for its fixed security floor.
The explicit `node scripts/qualify-electron-runtime.ts` command launches only
the desktop-resolved installed binary in Node mode, under an isolated temporary
profile and a bounded deadline. It verifies the actual Electron version, bundled
Node floor and ABI. Each native quality host runs it; default tests exercise only
its pure environment/validation helpers. No Cafe window, provider, credentials,
Chromium GUI startup or GPU participates in this check.
Actual registry auditing must still be repeated when dependencies change. These
`dev` corrections do not automatically repair `main` or published releases.

## TypeScript 7: measured deferral

TypeScript 7.0.2 and `@effect/tsgo@0.46.0` were investigated, not adopted. The
native Effect integration produced 1,188 diagnostics with behavior differing
from the existing language service, including diagnostics outside the intended
Effect/security boundaries. No faithful, safe configuration migration was
established. Do not suppress those rules globally, weaken existing diagnostics,
or describe the candidate as a completed upgrade. Retain TypeScript 5.9.3 and
`@effect/language-service` 0.84.2 with the established diagnostic policy.

Candidate supply-chain evidence remains useful but is **unused qualification**:
the TypeScript/Effect wrappers and seven corresponding platform pairs (16 npm
packages) passed the seven-day age, registry-signature and tarball SHA-512 checks.
Effect publishes artifacts for macOS arm64/x64, Linux arm/arm64/x64 and Windows
arm64/x64, not every additional platform supported by TypeScript itself.
Its [source commit](https://github.com/Effect-TS/tsgo/commit/b8e62d76fef3c24dc71e880e7934fe59efa12238)
is GitHub-verified, and the embedded upstream metadata matches official
[TypeScript-Go commit](https://github.com/microsoft/typescript-go/commit/2bd066d87f5bafd315be9f40889d0a60b9e58e0b),
whose Git commit is unsigned. Candidate provenance has the same partial
verification limitation described above. Correct origin and artifact hashes do
not establish diagnostic compatibility.

The nine temporary explicit CI `yarn prepare` calls were removed with this
deferral. Automatic dependency scripts remain disabled. The existing baseline
prepare command and normal CI behavior are not broadened to activate unrelated
latent editor diagnostics as part of this batch.

## Local verification — October 3, 2026

All commands used standalone Node 24.13.1 and repository-pinned Corepack Yarn
4.17.1. The final security-updated tree passed:

| Check                                                               | Result                                                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `corepack yarn install --immutable`                                 | Passed in the checkout and a disposable source snapshot with no existing `node_modules`; the latter completed in 7.57 seconds.                                |
| `corepack yarn audit:repository`                                    | Passed.                                                                                                                                                       |
| `corepack yarn fmt` and `corepack yarn fmt:check`                   | Passed.                                                                                                                                                       |
| `corepack yarn lint`                                                | Passed with existing warning-level diagnostics, not zero-warning qualification.                                                                               |
| `corepack yarn typecheck`                                           | All ten Turbo tasks passed, uncached.                                                                                                                         |
| `corepack yarn test`                                                | All ten Turbo tasks passed, uncached: 514 passing files and 5,471 passing tests, plus one intentional expected-failure case and three skipped cases.          |
| `corepack yarn workspace @cafecode/web test:browser --maxWorkers=2` | All 54 files and 719 browser tests passed on the final security tree.                                                                                         |
| Explicit Effect timeout/finalizer e2e fixture                       | Passed; the nested runner retains its deliberate timeout failure and drains finalizers before its next case.                                                  |
| `node scripts/qualify-electron-runtime.ts`                          | Actual installed macOS arm64 binaries passed in both checkout and fresh snapshot: Electron 42.10.0, bundled Node 24.18.1, native ABI 146.                     |
| `corepack yarn build:desktop --force`                               | All three tasks passed uncached after all tests; 37.26 seconds.                                                                                               |
| `corepack yarn npm audit --all --recursive --json`                  | One unresolved `http-cache-semantics` advisory remains, with the disabled/build-only reachability boundary above. No advisory suppression or all-clear claim. |

Fresh snapshot installation still used the configured global Yarn cache and
trusted native-download cache; it is not a claim of hermetic fresh downloads.
The five workflow files also passed YAML structure checks, unchanged-trigger/
permission/concurrency comparisons, inline GitHub-script compilation, Bash
syntax checks, and default policy regressions. The browser suite includes the
actual existing UI controls, not merely icon-import compilation.

The exact pushed revision and remote Linux/macOS/Windows results belong in the
dashboard follow-up. Remote Ubuntu 26 helper/runtime execution and release
artifact compatibility must not be inferred from the local policy checks or
from a successful macOS build. The published Linux ABI baseline remains Ubuntu
24.04 until separately qualified.
