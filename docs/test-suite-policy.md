# Test suite policy

Last updated: 2026-10-24 09:57:52 JST (UTC+0900)

Required CI protects features: correct actions and values, retained user input,
authorization, account/chat ownership, persistence, cancellation, history and
exactly-once delivery. An assertion should explain a user-visible failure or a
consequential invariant. A harmless design or implementation refactor should
not require updating unrelated tests.

## Required and optional coverage

- `yarn test` runs unit/contract tests and isolated integration tests through Turbo.
- Web `test:browser` runs browser feature projects. Linux retains broad shared
  renderer coverage; macOS/Windows retain the focused native-host journeys.
- Ordinary-motion fluid coverage is a small bounded lifecycle smoke. Reduced
  motion and touch keep separate provider-owned contexts. Runner invocations
  close before the next media group starts; workers and deadlines are unchanged.
- `yarn workspace @cafecode/web test:browser:stress` explicitly runs native
  decorative GPU/pixel stress experiments in a fresh ordinary-motion context.
- `yarn workspace @cafecode/web test:soak` explicitly runs pinned Effect internal
  registry instrumentation and long request/reconnect loops.
- The optional `test-stress.yml` workflow runs stress/soak qualification on its
  schedule or by manual dispatch. It is not a dependency of PR/release quality.
- Real provider, native desktop, credential/profile and process-handoff checks
  remain explicit E2E/native qualification. Renderer tests do not prove native
  Windows/AppKit, signing, sandbox or safe-storage behavior.

Use the pinned Node and Corepack Yarn. Agent-initiated CPU-heavy checks on
macOS/Linux start with `nice -n 10`. Finish source verification with the forced
desktop build. Do not restart or push without the existing explicit authorization.

## Efficient execution and timing

For the complete local graph on any development host, use `corepack yarn
verify:local` (at low scheduling priority on macOS/Linux). It retains all
required local checks and a fresh forced final build, without hosted runners.
Its explicitly requested exact-input local success reuse follows the separate
[receipt policy](decisions/verified-local-result-cache.md); `--fresh` bypasses
receipt reads and writes. Canonical CI/release still executes uncached.
`test:browser:local` discovers the complete browser domain with
disjoint native groups and prepares only its real copied MCP bridge artifacts.
Default local Node tests execute the exact unchanged host-specific canonical
CI plan freshly, including its hardware-scaled native defaults. Do not guess
an implicit Turbo limit or replace that complete graph with a server-only
receipt. Explicit `--test-concurrency=1|2|3` selects the separate bounded local
mode with at most two Vitest workers per workspace and eligible per-workspace
reuse; that deliberate override is not CI scheduling parity. Type/browser
exact-input reuse remains available. Monitor host headroom: niceness and a
per-process heap ceiling do not bound aggregate memory. Server file execution,
fork isolation, native browser ordering and build limits remain unchanged.
Typechecking has a separate bounded local option. See the
[default scheduling decision](decisions/ci-matched-local-node-scheduling.md).
Typechecking defaults to three workspace compilers, as does the canonical CI
command; its per-compiler heap ceiling is not an aggregate memory guarantee.
See [local verification](test-performance.md) for commands, input-cache bounds
and timing interpretation. Existing CI commands below retain their native-host
selection and preparation; local qualification is not release delivery.

CI runs the native Node and browser matrices independently. The existing
`Quality` matrix waits for both before the final forced desktop build; native
artifact jobs still depend on that gate. Worker, heap and timeout limits remain
bounded independently in each runner.
The required `Quality` check explicitly fails when either prerequisite fails;
it must not disappear as a skipped dependent job. See GitHub's
[required-check dependency behavior](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#handling-skipped-but-required-checks).

Use the same entrypoints locally with the pinned standalone Node on PATH:

```sh
nice -n 10 corepack yarn test:ci:node
nice -n 10 corepack yarn test:browser:ci
nice -n 10 corepack yarn build:desktop --force
```

Windows uses the same Corepack commands without `nice`. The Node plan preserves
the complete Turbo graph and Windows' two-workspace/two-worker cap. The browser
plan selects Linux's complete suite or the macOS/Windows native subset from
`apps/web/browser-test-policy.json`. It builds the desktop fixture artifacts,
then closes each desktop/touch, ordinary-motion, reduced-motion, Mermaid and
export invocation before opening the next. The isolated MCP bridge and inline
visualization qualification retain their ordering. Install Chromium first with
the web workspace's `test:browser:install` command if it is absent locally.

Both runners write timing-only JSON to `.logs/test-timings/` and print the
slowest files. CI retains that exact directory on success or failure. Reports
contain relative source labels, durations and states, never received errors,
assertion values, environment or arbitrary test metadata. Vitest 5.0.2's browser
`prepareDuration` includes reused page uptime and must not be used for phase
attribution. Wall-clock, collection and individual test durations remain useful.

Feature SQL fixtures use `SqlitePersistenceTest`: build an immutable bounded
binary seed from the current real migrations once per isolated module, then
deserialize a separately writable scoped in-memory database for every runtime,
before any statements/client caches exist. Restore connection-local foreign-key
and busy-timeout policy; refuse active source transactions, unsupported virtual
tables and seeds larger than 16 MiB. Copy tables, data, indexes,
triggers, views, generated columns, sequences and schema metadata. Never share
mutable connections, cache a snapshot on disk or substitute this fixture in
migration tests. Recorded seed timestamps belong to the migrated snapshot;
tests of time boundaries seed their own dates. The fidelity fixture compares
the current real schema/seed values and exercises independent writes, hidden
rowids, rollback, deferred constraints, triggers and exact native ownership.

Exhaustive source-only Mermaid refusal combinations execute the exact inert
receiver in fresh Node VM fixtures and assert zero parser/render calls. Native
opaque-frame source refusal and every parsed-database/pre-parser allocation
probe remain browser qualification. ACK overlay timing/owner combinations use
the shared controller's Node matrix; full-app numeric-save/reset journeys and
native hook owner-retirement checks qualify the actual wiring.

## Assertions and fixtures

Settings fixtures must implement each invoked settings-write contract with a
typed fake, including client preferences when a provider reset or deletion also
updates server settings. Seed synthetic data for both the affected instance and
an unrelated instance; require the exact client patch, fulfilled original write
result and resulting settings to remove only the target's preferences/favorites.
An optimistic UI update or a caught missing-method error is not persistence
proof. Preserve deliberate rejected-write tests as explicit failure cases rather
than filling unrelated API methods or suppressing their diagnostics.

Native HTTP fixtures register their public test-signal retirement and owned
completion cleanup before the first asynchronous acquisition. Timeout must
fence late continuations, cancel only admitted requests and response bodies,
and join their actual native close before restoring global HTTP/environment
state or releasing fixture ownership. An async body's `finally` alone does
not own hard-timeout cleanup. Retain original assertions, inputs, request/test
budgets and worker policy; cleanup is not another attempt or allowance.
Scoped Effect child fixtures keep their existing adapter finalization owner.
Failure-only diagnostics may observe a bounded set of fixed phases/counts,
never request contents, environment, paths or raw errors. A completed phase
does not prove an unobserved historical timeout's cause.

Every Vitest 5 workspace selects its local or root configuration explicitly;
parent-directory lookup is not configuration inheritance. Preserve the shared
mock-history policy and native fixture assertions when selecting that config.

Browser fixtures likewise own pending renders and original native operations
before their first await. Public test-signal retirement closes admission
synchronously; shared `afterEach` must join the same complete cleanup before
resetting DOM, mocks, viewport or styles, because `onTestFinished` runs later.
Join admitted operations before removing their exact targets; a late render
must still be unmounted without publishing it into the next case's mount slot.
Keep cleanup failures visible and replacement ownership fenced until actual
settlement. Failure-only native phase receipts remain bounded, passive and
content-free. A command finding an actionable target is not delivery or handler
completion evidence, and a cleanup-time screenshot cannot explain an earlier
native timeout. Preserve original input, assertions, workers and deadlines.

Load inert Node fixture modules during collection, after any required synthetic
globals and mock bindings are initialized. Framework transformation and module
evaluation are preparation, not feature readiness: putting only a dynamic import
inside `beforeAll` makes its hook budget also cover that preparation. The saved-
environment and timeline renderer fixtures keep their real imports and original
setup order in collection; their former import-hook timers no longer cover this
work. Actual connection actions, rendering assertions and cleanup remain in their
tests with unchanged action deadlines and worker limits. This is not permission
to move provider opening, network or persistence work, native acquisition, user
actions or lifecycle readiness out of their existing bounded scopes.

Keep native input, focus and accessibility semantics. Geometry is appropriate
for hit targets, clipped content, native control exclusion, drag destinations,
image aspect ratios and preserving the message being read. Do not pin exact
padding, row order, typography ratios, icon masks, animation names/easing,
intermediate frames or theme colors in feature tests.

Readiness must describe the exact action's prerequisite: a committed list load,
focused popup item, submitted provider request or registered timer. Await an
owned receipt installed before the action. Mock invocation does not attest
completed work. Keep zero/once counts for paid submission and authorization.
Use controlled clocks for time policy; a feature test must accept a correct
final counter even when no intermediate animation frame was observed.

Prefer pure decision tables/controller tests for account/context/date/metadata
combinations and a few browser wiring paths. Preserve late-response, owner-loss,
no-replay and privacy cases. Shared controller extraction must fence callbacks
and late asynchronous acquisition after retirement just as the hook did.

Policy tests check declarative or resolved semantics: supported runtime pins,
action integrity, safe artifact paths, bounded resources and unique context
ownership. Do not freeze variable names, source spelling, exact step counts,
whole workflow objects or the current number/order of test cases. Removing a
test intentionally must not require defeating another test that counts it.

## October 16 audit implementation map

The IDs refer to the audit at revision `99180e13`. A mixed suite retains its
feature assertions; a finding does not authorize deleting security or workflow
coverage simply because it shares a file with cosmetic checks.

| Finding | Change                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B01     | Native fluid resize/click/pixel stress moves to explicit stress qualification.                                                                                           |
| B02     | Required fluid smoke checks behavior, bounded resources and disposal; removes solver hashes/exact inventories/long frame counts.                                         |
| B03     | Repeated ambiance child-frame pixel stress moves to the optional browser project.                                                                                        |
| B04     | Status animation sampling is replaced by a background-preference smoke.                                                                                                  |
| B05     | Standalone sample-chart animation/hash/helper tests are retired; production live-chart and native font qualification remain.                                             |
| B06     | Context typography matrix is removed; accessible override editing remains.                                                                                               |
| B07     | Usage facts retain values, unknown/zero distinctions and containment without exact density formulas.                                                                     |
| B08     | Composer tab lip/transition sampling is removed; actions, policy and draft retention remain.                                                                             |
| B09     | Sidebar entrance animation and exact coordinate assertions are removed.                                                                                                  |
| B10     | Titlebar/onboarding checks use control exclusion and reachable actions instead of design constants.                                                                      |
| B11     | Footer checks accessible navigation with native input, without icon masks/dimensions.                                                                                    |
| B12     | Calendar range/peak decisions move to Node tests; browser hover/scroll behavior remains.                                                                                 |
| B13     | Segmented control keeps selection/keyboard/disabled semantics without indicator CSS placement.                                                                           |
| B14     | Count-up numerical behavior moves to a pure unit; browser tests keep final totals and cleanup.                                                                           |
| B15     | Usage tests check final totals instead of transient real-time animation windows.                                                                                         |
| B16     | Task/schedule drafts and focus survive churn without fixed row offsets or decorative quota colors.                                                                       |
| B17     | Provider configuration retains scoped editing/validation/reset; removes header spacing matrices.                                                                         |
| B18     | Reduced-motion scrolling tests keyboard disclosure/cancellation/action, without transition-edge sampling.                                                                |
| B19     | Small image/diagnostic/context motion smokes retain behavior and accessibility without settled coordinate equality.                                                      |
| B20     | Presentation-only full-app ChatView cases are removed.                                                                                                                   |
| B21     | Split feature-specific snapshot builders out of the shared full-app harness; keep workflow/owner races and cover pure policies below the UI.                             |
| B22     | Desk keeps real drag/split/menu/keyboard behavior; removes spinner equivalence and heading adjacency checks.                                                             |
| B23     | Atrium keeps task/history/ownership/reachability; removes exact column tiling and repeated visual permutations.                                                          |
| B24     | Math/diagram source and controls remain; remove exact equation placement and repeated appearance variants.                                                               |
| B25     | Illustrative titlebar/menu screenshot cases leave the blocking suite.                                                                                                    |
| B26     | Metadata controller, skills scope and usage resource tests run in Node; browser hook wiring and owner isolation remain.                                                  |
| B27     | Reduced-motion fluid coverage is a small static-output/cleanup smoke.                                                                                                    |
| B28     | Combined image/chart test separates bootstrap/loading from captured review-document ownership.                                                                           |
| B29     | Image/list fixtures observe committed initial load and rendered revision, preserving visible-anchor assertions without fixed frame loops or tests of fixture validators. |
| B30     | Elapsed-time/visibility/retirement policy moves to a Node ticker controller; native hover/focus remains.                                                                 |
| N01     | Preparation retry schedule has a pure cap table and an integration receipt for actual timer registration before advancing the clock/Stop.                                |
| N02     | Provider error attribution, Claude path encoding and Codex launch/turn/mapping policy tables leave giant integration suites.                                             |
| N03     | Checkpoint fixtures subscribe to their engine before dispatch instead of repeatedly replaying the entire event log.                                                      |
| N04     | Grok Stop waits for an accepted synthetic prompt; retire the vacuous delayed-notification case whose child was already dead.                                             |
| N05     | Browser policy checks declarative ownership data instead of interpreting test/config source and pinning 34 cases.                                                        |
| N06     | Workflow checks retain action pinning, artifact scope and resource limits without exact incidental counts/whole-step copies.                                             |
| N07     | Canonical toolchain checks remain; config import/source-string spelling checks are removed.                                                                              |
| N08     | Public typed RPC feature tests are required; private-map instrumentation/high-volume soak is explicit qualification.                                                     |
| N09     | Icon tests retain decoding/required dimensions instead of silhouette pixel sampling.                                                                                     |
| N10     | Prompt tests retain inputs/schema/bounds/sanitization without editorial section labels.                                                                                  |

This map is a review aid, not a meta-test requiring this exact inventory to
remain forever. Add/remove cases based on feature risk, not a target test count.
