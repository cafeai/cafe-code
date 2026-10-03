# Decision: Track the newest Node LTS with exact reviewed runtime identities

Decision status: Accepted
Created: 2026-10-03 20:56:23 JST (UTC+0900)
Last updated: 2026-10-03 21:09:34 JST (UTC+0900)
Decision authority: User explicitly requested latest LTS rather than Current, all associated updates, and publication to dev plus activation of the narrow policy on main.
Implementation status: Canonical runtime/configuration changes, integrity checks and policy qualification are implemented. Full verification gates remain mandatory before each publication; default-branch publication and hosted processing must be verified separately rather than inferred from this record.
Supersedes: Only the Node/manual-manager exclusion in [initial Renovate maintenance](renovate-dependency-maintenance.md); no change to provider/native/Yarn/Effect/security-resolution review or merge authority.

## Context and alternatives

Cafe had one older standalone Node24 pin duplicated in CI, packaging and setup,
while declarations had moved to Node26. Current can introduce APIs absent from
the supported runtime; permanently freezing a major can leave later LTS updates
unproposed. Node's schedule is changing, so an odd/even-major heuristic is not a
durable LTS policy. A moving local runtime alias would also make tests/builds
non-replayable. Automatically running repository upgrade commands in the bot
would broaden the supply-chain execution boundary.

The selected approach delegates release discovery to Renovate's native Node
datasource and release-schedule-aware versioning, retains an exact reviewed pin,
and gates coordinated archive/container/distribution updates through tests and
manual review. No custom manager, arbitrary command, credential, package-script
execution or automatic merging is added.

## Decision

- Track the highest officially promoted LTS line and latest qualified release
  within it. Never adopt a higher Current/prerelease merely because its version
  number is greater. At this decision, official release metadata identifies
  24.21.0 Krypton as newest LTS and 26.10.0 as Current.
- `.node-version` is the exact standalone development/runtime authority. CI reads
  it; mise, root/server engines, development containers, immutable Docker image
  and distribution/runtime packaging must be synchronized before merge.
- Enable only native nodenv/mise Node extraction alongside existing npm/actions
  managers. Non-Node mise tools remain manual. Node runtime proposals may appear
  immediately; npm declarations retain their seven-day publication-age gate.
  Node majors still require dashboard admission. Human review and full applicable
  checks are mandatory for every update; a proposal is not an installation.
- Keep `@types/node` on the promoted LTS major through upstream Node versioning,
  using its own age-qualified npm patch numbering. Types do not authorize newer
  runtime APIs, particularly in independently qualified Electron.
- Keep reviewed version-keyed archive/distro identities and immutable Docker
  digests. A pin-only change fails consistency/integrity checks until completed
  and qualified; do not invent new hashes/codenames or weaken checks to accept it.
- Publish the same policy to main, where hosted Renovate reads it, and dev, where
  proposals are targeted. A narrow policy publication is not a bulk application
  merge from dev to main. Development runtime updates remain separately staged.

## Security, privacy and failure consequences

The bot receives no provider credentials or access to Cafe user profiles. Its
existing App scope, script denial, vulnerability override denial, concurrency
limits, review requirements and disabled sensitive dependency families remain.
Official versioned checksum records and immutable image digests bind reviewed
artifact identities; a digest alone is not proof of upstream safety or signature
verification. Keep archive extraction integrity/cache requirements in AGENTS'
Windows-Specific Notes. Incomplete identities, failed checks or inconclusive
qualification stop merging, never authorize fallback to Current or an unchecked
cache. No global user runtime or paid provider is changed.

## Compatibility and operational consequences

Standalone Node updates do not upgrade Electron's embedded Node/native ABI or
installed provider CLIs. Keep that runtime's separate qualification unchanged.
The server/root engines express the reviewed LTS major with the new minimum,
excluding older/Current majors. Exact tests/builds use the canonical patch.
Native platform smoke remains an explicit CI/opt-in boundary; Mac synthetic
fixtures do not establish Linux/Windows installer qualification.

The [maintenance guide](../dependency-updates.md#node-lts-synchronization) owns
the coordinated update procedure, activation, checks and rollback. Old dated
dependency audit reports remain historical rather than being rewritten as new
verification. If the hosted job has not processed the published policy, report
publication and processing separately.

## Evidence and retained decisions

The Node config is qualified against Renovate44.115.10's actual rule matcher,
versioning and release lookup filter, not a home-grown approximation. Synthetic
clock qualification rejects Current today and admits future LTS promotions;
exact/range replacements, native extraction shapes and manual exclusions are
covered. Strict repository schema validation and default policy tests pass.
Complete runtime/default tests and the final forced desktop build before release.

Sources: [official Node release index](https://nodejs.org/dist/index.json),
[Renovate Node versioning](https://docs.renovatebot.com/modules/versioning/node/),
[versioning implementation](https://github.com/renovatebot/renovate/blob/44.115.10/lib/modules/versioning/node/index.ts),
[supported Node files](https://docs.renovatebot.com/node/),
[Node declarations workaround](https://docs.renovatebot.com/presets-workarounds/#workaroundstypesnodeversioning).

All initial Renovate decisions other than the explicitly superseded Node scope
remain in force. Full runtime review is retained even though discovery is now
automated; this is not a waiver of native artifact or supply-chain qualification.
