# Burst 002 Implementation Report

Status: manual recovery implementation complete; final gates passed.

The Selene implementation worker entered Burst 002 and produced the bulk
rewrite, but did not close with artifacts. This report records the recovered
implementation against the approved `.selene/bursts/002/design/agreed_plan.md`
and the Burst 001 58-row matrix.

## Implementation Summary

- Renamed repository-owned package scope and imports from `@t3tools/*` to
  `@cafecode/*`.
- Renamed the preferred server package and CLI entrypoint to `cafe-code` while
  keeping the `t3` bin alias.
- Added Cafe-first environment handling with `CAFE_CODE_*` preferred and
  `T3CODE_*` retained as legacy fallback.
- Added Cafe-first browser storage keys with legacy `t3code:*` migration reads.
- Added Cafe-first home/config paths where safe, with deterministic legacy reads.
- Added `/.well-known/cafe-code/environment` while preserving
  `/.well-known/t3/environment`.
- Renamed repository-owned visible copy, release copy, docs, observability
  defaults, and active Cafe repo links.
- Preserved Nightly version/tag/channel semantics and updater-sensitive desktop
  identifiers where the approved plan required compatibility.
- Wrote `.selene/bursts/002/design/domain-migration-checklist.md` for the
  hosted-domain and external-distribution work that must happen later.

## Security And Compatibility Notes

- Legacy env vars, storage keys, endpoint paths, checkpoint refs, worktree
  prefixes, and persisted directories were not silently removed. They either
  remain stable or are dual-read so existing local state and automation are not
  orphaned by the rename.
- No fake Cafe hosted domains were introduced. Current `t3.codes` defaults stay
  as external routing contracts until DNS/TLS/deploy/cookie/update criteria are
  met.
- The compatibility changes intentionally reduce accidental data loss during
  the rebrand; this report does not claim the application is secure or correct
  beyond the checks recorded here.

## Row-By-Row Matrix

Class values are limited to the four admitted labels in the approved plan:
`user_facing_rename_now`, `internal_rename_with_migration`,
`compatibility_alias_leave_stable`, and
`provenance_reference_leave_as_t3_code`.

| ID  | Cluster | Class                                   | Burst 002 outcome and anchors                                                                                                 |
| --- | ------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | C3      | `user_facing_rename_now`                | Web brand fallback is Cafe Code in `apps/web/src/branding.ts` and tests.                                                      |
| 2   | C3      | `user_facing_rename_now`                | Desktop brand base is Cafe Code in `apps/desktop/src/app/DesktopEnvironment.ts`.                                              |
| 3   | C3      | `user_facing_rename_now`                | About panel and app chrome inherit Cafe Code from `DesktopAppIdentity.configure()`.                                           |
| 4   | C3      | `user_facing_rename_now`                | Desktop dev launcher display was renamed in `apps/desktop/scripts/electron-launcher.mjs`.                                     |
| 5   | C3      | `user_facing_rename_now`                | Web shell and splash text use Cafe Code in `apps/web/index.html` and splash components.                                       |
| 6   | C3      | `user_facing_rename_now`                | Web status/settings/update/provider copy uses Cafe Code / Cafe Code Server.                                                   |
| 7   | C3      | `user_facing_rename_now`                | Server and CLI visible help/log/error copy was renamed while env and service IDs stay compatible.                             |
| 8   | C3      | `user_facing_rename_now`                | Git author display names are Cafe Code in VCS driver paths.                                                                   |
| 9   | C2      | `compatibility_alias_leave_stable`      | `t3code@users.noreply.github.com` remains as a stable author email until an operator-owned identity exists.                   |
| 10  | C3      | `user_facing_rename_now`                | Marketing site copy and active GitHub links now point to Cafe Code / `cafeai/cafe-code`.                                      |
| 11  | C3      | `provenance_reference_leave_as_t3_code` | Marketing testimonial quote text remains unchanged in `apps/marketing/src/lib/tweets.ts`.                                     |
| 12  | C3      | `user_facing_rename_now`                | README and docs prose were renamed, with compatibility notes for old commands/env/paths.                                      |
| 13  | C6      | `compatibility_alias_leave_stable`      | External registry IDs are removed from active install docs and tracked in the domain/distribution checklist.                  |
| 14  | C3      | `user_facing_rename_now`                | `AGENTS.md` names Cafe Code and keeps the added targeted-search policy.                                                       |
| 15  | C1      | `internal_rename_with_migration`        | Root package identity is `@cafecode/monorepo`; lockfile root metadata was updated after Bun regeneration left it stale.       |
| 16  | C1      | `internal_rename_with_migration`        | Workspace package names/imports use `@cafecode/*`; typecheck verifies import resolution.                                      |
| 17  | C1      | `compatibility_alias_leave_stable`      | Preferred package/bin is `cafe-code`; `t3` remains a bin alias for compatibility.                                             |
| 18  | C1      | `compatibility_alias_leave_stable`      | Oxlint plugin directory/package/rule prefix moved to Cafe, with `t3code/no-inline-schema-compile` legacy rule coverage.       |
| 19  | C4      | `user_facing_rename_now`                | Desktop `productName` and visible package metadata use Cafe Code while app IDs remain stable.                                 |
| 20  | C4      | `user_facing_rename_now`                | Desktop build display now produces Cafe Code / Cafe Code Nightly; Nightly version/channel semantics are unchanged.            |
| 21  | C4      | `internal_rename_with_migration`        | Desktop artifact filename pattern remains `T3-Code-${version}-${arch}.${ext}` and is deferred to checklist criteria.          |
| 22  | C4      | `compatibility_alias_leave_stable`      | Staged Electron package name remains `t3code` for updater/builder continuity.                                                 |
| 23  | C4      | `user_facing_rename_now`                | Staged description is Cafe Code; legal/operator author metadata remains stable where not safely owned by this burst.          |
| 24  | C4      | `compatibility_alias_leave_stable`      | `t3codeCommitHash` remains as a coupled writer/reader metadata field.                                                         |
| 25  | C4      | `compatibility_alias_leave_stable`      | Electron app IDs remain `com.t3tools.t3code*` to preserve installed-app continuity.                                           |
| 26  | C4      | `compatibility_alias_leave_stable`      | Linux desktop entry, executable, and WM class remain `t3code*` pending package migration.                                     |
| 27  | C4      | `compatibility_alias_leave_stable`      | Desktop user-data names remain compatible; legacy `T3 Code (Alpha/Dev)` path fallback is preserved.                           |
| 28  | C2      | `compatibility_alias_leave_stable`      | Base home defaults prefer `~/.cafecode` with `~/.t3` and `T3CODE_HOME` fallback.                                              |
| 29  | C2      | `compatibility_alias_leave_stable`      | SSH launch state and package specs keep legacy paths/specs where remote automation depends on them.                           |
| 30  | C2      | `compatibility_alias_leave_stable`      | SSH askpass internals remain stable; env aliases were not forced into that contract.                                          |
| 31  | C2      | `internal_rename_with_migration`        | Browser storage keys are `cafecode:*` with tested legacy `t3code:*` migration paths.                                          |
| 32  | C6      | `compatibility_alias_leave_stable`      | Hosted `app.t3.codes`, `latest.app.t3.codes`, and `nightly.app.t3.codes` remain current defaults and are checklist items.     |
| 33  | C6      | `compatibility_alias_leave_stable`      | `/__t3code/channel` and `t3code_web_channel` remain current hosted contracts and are checklist items.                         |
| 34  | C6      | `compatibility_alias_leave_stable`      | `https://app.t3.codes/pair` remains the hosted pairing default pending live Cafe routing.                                     |
| 35  | C2      | `compatibility_alias_leave_stable`      | Added `/.well-known/cafe-code/environment`; kept `/.well-known/t3/environment`.                                               |
| 36  | C4      | `user_facing_rename_now`                | Stable release workflow name is `Cafe Code v$version`.                                                                        |
| 37  | C4      | `compatibility_alias_leave_stable`      | Nightly tag/version/dist-tag shape remains `vX.Y.Z-nightly.YYYYMMDD.N` and `nightly`.                                         |
| 38  | C4      | `compatibility_alias_leave_stable`      | Update manifest/channel schemas remain stable.                                                                                |
| 39  | C4      | `internal_rename_with_migration`        | Active repository metadata/marketing links now use `cafeai/cafe-code`; updater publish/domain criteria remain deferred.       |
| 40  | C6      | `provenance_reference_leave_as_t3_code` | Historical upstream issue/comment references remain unchanged; generic test fixture repos were moved to Cafe identity.        |
| 41  | C4      | `user_facing_rename_now`                | Discord/release announcement copy uses Cafe Code while Nightly semantics remain stable.                                       |
| 42  | C2      | `compatibility_alias_leave_stable`      | `CAFE_CODE_*` env vars are preferred through shared helpers; `T3CODE_*` remains fallback.                                     |
| 43  | C2      | `compatibility_alias_leave_stable`      | Project script envs write Cafe and legacy names for child-process compatibility.                                              |
| 44  | C5      | `internal_rename_with_migration`        | Observability defaults and service labels now use `cafe-code-server`; `T3CODE_OTLP_*` remains fallback.                       |
| 45  | C5      | `compatibility_alias_leave_stable`      | Effect service IDs such as `t3/...` remain stable diagnostic/dependency IDs.                                                  |
| 46  | C5      | `compatibility_alias_leave_stable`      | Existing brand-neutral span names remain unchanged.                                                                           |
| 47  | C2      | `compatibility_alias_leave_stable`      | Checkpoint refs prefer `refs/cafe/checkpoints` and preserve `refs/t3/checkpoints` compatibility.                              |
| 48  | C2      | `compatibility_alias_leave_stable`      | Worktree branches prefer `cafecode/*` and still recognize `t3code/*`.                                                         |
| 49  | C2      | `internal_rename_with_migration`        | VCS project config supports `.cafecode/vcs.json` with `.t3code/vcs.json` fallback.                                            |
| 50  | C2      | `compatibility_alias_leave_stable`      | Keybinding config examples/docs prefer Cafe paths while legacy user paths remain accepted.                                    |
| 51  | C2      | `compatibility_alias_leave_stable`      | Provider machine IDs such as Cursor `t3-code` remain stable provider-side identifiers.                                        |
| 52  | C3      | `user_facing_rename_now`                | Provider-visible titles and OpenCode session titles use Cafe Code.                                                            |
| 53  | C6      | `compatibility_alias_leave_stable`      | Low-value test/temp prefixes were renamed where touched; remaining legacy prefixes are classified as fixtures or machine IDs. |
| 54  | C6      | `internal_rename_with_migration`        | Brand asset references remain compatible until Cafe replacement artwork is provided.                                          |
| 55  | C6      | `user_facing_rename_now`                | Visible alt/copy references use Cafe Code; inherited icon artwork remains outside this code-only burst.                       |
| 56  | C6      | `provenance_reference_leave_as_t3_code` | License/legal ownership text is unchanged.                                                                                    |
| 57  | C6      | `provenance_reference_leave_as_t3_code` | Existing ADRs, invariants, and terminology-lock records were not edited.                                                      |
| 58  | C1      | `internal_rename_with_migration`        | `bun.lock` package metadata follows the Cafe workspace rename and remains generated dependency state.                         |

## Remaining Legacy Match Classification

- `T3 Code` / `T3 Server`: only testimonial quotes and legacy desktop
  user-data fallback/test assertions remain.
- `@t3tools` / `oxlint-plugin-t3code`: no active source matches remain outside
  deleted-file history in the working tree.
- `T3CODE_*`: retained as legacy env-var fallback paths; `CAFE_CODE_*` is the
  preferred prefix.
- `t3code:*` localStorage keys: retained only as legacy migration reads.
- `/.well-known/t3/environment`: retained as compatibility endpoint beside the
  new Cafe endpoint.
- `refs/t3/checkpoints` and `t3code` worktree prefixes: retained as legacy
  recovery/branch compatibility.
- `app.t3.codes`, `latest.app.t3.codes`, `nightly.app.t3.codes`,
  `/__t3code/channel`, and `t3code_web_channel`: deferred external hosted
  routing surfaces listed in the domain checklist.
- `com.t3tools.t3code`, `t3code.desktop`, `t3code` Linux executable/WM class,
  and `T3-Code-${version}-${arch}.${ext}`: updater/OS/package compatibility
  surfaces deferred to a packaging migration.
- `t3-code` Cursor client IDs and probe names: provider machine identifiers
  retained for compatibility.
- `https://github.com/pingdotgg/t3code/issues/2388`: upstream provenance in a
  source comment.

## Verification Results

Final gate results:

- `bun install`: passed after package rename; Bun left the root package name
  stale in `bun.lock`, so the generated metadata line was corrected to match
  `package.json`.
- `bun run --cwd packages/shared test src/compatEnv.test.ts`: passed, 3 tests.
- `bun run --cwd packages/shared test src/git.test.ts src/observability.test.ts`:
  passed, 17 tests.
- `bun run --cwd apps/web test src/clientPersistenceStorage.test.ts src/composerDraftStore.test.ts src/versionSkew.test.ts src/rpc/serverState.test.ts src/hostedPairing.test.ts`:
  passed, 81 tests.
- `bun run --cwd apps/server test src/cli/config.test.ts src/bin.test.ts src/environment/Layers/ServerEnvironment.test.ts src/provider/Layers/CodexAdapter.test.ts`:
  passed, 41 tests.
- `bun run --cwd apps/desktop test src/app/DesktopEnvironment.test.ts src/app/DesktopAppIdentity.test.ts src/app/DesktopConfig.test.ts src/settings/DesktopClientSettings.test.ts src/settings/DesktopSavedEnvironments.test.ts src/ssh/DesktopSshRemoteApi.test.ts`:
  passed, 24 tests.
- `bun run --cwd scripts test notify-discord-release.test.ts build-desktop-artifact.test.ts`:
  passed, 10 tests.
- `bun fmt`: passed on 1118 files.
- `bun lint`: passed with 9 existing warnings and 0 errors.
- `bun typecheck`: passed, 13 successful tasks.
- `selene freeze-invariants`: passed; TypeScript parser skipped AST signatures
  for known files while file-level SHA-256 manifests still covered content.
- `selene verify`: passed manifest, AST-signature, and ADR append-only checks.
- `bun test`: not run.

## Hard Non-Claims

- No Selene artifact claims that cafe-code is secure, correct, race-free,
  deadlock-free, data-loss-free, or compatible with any upstream provider API
  outside the artifact's predeclared scope.
- No user-facing behavior, migration, protocol, or security claim is promoted
  unless it is grounded in source review and the repository's required quality
  gates for the touched surface.
- Provider output is untrusted. Selene enforces process discipline; it does not
  make Claude, Codex, Cursor, OpenCode, or any other provider semantically
  correct.
- This artifact does not claim coverage of credentials, tokens, local files,
  persisted conversations, WebSocket sessions, or provider subprocess behavior
  beyond the exact checks recorded in the artifact.
- This artifact does not promote any classification beyond what the executable
  strict-close rules in `.selene/classifications.py` admit.
