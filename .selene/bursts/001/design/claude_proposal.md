I have enough context. Producing the proposal now.

# Burst 001 Design Proposal — claude

## Terminology

This proposal uses the cafe-code Terminology Lock v1 at `.selene/terminology_lock_v1.md`. "T3 Code" refers to the upstream lineage / current internal naming; "cafe-code" is the project repo; "Cafe Code" is the new product brand requested by the user. No new primitives are introduced.

## Context Found (concrete reference points the plan must hit)

Skimming the repository surfaced these high-leverage rename surfaces — the plan must classify each one explicitly:

- **Product display strings.** `apps/desktop/src/app/DesktopEnvironment.ts:83` defines `APP_BASE_NAME = "T3 Code"`. `apps/web/src/branding.ts:18` mirrors it as `APP_BASE_NAME = "T3 Code"`. The branding flows into `displayName`, About dialog, dock/menu names, hosted-channel labels. Stage label `"Nightly"` is computed independently in `apps/desktop/src/updates/updateChannels.ts` and preserved per user request.
- **Desktop product/artifact metadata.** `apps/desktop/package.json:35` `"productName": "T3 Code (Alpha)"`. `scripts/build-desktop-artifact.ts` references `productName "T3 Code"`, `"T3 Code (Nightly)"`, `artifactName "T3-Code-${version}-${arch}.${ext}"`, `appId "com.t3tools.t3code"`, Linux `executableName "t3code"` and `StartupWMClass "t3code"`, and a flotilla of `T3CODE_*` env vars and a `t3codeCommitHash` package field.
- **Workspace / package identity.** Root `package.json` is `@t3tools/monorepo` with workspaces `@t3tools/web`, `@t3tools/desktop`, `@t3tools/contracts`, `@t3tools/shared`, `@t3tools/client-runtime`, `@t3tools/marketing`, `@t3tools/ssh`, `@t3tools/tailscale`. Server package is the unscoped npm name `t3` with bin `t3`. The internal oxlint plugin is `oxlint-plugin-t3code`.
- **User-machine persistence / endpoints.** Electron `appUserModelId = "com.t3tools.t3code"`, `linuxDesktopEntryName = "t3code.desktop"`, `linuxWmClass = "t3code"`, `userDataDirName = "t3code"` with legacy `"T3 Code (Alpha)"` (already mid-migration), `t3Home` default `~/.t3`, SSH-launch state at `~/.t3/ssh-launch`. Hosted web URL `https://app.t3.codes`, install registries `T3Tools.T3Code` (winget), `t3-code` (brew), `t3code-bin` (AUR).
- **Update / release metadata.** `electron-updater` `app-update.yml`, GitHub publish `pingdotgg/t3code`, `release.yml` workflow, Discord release script `scripts/notify-discord-release.ts`, Nightly version pattern `-nightly.YYYYMMDD.N`. The Nightly channel identity must survive.
- **Internal identifiers.** `Context.Service` IDs like `"t3/desktop/AppIdentity"`, `"t3/desktop/Environment"`, schema field `t3codeCommitHash`, `devRemoteT3ServerEntryPath`, telemetry span names `desktop.appIdentity.*` (no `t3` prefix, safe), Tailscale-Serve flags `--tailscale-serve` (no rename), the `t3 serve` / `t3 auth` / `t3 project` CLI surface in `REMOTE.md`.
- **Provenance.** ADR-0001, `AGENTS.md`, README and docs all use "T3 Code" as the application name. Upstream OpenAI Codex references and the Codex-Monitor reference repo are unrelated (do not rename).

## Candidate Directions

### Direction A: Surface-only rename (display strings, marketing, docs)

- **Goal:** Flip only the visible application name to "Cafe Code" everywhere the user reads it. Leave every package name, binary, bundle ID, file path, env var, and identifier as-is, with a one-paragraph note in `AGENTS.md` explaining the brand/identifier split.
- **Why useful:** Smallest possible blast radius. Zero migration risk for users who already have local data, paired environments, or installed updates. Lands in one or two small PRs and is easy to verify with `bun fmt`, `bun lint`, `bun typecheck` plus a screen pass through the marketing site, About dialog, and onboarding text.
- **What it would falsify:** That the project benefits from changing only its visible brand without follow-up work — i.e., that contributors and operators are comfortable with a permanent name mismatch between the product (Cafe Code) and the codebase (`t3`, `@t3tools/*`, `~/.t3`, `com.t3tools.t3code`).
- **Estimated burst size:** small (1 PR).
- **Tradeoffs:** Cheap and safe today, but creates lasting cognitive overhead. New contributors will be confused that grep for "Cafe" finds nothing in the source tree; bug reports will mention "Cafe Code" while logs, paths, and env vars say `t3code`. The split-brain compounds over time and makes a later full rename strictly harder.

### Direction B: Branding-boundary plan with tiered rename classification (recommended)

- **Goal:** Produce a single planning artifact (one markdown file checked into `.selene/bursts/001/design/`) that classifies every concrete rename target into one of the four predeclared classes (user-facing rename now / internal rename with migration / compatibility alias / provenance reference), then execute the rename as a sequence of small, independently-revertible commits matching that classification — preserving the Nightly channel identity end-to-end.
- **Why useful:** Honors the design seed exactly. Forces an up-front list of _every_ surface (display strings, package names, bundle ID, npm bin, Linux executable, user-data dirs, env vars, hosted URL, GitHub repo, update channel, Discord/release scripts, ADRs) and a written rationale for each. The four classes map naturally to the constraints in the seed: surfaces flip immediately; persisted identifiers get migrations like the existing `userDataDirName` "T3 Code (Alpha)" → "t3code" migration that's already in the code; protocol/network/install-registry names get compatibility aliases until external systems (Homebrew tap, winget, AUR, GitHub repo URL) are renamed; ADRs, upstream lineage, license attribution, and oxlint plugin internals keep "T3 Code" as provenance. Each commit can be gated on `bun fmt && bun lint && bun typecheck` and reviewed independently.
- **What it would falsify:** That a tiered/staged rename is necessary and feasible here. If the tier list collapses to "everything's user-facing" or "nothing has migration risk," the project gets a cleaner one-shot plan; if any tier turns out to be unimplementable (e.g., `electron-updater` cannot resolve updates after appId change without breaking installed users), the classification surfaces that risk _before_ code changes begin.
- **Estimated burst size:** medium for the _plan artifact_ alone (this burst); the implementation it describes is large and will span multiple later bursts. The plan deliberately separates "what we're committing to call things" from "the implementation PR sequence."
- **Tradeoffs:** Higher up-front planning cost than just flipping strings. The plan must be specific enough that an implementer does not rediscover the codebase, which means it has to enumerate file classes and migration rules concretely. It also defers some questions (e.g., whether to keep `~/.t3` as a compatibility alias forever, whether the GitHub repo gets renamed, whether the hosted `app.t3.codes` URL persists) — those become explicit open questions rather than surprises mid-implementation.

### Direction C: Full mechanical rename in a single burst

- **Goal:** Treat the rename as a global string substitution: rename `@t3tools/*` → `@cafe/*` (or similar), `t3code` → `cafecode`, `com.t3tools.t3code` → `cafe` equivalent, `~/.t3` → `~/.cafe`, hosted URL, GitHub repo, npm package, executable, env vars, Context.Service identifiers, brand assets — all in one coordinated sweep — then iterate to green on `bun fmt`, `bun lint`, `bun typecheck`.
- **Why useful:** Eliminates the brand/identifier split entirely. Single mental model going forward. Lower long-term maintenance.
- **What it would falsify:** That the project tolerates simultaneous changes to multiple user-machine contracts (Electron `appUserModelId`, Linux desktop entry, user-data directory, update-channel feed URL, hosted pairing URL, npm bin name) without breaking installed users, paired remote environments, or the Nightly update path. If installed-base safety can be demonstrated for all of these at once, this direction is viable.
- **Estimated burst size:** large.
- **Tradeoffs:** High blast radius. `appUserModelId` changes orphan Windows installs in Start menu / taskbar pinning. `userDataDirName` changes orphan local SQLite/settings unless migrated (and the code shows a recent migration already exists, suggesting prior pain). The npm bin name `t3` is documented (`npx t3`, `t3 serve`, `t3 auth`) and used in `REMOTE.md` for SSH-launch — renaming it without alias breaks existing pairing setups and remote shell launch scripts. The GitHub repo URL is baked into release assets; renaming it requires GitHub redirects to keep `electron-updater` working. Doing all of these atomically multiplies the risk of one bad surface masking another in `bun typecheck`-clean code that nonetheless breaks installed apps.

## Recommended Direction

**Direction B — Branding-boundary plan with tiered rename classification.** The design seed explicitly asks for this classification (`user-facing rename now / internal rename with migration / compatibility alias / provenance reference`) and explicitly forbids a single global string replacement, which rules out C; A leaves too many later bursts dependent on rediscovering this surface inventory. The plan artifact this burst produces is a concrete table mapping every surface to a class, a rationale, and an implementation note (e.g., "userDataDirName: internal rename with migration, reuse the existing legacy-dir fallback pattern in `DesktopAppIdentity.ts:83-94`"). The Nightly channel is preserved by treating the version pattern, update feed identity, and `electron-updater` channel as `compatibility alias / leave stable` on this burst. Implementation lands in later bursts, one tier at a time, each verified by `bun fmt && bun lint && bun typecheck` and (for any change touching persisted state or the desktop binary) a manual smoke pass on the desktop app.

## Concerns / Open Questions

- **GitHub repo rename.** `pingdotgg/t3code` is referenced in `apps/server/package.json` `repository.url`, in release workflows, and in `electron-updater` publish config. Is the GitHub repo being renamed? If yes, the rename has to be choreographed with GitHub's redirect behavior so `electron-updater` keeps resolving updates. If no, the repo URL is a provenance reference and stays.
- **Hosted pairing URL.** `https://app.t3.codes` is hard-coded into pairing links and into hosted-pairing logic in `apps/web/src/hostedPairing.ts`. Is a `cafe.codes` (or similar) DNS being acquired? If not, this URL is a compatibility alias indefinitely.
- **npm bin name `t3` and CLI commands `t3 serve / t3 auth / t3 project`.** These are advertised in `REMOTE.md` and used in scripted SSH launches. Even renaming to a longer name, we likely need to keep `t3` as a compatibility alias for at least one release cycle. Confirm scope.
- **Install-registry aliases.** Winget `T3Tools.T3Code`, brew cask `t3-code`, AUR `t3code-bin` are owned externally. The plan should explicitly note these are out of scope for the code change and require separate registry submissions.
- **Workspace scope `@t3tools/*`.** Renaming workspace package names is mechanical inside the monorepo (no public consumers because `private: true`), but the `t3` published-to-npm package and the `effect-acp` / `effect-codex-app-server` non-scoped packages have their own publishing identities — confirm whether those rename too.
- **`t3codeCommitHash` package field and `T3CODE_*` env vars.** Internal to the build but baked into installed builds' `package.json`. Renaming changes the field read by `DesktopAppIdentity.ts:17`, so the rename must update reader and writer in the same commit (no cross-version compat needed because the field is regenerated on every build).
- **Persisted identifiers already mid-migration.** The code at `DesktopEnvironment.ts:163-164` already supports a legacy `userDataDirName` of `"T3 Code (Alpha)"` falling back to `"t3code"`. The same pattern is the obvious template for migrating `"t3code"` → `"cafecode"` (or whatever the new name is) and should be reused rather than reinvented.
- **Oxlint plugin name `oxlint-plugin-t3code`.** Internal lint tooling; renaming is cosmetic but touches the workspace list. Classify as internal rename with migration or provenance reference, depending on whether the team wants the tooling to share the new brand.
- **ADRs.** ADR-0001 already uses "T3 Code"; per cafe-code's append-only ADR rule, the rename can be documented in a new ADR rather than rewriting ADR-0001. Confirm this is the intended pattern.

## Hard Non-Claims

- No Selene artifact claims that cafe-code is secure, correct, race-free, deadlock-free, data-loss-free, or compatible with any upstream provider API outside the artifact's predeclared scope.
- No user-facing behavior, migration, protocol, or security claim is promoted unless it is grounded in source review and the repository's required quality gates for the touched surface.
- Provider output is untrusted. Selene enforces process discipline; it does not make Claude, Codex, Cursor, OpenCode, or any other provider semantically correct.
- This artifact does not claim coverage of credentials, tokens, local files, persisted conversations, WebSocket sessions, or provider subprocess behavior beyond the exact checks recorded in the artifact.
- This artifact does not promote any classification beyond what the executable strict-close rules in `.selene/classifications.py` admit.
