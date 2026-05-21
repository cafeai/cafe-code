# Burst 002 Design Seed — Complete Cafe Code Rename

## Required Outcome

Burst 002 must be an implementation burst, not another planning-only burst.
The user explicitly rejected a planning-only close and clarified that this is a
full rebrand, not just visible copy. A successful burst must modify project
source/docs/config/package metadata so the active product, code identifiers, and
distribution metadata use `Cafe Code` naming wherever the repository can control
the surface.

## Scope

Use Burst 001's matrix as historical source review, but supersede its
compatibility-only default for this burst. Rename the project from T3/T3 Code to
Cafe Code across visible and internal surfaces, while preserving old names as
explicit aliases/migration inputs when changing them would otherwise orphan
state or break existing automation.

Preferred new identifiers:

- human brand: `Cafe Code`
- slug: `cafe-code`
- compact identifier: `cafecode`
- npm/workspace scope: `@cafecode`
- CLI package/bin: `cafe-code`, with a temporary `t3` bin alias during
  migration
- env prefix: `CAFE_CODE_*`, with legacy `T3CODE_*` fallback where operators may
  already depend on it
- home/config paths: `~/.cafecode`, `.cafecode`, with legacy `~/.t3` and
  `.t3code` reads where state already exists
- localStorage keys: `cafecode:*`, with dual-read migration from `t3code:*`
- Git refs and branch/temp prefixes: `refs/cafe/checkpoints`, `cafecode`
- Electron/Linux IDs: Cafe Code IDs/names, with legacy user-data lookup where
  applicable
- GitHub repository URL: `https://github.com/cafeai/cafe-code`
- hosted domains: do not invent or pretend Cafe domains are live in this burst.
  We are not hosting domains yet. The burst must create a domain migration
  checklist artifact listing future required domain, DNS, TLS, deploy, redirect,
  cookie, pairing URL, and update-channel changes. Existing `t3.codes` domain
  references may remain only as legacy compatibility/current-default references
  until that checklist is executed.

Rename product strings from `T3 Code` / `T3 Server` to `Cafe Code` / `Cafe Code
Server` across:

- web branding, boot shell, splash, settings, update prompts, connection
  labels, tests, and accessible text;
- desktop app display names, launcher names, package `productName`, About/menu
  copy, startup/error text, tests, and desktop build product descriptions;
- server and provider user-facing messages, command descriptions, release
  notification copy, release smoke expected display names, and tests;
- marketing pages/layout copy and visible command-demo copy;
- README, REMOTE, KEYBINDINGS, docs, AGENTS/CLAUDE instructions, and GitHub
  workflow release display names;
- package names, workspace import specifiers, root scripts/filters, repository
  metadata, plugin names/rule IDs, release scripts, desktop build metadata,
  provider integration IDs/titles, observability defaults, source-control/env
  docs, checkpoint refs, temporary prefixes, local config paths, browser storage
  keys, and tests.

## Compatibility Constraints

Rebrand everything the repository owns, but preserve safety by implementing
aliases/migrations rather than silently dropping old names:

- If renaming package imports from `@t3tools/*` to `@cafecode/*`, update all
  package names, imports, tsconfig/package references, scripts, lockfile, and
  tests together.
- If renaming CLI/package metadata from `t3` to `cafe-code`, keep `t3` as a bin
  alias for now and update docs to prefer `cafe-code`.
- If renaming env vars from `T3CODE_*` to `CAFE_CODE_*`, code must read the Cafe
  var first and the old var second, and docs should mark old names as legacy.
- If renaming persisted directories/paths/keys, add deterministic dual-read or
  legacy fallback so existing users are not forced into data loss.
- If renaming routes/endpoints/cookies/domains, keep old routes/cookies as
  aliases unless the old hosted surface is only documentation. Do not switch
  hosted-domain defaults to a made-up Cafe domain in this burst.
- If renaming update/app IDs/artifact names, preserve updater compatibility or
  document any irreducible external release/infrastructure step in the
  implementation report.
- Legal/provenance-only text, upstream history, and copyright ownership may
  remain T3/T3 Tools where changing it would be a false legal claim.

## Falsifying Criteria

Burst 002 fails if any of the following are true:

1. It closes as planning-only or only writes Selene artifacts.
2. Any repository-owned `T3 Code` or `T3 Server` product copy remains outside
   explicit legal/provenance contexts.
3. Nightly loses its channel identity. Visible Nightly copy must become Cafe
   branded while version patterns, tags, dist-tags, and updater channels remain
   stable.
4. Old compatibility names are simply deleted where data loss, broken existing
   automation, or updater breakage would result. They must remain as aliases or
   legacy fallbacks.
5. No domain migration checklist artifact exists. It must identify the exact
   later work needed before replacing `app.t3.codes`, `latest.app.t3.codes`,
   `nightly.app.t3.codes`, hosted pairing URLs, channel cookies/routes, TLS/DNS,
   redirects, and release/update channel references.
6. `bun fmt`, `bun lint`, and `bun typecheck` do not pass. Do not run
   `bun test`; use `bun run test` only for focused tests if needed.

## Audit Expectations

The auditor should run targeted `rg` checks for remaining `T3 Code`, `T3
Server`, `t3code`, `@t3tools`, `T3CODE`, `t3.tools`, `t3.codes`, and active
`t3` identifiers. Remaining matches must be justified as compatibility alias,
legacy fallback, test fixture lineage, direct quote/provenance, or legal text.

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
