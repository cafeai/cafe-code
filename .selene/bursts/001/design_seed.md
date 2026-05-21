# Burst 001 Design Seed — Cafe Code Rename

## User Request

The product should be renamed from "T3 Code" to "Cafe Code". The user wants the
Nightly version retained, but the application brand should become Cafe Code.
Existing stylization where "Cafe" is visually emphasized can remain.

## Scope To Plan

Produce a comprehensive rename plan before implementation. The plan should map
all likely surfaces, including:

- visible product names in the web UI, desktop UI, marketing pages, window
  titles, screenshots, docs, onboarding text, settings, empty states, toasts,
  release text, and update metadata;
- package/app names, binary names, bundle identifiers, desktop artifact names,
  updater metadata, and configuration directories where changing identity is
  safe and intentional;
- internal TypeScript symbols, CSS classes, route names, storage keys,
  database fields, protocol constants, and package names where a mechanical
  rename may create migration or compatibility risk;
- repository docs, comments, tests, fixtures, snapshots, scripts, GitHub
  metadata, and deployment/release scripts;
- legacy/upstream references that should remain as provenance, compatibility,
  or third-party names rather than being renamed.

## Constraints

- Preserve predictable behavior under existing local data, saved sessions,
  WebSocket clients, update channels, and desktop installs.
- Do not silently break persisted client storage, SQLite data, auth/session
  state, package import paths, or release/update channels.
- Classify each rename target as one of:
  - user-facing rename now;
  - internal rename with migration;
  - compatibility alias / leave stable;
  - provenance reference / leave as T3 Code.
- Include a verification plan using this repository's required gates:
  `bun fmt`, `bun lint`, and `bun typecheck`. Do not run `bun test`; use
  `bun run test` only if tests are needed.
- Include a staged implementation plan with small safe commits or bursts,
  rather than a single global string replacement.

## Expected Output

The agreed plan should be specific enough that an implementer can execute the
rename without rediscovering the codebase. It should name concrete directories
or file classes to inspect, define migration/compatibility rules, and identify
high-risk surfaces before code changes begin.

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
