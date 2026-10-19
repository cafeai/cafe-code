# Development-server and Electron security updates

Created: 2026-10-20 05:31:30 JST (UTC+0900)
Last updated: 2026-10-20 05:41:00 JST (UTC+0900)

Status: Reviewed update scope and replay requirements. The exact resulting-source
verification and publication receipts are recorded separately; this document
alone is not evidence of CI success or adoption by an already running app.

## Reviewed scope

This manually reviewed security batch updates three coordinated dependency
groups. It does not approve every proposal in the dependency dashboard.

| Dependency group                                     | Previous pin | Reviewed target |
| ---------------------------------------------------- | ------------ | --------------- |
| Vite                                                 | 8.3.1        | 8.3.3           |
| Vitest runner, browser/provider and related packages | 5.0.2        | 5.0.5           |
| Electron source and staged desktop runtime           | 42.10.0      | 42.11.15        |

The older dashboard proposal for Vitest 5.0.3 does not include the subsequently
published Browser Mode fix. Keep the complete Vitest package family and Vite
peer aligned, including the narrowly patched Effect test adapter's peer
declaration. Its scoped cancellation/finalizer implementation is not replaced
by this dependency update.

Standalone Node 24.21.0 and Yarn 4.17.1 remain separate, unchanged toolchain pins.
This batch does not upgrade Effect, provider SDKs, KaTeX, PDF.js, Lexical,
LegendList, MSW or TypeScript, discard the reviewed LegendList patch, or perform
independent lockfile maintenance. Historical reports and ADRs retain their
original version evidence.

Vitest's new declared minimums also require Chai 6.3.0, magic-string 1.4.3,
std-env 4.3.0, tinybench 6.2.2, tinyrainbow 3.2.0 and obug 3.0.0. Its upstream
exact `why-is-node-running` declaration selects 3.2.1 instead of the previous
range's 3.2.2. Vite's new Rolldown minimum is satisfied by the existing reviewed
1.2.11; an exact resolution retains that compiler and its native bindings rather
than introducing an unnecessary second native compiler update.

The complete lock comparison contains 17 added and 16 removed npm locators;
all other retained non-workspace payloads are unchanged. Public npm registry
ECDSA signatures and downloaded archive SHA-512/SHA-1 integrity were verified
for all 17 additions, with engines admitting the pinned Node 24.21.0. The eight
matched Vitest packages and Electron are less than seven days old: this is the
documented manual security exception, not a successful routine age gate. Registry
keys were obtained over npm HTTPS; advertised provenance was recorded but its
DSSE/certificate/transparency chain was not verified. Package verification alone
does not prove benign code or the identity of Electron's separately downloaded
native runtime, which requires the installed-runtime check below.

## Security rationale and actual reachability

### Vitest Browser Mode

[GHSA-p458-7748-mcp3](https://github.com/vitest-dev/vitest/security/advisories/GHSA-p458-7748-mcp3)
affects the 5.0.0-beta.6 through pre-5.0.5 browser/UI family. Browser project
servers could replace Vite's ordinary denied-file patterns rather than extend
them; a separate root-server initialization problem affected the secret-token
deny rule. The advisory describes file disclosure and, under additional API and
token conditions, write or execution risks. Plain Node tests without an HTTP
server are not that entry point.

Cafe's `apps/web/vitest.browser.config.ts` actually uses browser projects and
the test API, so this is not merely an unused transitive package. The default
localhost host reduces direct network exposure but is not a complete defense
against the advisory's malicious-web-page scenario. This review does not claim
that Cafe enables every optional API capability or that an attack occurred.
Upgrade the matched family to 5.0.5, not only the top-level runner. This is a
development/test-server issue, not proof that an installed packaged renderer
ships the vulnerable server.

### Vite development servers

Vite 8.3.3 fixes the following applicable-version advisories:

- [GHSA-rq7h-c2jc-7f22](https://github.com/vitejs/vite/security/advisories/GHSA-rq7h-c2jc-7f22):
  on non-Windows hosts, a project import whose root-relative path collides with
  a readable absolute host path could incorrectly mark that host file as safe.
  Exploitation requires the described collision and access to the dev server;
  this review has not demonstrated a collision in Cafe.
- [GHSA-vfpm-58rq-9qcg](https://github.com/vitejs/vite/security/advisories/GHSA-vfpm-58rq-9qcg):
  the Wasm-instance request path could bypass file restrictions and disclose
  the first four bytes of a file through Node's Wasm parsing error. Cafe's
  development/test servers run in Node, but no private file was read to test
  this report.
- [GHSA-9jrq-w75r-8gcw](https://github.com/vitejs/vite/security/advisories/GHSA-9jrq-w75r-8gcw):
  a custom middleware path that passes an unchanged request URL into
  `transformIndexHtml` could permit injected HTML. No corresponding Cafe
  middleware call was found in this source review; ordinary SPA/MPA handling
  is not the advisory's affected custom path.

`apps/web/vite.config.ts` defaults to localhost but permits an explicit host.
Keep existing host, filesystem and native browser-context restrictions; an
update is not permission to expose a development server or relax those rules.
These findings concern dev-server request handling, not a demonstrated exploit
of an installed Cafe artifact.

### Electron native rendering

[GHSA-h3v5-h239-pg29](https://github.com/electron/electron/security/advisories/GHSA-h3v5-h239-pg29)
affects macOS offscreen rendering before Electron 42.11.6. The main process
could trust invalid frame geometry supplied by an already compromised GPU
process, causing memory disclosure or a crash. Retained native-visualization
preview/qualification source uses offscreen rendering, but those retired native
fixtures are not the current production chart path: ordinary charts use browser
frames. The advisory requires separate GPU-process compromise; this review does
not claim that occurred, that the retired fixture proves current production
reachability, or that arbitrary chart input alone is sufficient.

The selected same-major
[42.11.15 release](https://github.com/electron/electron/releases/tag/v42.11.15)
also contains Chromium/V8 security backports and fixes involving Linux startup,
macOS background clicks, network-service recovery and utility-process delivery.
Keep `apps/desktop/package.json`, `apps/server/package.json` and
`packaging/desktop-runtime/package.json` exactly synchronized. Source-pin
changes alone do not replace an installed app's runtime.

## Runtime and native-fixture boundary

The tagged Electron
[`DEPS`](https://github.com/electron/electron/blob/v42.11.15/DEPS) specifies Node
24.19.0 and Chromium 148.0.7778.280; its
[`build/args/all.gn`](https://github.com/electron/electron/blob/v42.11.15/build/args/all.gn)
sets the embedded Node module ABI to 146. Electron's ABI is not the standalone
Node ABI. `scripts/qualify-electron-runtime.ts` admits the exact reviewed
Electron version, Node 24.19.0 or newer in the same Node major, and ABI 146.
Its installed-runtime probe must observe those values; upstream source is not
substitute execution evidence.

The source review also rechecked the tagged `capturePage` bitmap-scale contract
and renderer-retirement implementation used by the isolated visualization
fixtures. Only source links, version assumptions and exact native report
expectations change. The private temporary HOME/session, copied synthetic chart
sources, bounded output, original child/enclosing deadlines and owned cleanup
remain unchanged. No live Cafe window, provider, credential or user profile is
needed for those explicit native fixtures.

The comprehensive visualization fixture also contains decorative GPU/pixel
stress. It remains an explicit optional qualification, not a newly required
default test or a reason to restore superseded cosmetic matrices. Follow
[test-suite policy](test-suite-policy.md) when selecting native checks. Local
macOS fixtures do not establish native Windows/Linux, artifact sandbox,
safe-storage, signing or notarization success.

## Required resulting-source verification

Before treating this batch as complete:

1. Review registry provenance, package age, integrity/signatures and the entire
   manifest/lock diff, then perform the pinned immutable Yarn installation.
   The documented prompt security-review exception to the routine seven-day
   proposal hold does not waive supply-chain or compatibility checks.
2. Exercise actual isolated Vite/Vitest file-access refusal with allowed positive
   controls, the Effect adapter's real timeout/finalizer fixture, synchronized
   dependency policy and the installed Electron runtime probe. Use synthetic
   temporary files and native test-owned processes, not private application data.
3. Pass formatting, lint, repository audits, typechecking, default tests,
   applicable native browser groups and copied bridges with existing isolation,
   permissions, worker/resource limits and deadlines. Qualify corresponding
   foreign-host behavior through the ordinary CI path, without claiming it from
   a local test.
4. Run the forced desktop build last on the unchanged verified source. Record
   observed gates separately from unrun checks before any authorized dev push.

No automatic package-script expansion, sandbox bypass, provider/runtime
maintenance, app restart, release publication or dashboard mutation is included.
Empty registry/Dependabot results are not a broad security all-clear, and a dev
fix does not update `main`, release branches or existing installed apps.

See [dependency maintenance](dependency-updates.md) for the manual security path
and branch coverage, and the [historical major migration report](dependency-majors-2026-10-03.md)
for compatibility boundaries that this narrow batch does not supersede.
