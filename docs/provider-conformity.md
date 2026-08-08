# Provider conformity and CLI updates

Cafe Code separates upstream discovery, source conformity, publication, and local CLI installation.
An npm `latest` release is evidence that a new audit is needed; it is not permission to change every
user's binaries.

The tested compatibility boundary lives in
`packages/shared/src/providerCompatibility.ts`. It pins the Claude Code CLI, Claude Agent SDK,
Codex CLI, and exact Codex app-server protocol ref. The normal package-age quarantine remains part
of the review boundary.

## Operator check

Run `corepack yarn providers:conform check` from a Cafe Code source checkout. It reports installed,
approved, and registry versions for each installed provider; a missing CLI is reported and skipped.
Registry discovery is advisory, so an offline or egress-restricted machine can still converge to the
source-approved local matrix. If upstream is newer than the matrix, the
workflow reports the quarantined release. Exact-version package-manager installs may still converge
to the approved matrix. Codex's standalone updater has no exact-version argument, so it remains a
manual update path even when upstream equals the pin. If another provider has a safe exact-version
path, that provider may still converge while the unsupported layout is reported for manual action;
the workflow fails before shutdown when no requested provider is safely actionable.

Run `corepack yarn providers:conform update --project-dir <current-project>` after the matrix contains
the versions you intend to run. The command checks source pins and runs format, lint, typecheck,
tests, the desktop build, and the offline conformity smoke before Cafe Code exits. It identifies
unsupported install layouts before scheduling anything and proceeds only when at least one requested
provider has a safe exact-version plan. The detached helper writes a one-shot mode-0600 recovery
manifest under a mode-0700 Cafe state directory, verifies that every recorded provider version is
still current, consumes the manifest before any state-changing action, closes Cafe Code, installs
exact approved versions where the package manager supports them, verifies the binaries, repairs
recognized Windows Cafe Code shortcuts, relaunches, and proves that the checkout-bound launcher
remains alive through a bounded stability window. Old logs are capped; fallback diagnostics append
to the same attempt log. An install,
verification, or partial-shutdown failure still attempts to restore Cafe Code first and then shows
an operator-visible notice pointing to the bounded log. If shutdown reports any surviving process,
the helper does not install providers or launch a second Cafe Code instance; it displays a dedicated
warning instead. Only a relaunch failure offers Claude Code
or Codex in the recorded project directory. `--project-dir` is recommended; package-manager
invocations may use `INIT_CWD`, but the resolved recovery project must exist outside the Cafe Code
checkout.

The helper uses `shell: false`, closed stdin, bounded output, and process-tree deadlines on macOS,
Linux, and Windows. Windows npm/pnpm provider shims run only through the trusted System32 `cmd.exe`
boundary with verbatim fixed arguments and percent/newline/quote rejection; Corepack and npm
themselves run through their JavaScript entrypoints.
Homebrew's floating `upgrade` operation is intentionally rejected until an exact-version install can
be proved. Cafe Code sets Claude Code's documented `DISABLE_AUTOUPDATER=1` only in provider processes
it launches, keeping the repository-approved binary durable while leaving explicit versioned
installs available to the detached helper. Compatibility-pinned providers are never replaced by the
live in-app maintenance runner. A Linux AppImage relaunch preserves the inherited `APPIMAGE`; a macOS packaged relaunch
may preserve an explicit `CAFE_CODE_MACOS_APP_BUNDLE`; source runs use the source launcher. Windows
PowerShell and shortcut behavior is isolated to Windows. Arch Linux is a distinct CI lane; Ubuntu,
macOS, and Windows remain in the primary quality matrix. GitHub's hosted Windows
runner is the automated Windows boundary, while release qualification on actual Windows 10 and 11
machines remains necessary before claiming those exact OS versions as certified.

## Maintainer publication

1. Create a focused branch named `provider-conformity/<versions>` from the current Cafe Code
   development base.
2. Audit official provider release notes, SDK types, protocol schemas, lifecycle changes, auth and
   credential behavior, and new capabilities. Update the matrix only after the package-age gate.
3. Add or regenerate source changes and tests. Commit intentionally; the publication command will
   not sweep up a dirty worktree.
4. Run `corepack yarn providers:conform publish`. It refuses protected or unrelated branches,
   validates the upstream repository and its current default base before pushing, runs all local
   gates, pushes the fork branch, and creates or reuses only an open focused draft PR against Cafe
   Code. The origin must be that target or its direct GitHub fork. Cross-fork reuse is resolved by
   exact fork owner, head branch, base branch, and open state; the generated body includes the
   provider-conformity review template. A newer quarantined registry release is reported as evidence
   but does not block publishing the tested matrix needed to review that release.
5. Use `--wait-ci` only when the operator wants the command to wait for required checks and mark the
   draft ready after they pass. A failure leaves the PR draft and reusable code unavailable for
   merge. Its bounded watcher accounts for the quality jobs plus dependent native-artifact jobs.

This workflow never pushes directly to `main` or `dev`, never auto-merges, and never promises that
an arbitrary provider feature can be exposed safely without source review. Narrow Cafe Code PRs
should link the official evidence and carry only the reusable compatibility change.
