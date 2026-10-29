# Dependency maintenance with Renovate

Created: 2026-10-03 01:30:40 JST (UTC+0900)
Last updated: 2026-10-23

Cafe is configured to use the Mend-hosted [Renovate GitHub App](https://github.com/apps/renovate)
to propose dependency updates once activated. The checked-in repository policy is
[`.github/renovate.json`](../.github/renovate.json). This is repository maintenance,
not a Cafe runtime feature: it does not update installed Codex/Claude executables,
call providers, read Cafe profiles, or replace provider compatibility/token audits.
The [initial decision](decisions/renovate-dependency-maintenance.md) explains the
trust boundary and why Yarn catalogs require this approach. The
[LTS successor decision](decisions/latest-node-lts-toolchain.md) replaces its
manual-only Node exclusion without changing the other safety boundaries.
The [qualified October provider update](provider-updates-2026-10-22.md) records
the separately coordinated Claude/Codex pins, protocol review and replay limits.

## Activation

The configuration alone does **not** install the App or prove it is running.

1. GitHub's default branch is currently `main`. Put the configuration at the same
   `.github/renovate.json` path on **main**, through a reviewed configuration-only
   PR if necessary. Retain the identical configuration and policy tests on `dev`.
   A configuration committed only to `dev` is not sufficient: hosted Renovate
   reads the default-branch configuration, then `baseBranchPatterns` directs its
   dependency extraction and update PRs to `dev`. `useBaseBranchConfig` is not
   enabled, so a differing `dev` copy cannot silently change the active policy.
2. Install/configure the Mend Renovate App for the `cafeai` account, select
   **Only select repositories**, and select **cafe-code**. Review the requested
   GitHub repository permissions, including read access to Dependabot alerts.
   Do not supply provider tokens, Cafe secrets, a broad personal token, or access
   to unrelated repositories. If the App was selected before config publication,
   review any generated onboarding PR rather than merging its suggested defaults
   over this policy. In the Mend portal, select **cafe-code** and set Dependencies
   → Dependency Updates → Renovate to **Automated PRs** (also called Interactive
   in some portal versions). Enable **Require config file**, if offered, and leave
   onboarding PR creation off once this configuration is on main. Keep the separate
   Remediate automated PR setting **off**. Prefer this repository-only override
   instead of changing defaults for unrelated repositories.
   Silent mode sets global `dryRun=lookup`: it scans without PR or dashboard writes.
   A repository `mode: full` cannot override that global setting. Confirm the first
   processed job has no effective dry-run override, not just an enabled App label.
3. Enable GitHub's dependency graph and **Dependabot alerts**. The graph is enabled
   for this public repository by GitHub. Keep Dependabot's separate version-update
   configuration and automatic security-update PRs disabled to avoid two bots
   competing over the same updates; alerts and PR generation are separate features.
4. Confirm the App's repository logs/onboarding status and its **Dependency
   maintenance** issue on the first processed run. An installation screen, merged
   config, local validator pass, or green Cafe CI alone is not evidence that the
   hosted service has processed the repo. Routine proposals may wait for Monday's
   schedule or the release-age hold even after activation.
   Review the hosted/global/inherited configuration as well: the App can apply
   account-level configuration from `cafeai/renovate-config/org-inherited-config.json`
   and hosted presets even though this file does not explicitly extend a preset.
   Local policy tests and repository-mode schema validation cannot prove that
   external configuration is absent or safe. Verify no effective override enables
   automerge, scripts, vulnerability-fix PRs or excluded package updates.

Official behavior: [hosted onboarding](https://docs.renovatebot.com/getting-started/installing-onboarding/),
[base branches](https://docs.renovatebot.com/configuration-options/#basebranchpatterns),
[configuration sources](https://docs.renovatebot.com/configuration-options/#usebasebranchconfig),
[hosted inherited configuration](https://docs.renovatebot.com/mend-hosted/hosted-apps-config/#inherited-config),
[Full/Silent mode](https://docs.renovatebot.com/configuration-options/#mode),
[Mend repository settings](https://docs.mend.io/integrations/latest/configure-github-cloud-for-sca),
[GitHub alerts](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-dependabot-alerts).

## Update policy

- Routine library/action branches are created on Mondays between midnight and 07:00 Japan time.
  npm releases must have a publication timestamp and settle for seven days first.
  At most three routine branches/PRs and one new PR per hour are admitted.
- Group only related React, Vite, Vitest, Ox, Tailwind, Lexical, TanStack, and DnD
  packages. Different major upgrades remain separate from non-major proposals;
  majors need explicit dashboard approval **before** their branch/PR is created.
  That approval does not merge the PR or waive CI/review.
- GitHub Actions use a separate group and immutable commit pins. The npm
  publication-age rule does not apply to action digest pinning.
- Node runtime proposals can appear at any time and follow the newest officially
  promoted LTS line and its latest release, never Current or prereleases. They
  use the official Node release datasource and Renovate's LTS-aware `node`
  versioning; no frozen major or even-number assumption controls promotion.
  Node declarations use the same LTS-aware versioning and review group, but
  retain the seven-day npm publication-age hold. Majors still require dashboard
  approval and every merge still requires human review and applicable CI.
- Effect and `@effect/*`, provider SDK families, Electron/native/packaging/browser
  runtimes, Yarn and root `resolutions` are disabled in Renovate. They require
  manual coordinated updates and the existing audits in `AGENTS.md`. In particular,
  the Effect patch must be rebased; Claude's complete package set requires age,
  integrity/signature and protocol review; staged native pins must match source.
- Independent lockfile maintenance is disabled. A blanket transitive refresh could
  bypass the manual native/provider boundaries. An ordinary dependency PR may
  still change necessary transitive lock entries: review the **entire** lock diff,
  not just the requested package. Security resolutions must not be removed or
  relaxed as an incidental repair.
- All merges are manual. Bot package scripts are disabled. No regex/custom
  managers, arbitrary post-upgrade commands, credential configuration or automatic
  permission changes are enabled. Yarn catalogs and Corepack are supported by
  Renovate's ordinary npm manager; no second package manager is introduced.

## Node LTS synchronization

The exact standalone Node pin on `dev` is `.node-version`, not a floating `node`,
`latest` or `lts/*` alias. CI reads that file through `node-version-file`; the
native nodenv and mise managers plus npm engine extraction can propose updates.
Mise is enabled only for Node, not arbitrary new toolchains. The Docker image
retains an exact version and immutable digest, and verifies its own Node version
against the pin during its build. Development containers and package engines
must match it too. These guards make a partial pin update fail rather than
silently building different runtimes on different platforms.

Renovate proposes updates; it does **not** finish or auto-merge native toolchain
qualification. Before merging a `Node.js LTS` proposal:

1. Confirm the newest LTS in the [official release index](https://nodejs.org/dist/index.json).
   A higher Current release is ineligible. Keep `.node-version`, `.mise.toml`,
   root/server engine ranges and development-container versions synchronized.
2. Keep the catalog's `@types/node` on that LTS **major**, not necessarily the
   same patch number. Use the latest publication-age-qualified declarations and
   review the corresponding Yarn lock diff; do not enable a second package
   manager or weaken the age gate to obtain a newer declaration patch.
3. Complete the reviewed archive, immutable container and distribution package
   identities in the same PR. Windows-specific archive/cache/launcher requirements
   are defined in the **Windows-Specific Notes** section of `AGENTS.md`.
   The Docker image must preserve its qualified OS variant and have its exact
   registry digest verified. Arch build dependencies must name the selected
   `nodejs-lts-<codename>` package, not generic `nodejs` (which follows Current).
   Reviewed version-keyed archive/distro mappings deliberately require an explicit
   new-major review; never guess hashes or codenames from the version number.
4. Run a locked install and focused toolchain/policy/build tests, all required
   repository checks, applicable native platform smoke, then the forced desktop
   build. The Node-only PR may be completed manually; bot package scripts and
   arbitrary post-upgrade commands stay disabled. Coordinate major proposals
   with the declaration group and keep pending/incomplete updates unmerged.

As of 2026-10-23, the standalone development pin is Node **24.22.1** (Krypton),
the October security release; Node 26 remains Current. Future LTS promotions remain eligible without
editing a fixed major constraint. This is an update policy and review gate, not
a guarantee that every release is installed instantly or that the bot has
processed a hosted job. Both default-branch config and dev changes must be
published; changing only dev's config does not activate the rule.

Electron's embedded Node is not the standalone distribution and cannot be
replaced independently. Keep its reviewed Electron/Node/native-ABI qualification
separate; newer declarations do not authorize APIs unavailable in that embedded
runtime. Provider executables and user-selected system Node installations are
not silently upgraded by this repository policy.

Official references: [Node LTS-aware versioning](https://docs.renovatebot.com/modules/versioning/node/),
[supported Node pin files](https://docs.renovatebot.com/node/),
[Node declaration workaround](https://docs.renovatebot.com/presets-workarounds/#workaroundstypesnodeversioning).

## Node2Shell review and standalone remediation

The 2026-10-23 source review identifies **CVE-2026-111497** (Node2Shell), the
native Brotli decoder memory-corruption issue described in the
[Node security advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
and [upstream Brotli fix](https://github.com/google/brotli/commit/0ed4268a4401abcb44720963).
Node **24.22.1** is the fixed release on the current LTS line. Synchronize the
canonical pin, mise, package engines, development container, managed-provider
manifest and Arch minimum; use the reviewed Windows archive hashes from its
[official checksums](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt). The clean-room
image retains Bookworm and its registry-verified immutable multi-platform digest.
Node's backport still reports Brotli 1.2.0; that string alone cannot distinguish
fixed from vulnerable runtimes. The existing toolchain suite also checks the
fixed standalone runtime's new block-switch error constant without decoding
malformed input.

The relevant Cafe boundaries are:

- `apps/server/src/provider/opencodeRuntime.ts` accepts an explicitly configured
  external OpenCode server and creates the SDK client. Both provider inventory
  discovery in `provider/Layers/OpenCodeProvider.ts` and ordinary session opening
  in `provider/Layers/OpenCodeAdapter.ts` use that client. Its Node `fetch`
  transport automatically decompresses Brotli responses before SDK JSON validation.
  A malicious or compromised configured server can supply those bytes; cleartext
  HTTP additionally permits an attacker on that connection to replace them.
  The default empty server URL instead starts a local provider process.
- The backend's `FetchHttpClient.layer` in `apps/server/src/server.ts` uses the
  same Node response decoder. Relevant consumers include Bitbucket API calls
  (an optional configured base URL), provider quota endpoints, provider update
  registry checks and dictation HTTP calls. Most destinations are fixed trusted
  HTTPS origins, so this is a conditional response-control boundary, not proof
  that arbitrary unauthenticated Cafe clients can select a destination.
- `packages/shared/src/applicationBuildVersion.ts` validates local compressed
  build sidecars, and `apps/web/scripts/static-compression-cache.mjs` validates
  private cached compression input. Both call the native Brotli decoder. An
  attacker would need to supply an admitted local build/cache input. Output
  limits and post-decode content checks remain required but do not repair a
  memory-safety flaw inside the decoder.
- The primary Node HTTP server and bounded readers in
  `apps/server/src/httpBody.ts` consume raw request bytes. The HTTPS sibling
  pipes those bytes without decoding, and MCP receives bounded request bytes.
  This review found no automatic incoming Brotli-body decompressor on these
  paths. WebSocket per-message compression is DEFLATE. Serving precompressed
  `.br` assets sends existing bytes and does not invoke Node's Brotli decoder.

**The October 23 standalone update left desktop unresolved.** Its repository-installed
Electron 42.11.15 runtime reports Node 24.19.0 and uses that runtime for the backend
and provider daemon in `ELECTRON_RUN_AS_NODE` mode. The published stable releases
checked on 2026-10-23 are
[42.11.18](https://github.com/electron/electron/releases/tag/v42.11.18),
[43.8.3](https://github.com/electron/electron/releases/tag/v43.8.3),
[44.9.3](https://github.com/electron/electron/releases/tag/v44.9.3) and
[45.0.0](https://github.com/electron/electron/releases/tag/v45.0.0).
Their official release metadata still names affected Node 24.19.0/24.22.0, and
the reviewed tagged Node patch lists contain no Brotli fix backport. A newer
Electron label alone therefore cannot close this issue. Keep the existing
Electron pins until a fixed release can be independently reviewed and qualified;
the existing Electron version/ABI qualification is not a Node2Shell security
clearance. This update does not replace an installed app or its existing processes.

This is a source and runtime-metadata review, not a memory-corruption or RCE
reproduction. No exploit or malformed Brotli fixture is part of this change.
Repository checks, native-host qualification and any later desktop release must
be recorded as separate observed results.

## October 29 security maintenance

Review updated: 2026-10-29 14:54:26 JST (UTC+0900).

The reviewed security update pins Electron **43.8.4**, a supported release whose
tagged source embeds Node **24.22.1**, Undici **7.30.1**, Chromium
**150.0.7871.250** and native addon ABI **148**. This addresses the earlier desktop
Brotli gap and includes Electron's certificate-distrust mitigation. The actual
installed-runtime qualifier checks that tuple and the fixed Brotli block-switch
constant in an isolated Node-mode child. A version string or marker alone is not
a proof of every native byte; archive integrity, runtime observation and native
packaging checks remain separate gates. See the
[Electron release](https://github.com/electron/electron/releases/tag/v43.8.4) and
[Node security advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).

Electron 43's retained native preview path uses an explicit offscreen raster
scale of one; ordinary viewers continue to use the native display scale. Both
paths retain the original display admission, display/zoom/bounds drift checks
and bounded actual-raster validation before encoding a semantic-size PNG.
This handles the new offscreen view-scale capture API without treating a valid
1x preview as a display-DPR-sized image. It does not promise pixel-identical
antialiasing between Electron releases.

The package fixes below apply throughout the resolved dependency graph. Existing
security resolutions remain in place; these reviewed exact resolutions prevent
an unchanged transitive consumer range from keeping a vulnerable second copy.
The complete lockfile, including body-parser's required content-type 2.1.0
dependency, is reviewed rather than refreshed indiscriminately.

| Package           | Reviewed fixed version | Security boundary                                                 |
| ----------------- | ---------------------- | ----------------------------------------------------------------- |
| hono              | 4.13.11                | Static-prefix middleware bypass                                   |
| @hono/node-server | 2.1.3                  | Independent copy of the static-prefix bypass                      |
| dompurify         | 3.4.17                 | Conditional template/hook sanitization and XML attribute guards   |
| body-parser       | 2.4.0                  | Compressed-body trailing-byte denial of service                   |
| fast-uri          | 3.1.9                  | URI scheme, host and relative-path interpretation                 |
| ip-address        | 10.7.4                 | IPv6 zone parsing resource bounds                                 |
| qs                | 6.16.1                 | Comma-array stringification failure                               |
| seroval           | 1.6.11                 | Serialization injection and deserializer resource/callable guards |
| toml              | 5.0.1                  | Scalar, table and dotted-key parsing resource bounds              |
| undici            | 8.12.2                 | TLS, redirect/cache and response-processing fixes                 |
| zod               | 4.6.6                  | Constrained-collection validation resource bounds                 |

The [Hono](https://github.com/honojs/hono/security/advisories/GHSA-5r4p-p66f-jhc7)
and [Node adapter](https://github.com/honojs/node-server/security/advisories/GHSA-rmxm-3fg6-px4f)
issues can bypass middleware on a prefix within the configured static root;
they are not outside-root traversal. Cafe's own static/MCP routing uses Effect
and the SDK's WebStandard transport, rather than those static helpers. The
dependency regressions still exercise both real helpers with the upstream path,
protected/public controls and the SDK's no-global-override behavior.

Installed affected versions do not establish every advisory's exploitability.
For example, Cafe's bounded SVG sanitizer does not enable DOMPurify's reported
template/DOM-return/hook modes and independently excludes active SVG elements.
Its existing native security tests remain required. Updating npm Undici does
not update Node's or Electron's separate embedded HTTP implementation: their
reviewed Node 24.22.1 source instead contains fixed Undici 7.30.1.

No fixed TOML 4.x release is available, so the security resolution also moves
Effect's CLI parser from 4.x to 5.0.1. Regression tests exercise safe numbers,
dates, tables and arrays through both actual consumers and Effect's public file parser. One
intentional compatibility change remains: default parsing rejects integers
outside JavaScript's safe-integer range rather than silently rounding them.
Cafe's own legacy MCP configuration retains its explicit `bigint: true` and
`maxDepth: 80` options and preserves full signed 64-bit integers. This is not a
claim of complete 4.x/5.x behavioral equivalence.

This manual security response follows the exception to the routine seven-day
settling window; it retains archive identity, registry-signature, compatibility
and native checks. It does not waive provider-family quarantine. Standalone
Node 24.22.1 already contains the reviewed October security fixes; Node 26's new
LTS promotion requires a separate coordinated toolchain qualification rather
than a security-only version relabel. A dev push updates source only: main,
release artifacts, installed applications and running processes remain separate.

## Security fixes and main/dev coverage

GitHub alerts describe the **default branch**, not a complete audit of every
branch. Keep alert notifications enabled and triage security reports immediately;
do not wait for the weekly routine-update window or seven-day settling period.

Renovate's automatic vulnerability-fix PRs are deliberately **disabled**. Its
vulnerability worker appends a forced override after ordinary package rules;
`vulnerabilityAlerts.enabled: true` can re-enable dependencies that were explicitly
disabled for compatibility/supply-chain review. Relying on the regular exclusions
would therefore create a false safety boundary. Security fixes use the manual
reviewed path from GitHub's Dependabot alerts instead, for both ordinary libraries
and protected providers/native/toolchains. Neither update bot generates separate
security-fix PRs in this initial setup.

A maintainer may propose a promptly reviewed security fix without waiting for the
routine release-age hold, but must still perform the applicable integrity,
compatibility and platform audit; a report is not permission to waive those checks.
The Renovate dashboard can omit disabled packages; an empty dashboard or no PRs
is **not** an all-clear.

After fixing an alert on `dev`, separately confirm whether the affected dependency
is present on `main` and release branches. Carry the reviewed fix through the
release process (or a separately reviewed narrow backport); a dev-only PR does
not fix a vulnerable main branch. This initial setup does not enable routine main
updates or change the repository's default branch. Maintain full-branch dependency
audits in addition to GitHub's alert coverage; Yarn-catalog support in Renovate does
not establish that GitHub's dependency graph sees every catalog dependency.

See [Renovate vulnerability handling](https://docs.renovatebot.com/configuration-options/#vulnerabilityalerts)
and its [vulnerability worker](https://github.com/renovatebot/renovate/blob/d88779123f01f42b8138ac1cd61b2ac5b9c238e4/lib/workers/repository/init/vulnerability.ts#L136-L166).

## Verification and merge discipline

The policy regression tests run in the existing default `@cafecode/scripts` suite.
Run the focused test from the repository root with the workspace-relative path:

```sh
corepack yarn workspace @cafecode/scripts test renovate-policy.test.ts
```

For changes to the configuration, also run Renovate's official validator in
**repository** mode (`--no-global`). The pinned validation tool is disposable and
not an application dependency. Preserve the existing package-age gate and keep
third-party installation scripts off:

```sh
YARN_ENABLE_SCRIPTS=false corepack yarn dlx --package renovate@44.115.10 renovate-config-validator --strict --no-global .github/renovate.json
```

The environment-variable prefix is a POSIX shell example; use the equivalent
environment assignment in your shell. Do not change the repository package
manager, relax the age gate, or add Renovate to runtime dependencies to run this
check. Hosted Renovate has its own managed version; local validation does not pin
that service or its transitive dependencies.

With installation scripts disabled, the validator can report that the optional
native RE2 addon is unavailable and fall back to JavaScript regular expressions.
This policy has no regex selectors/custom managers. A successful strict schema
check does not claim native-regex qualification or a completed hosted run.

For each dependency PR, require a reviewed manifest/lock diff, immutable Yarn
installation, repository audit, format/lint/typecheck/default tests, applicable
browser/native artifact checks on Linux/macOS/Windows and the final forced desktop
build. Existing policy tests guard synchronized Claude/Electron pins and the
toolchain. Never repair bot failures by bypassing security resolutions, package
quarantines, integrity checks, platform isolation or tests.

Protect `dev` with required review and current CI checks before considering future
automatic merging. This setup deliberately leaves automerge off and does not
silently change branch protections or rulesets. A bot configuration cannot prevent
a repository administrator from manually bypassing failed checks.

## Manually reviewed batches and dashboard refresh

A dashboard entry is a proposal, not evidence that an upgrade is compatible. A
maintainer can update an audited subset directly on `dev`, preserving the same
age, integrity, test and review requirements. Check actual locked versions as
well as manifest ranges: some proposals only bring an old minimum up to a version
already installed. Record concrete reasons for deferred proposals rather than
checking every approval or schedule-override box. See the
[October 3 reviewed batch](dependency-updates-2026-10-03.md) for an example.
The separately authorized [major migration follow-up](dependency-majors-2026-10-03.md)
records coordinated compatibility fixes and measured deferrals; historical holds
in the earlier batch are not claims that those later migrations remain impossible.
The [October 20 security batch](dependency-security-2026-10-20.md) records the
separately reviewed Vite 8.3.3, matched Vitest 5.0.5 and Electron 42.11.15 updates,
their actual/conditional exposure and required resulting-source qualification.
Its status distinguishes prepared pins from observed installation, tests and
publication; routine dashboard proposals do not establish those security floors.

After the reviewed commit is pushed, use the dashboard's **run Renovate again**
checkbox at the bottom (the `manual job` control). This requests another hosted
scan; it does not approve all upgrades or bypass their schedule. When updating it
through the API, first fetch the current issue body, change only that checkbox,
and preserve the bot's remaining content. Do not manually remove completed rows
or select the approve-all, unpend-all or unschedule-all controls. A short comment
can explain the commit, checks and deferrals, but a comment alone is not a rerun.

Distinguish a submitted rerun request from a completed scan. Confirm the bot's
subsequent dashboard update or the Mend job result; proposals still waiting for
their schedule or release-age hold are expected. The bot remains responsible for
reconciling the dashboard against the new `dev` lockfile.

Official references: [Dependency Dashboard](https://docs.renovatebot.com/key-concepts/dashboard/)
and [Mend job processing](https://docs.mend.io/wsk/renovate-ee-job-processing-in-renovate).

## LegendList review-anchor compatibility patch

The web workspace pins `@legendapp/list` 3.0.0-beta.44 through a checked-in Yarn
patch. It changes only the ESM and CommonJS `@legendapp/list/react` entrypoints
used by Cafe; React Native and the package's other entrypoints are not qualified
or changed. There is no package version upgrade or new public API.

In the upstream visible-range pass, maintain-visible-content-position can
synchronously move logical/native scroll after row positions are rebuilt. The
pass must select visible keys using that adjusted viewport, not the earlier
scroll bounds. Otherwise it can unmount the retained review anchor and measure
unrelated rows, allowing later size adjustments to preserve a different key.
The patch rebases only this pass's synchronous scroll delta, retaining captured
initial-scroll/pending-padding semantics, existing clamps, sticky-header updates,
draw distance and anchor-lock budgets. It does not add polling or Cafe-side
compensating scroll loops.

The real-list browser regression in `MessagesTimelineRealList.browser.tsx`
retains an exact visible anchor while a bounded 1,000-artifact history window
slides. Keep its native scrolling, identity, offset and mounted-row/resource
assertions when rebasing or removing this patch. Qualify the actual bundled
entrypoint with the complete applicable browser suite and the forced desktop
build; a copied arithmetic model or a patch-text assertion is not that evidence.
Any upstream replacement must demonstrate the same functional behavior before
removing the patch and refreshing the reviewed lockfile.

## Rollback

Suspend the App's access to **cafe-code** or set top-level `enabled: false` in the
default-branch configuration through review, and close unwanted bot PRs separately.
Stopping Renovate does not revert merged dependency upgrades and must not disable
GitHub's vulnerability alerts. Keep the `main` and `dev` config copies synchronized.
No Cafe user profiles, provider binaries or credentials need modification.
