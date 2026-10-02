# Decision: hosted Renovate with manual compatibility boundaries

Decision status: Accepted
Created: 2026-10-03 01:30:40 JST (UTC+0900)
Last updated: 2026-10-03 02:00:17 JST (UTC+0900)
Decision authority: user's explicit request to implement the recommended Renovate setup.
Implementation: Repository configuration, policy tests and operating instructions. The maintainer reports selected-repository App installation and Interactive/Require config file settings. Default-branch publication and a processed hosted run must be verified separately through repository history, the dashboard and hosted job logs; those external conditions are not implied by this record.
Supersedes: None; existing toolchain, native qualification and provider package audits remain authoritative.

## Context and alternatives

Cafe's Yarn monorepo uses catalogs, resolutions, a version-bound Effect RPC patch,
and source/staged dependency mirrors. A manifest bump alone cannot synchronize
the exact toolchain constants or qualify provider lifecycle/native changes.
Renovate's ordinary npm manager supports Yarn catalogs and Corepack. Dependabot
is GitHub-native but its Yarn catalog support is still tracked in an open upstream
request at this decision's creation. A custom or self-hosted bot adds unnecessary
runtime, credential and maintenance responsibilities.

Use the Mend-hosted GitHub App for routine update proposals and GitHub Dependabot
alerts as a separate vulnerability signal. This choice delegates version discovery
and lockfile proposal generation, not compatibility judgment or merge authority.

Sources: [Renovate Yarn support](https://docs.renovatebot.com/modules/manager/npm/),
[Dependabot catalog support request](https://github.com/dependabot/dependabot-core/issues/14989),
[hosted installation](https://docs.renovatebot.com/getting-started/installing-onboarding/).

## Decision

Keep explicit repository policy in `.github/renovate.json`, without explicitly
extending a remote policy preset. The hosted App can still apply external
account/global configuration and its own presets; inspect the effective config
on the first hosted run before trusting the exclusions/merge boundaries. Local
schema validation does not qualify those external inputs. Enable Automated PRs /
Interactive operation for this repository in Mend rather than scan-only Silent
operation. Mend's Silent engine sets global `dryRun=lookup`, which repository
configuration cannot override. Use only the npm/Yarn and GitHub Actions managers. Target
`dev`, retain small relationship-based groups, require a weekly schedule and npm
publication-age hold, limit routine concurrency and require dashboard admission
for majors. GitHub Actions get immutable digest proposals.

Disable routine automation for patched Effect, provider SDKs, native packaging,
browser runtimes, Node/Yarn and security resolutions; disable independent blanket
lock maintenance. Existing manual audits and version-synchronization tests remain
mandatory. Necessary transitive lock changes in otherwise eligible PRs still need
review. Disable Renovate's automatic vulnerability-fix PR generation: its native
alert worker force-applies the vulnerability configuration after package rules,
so explicitly enabling those PRs can bypass manual dependency exclusions. Keep
GitHub alerts enabled and triage every reported fix promptly through a manual
audited PR, without treating the weekly routine schedule as a security response
deadline. Human review, applicable package/platform audits and CI still apply.

GitHub's default-branch configuration starts the hosted bot; dev-only publication
does not activate it. Use a reviewed configuration-only main change, not a bulk
merge of development features. GitHub vulnerability alerts apply to main; fixing
dev never implicitly clears main or qualifies release branches.

## Security, privacy and failure consequences

App access is selected-repository only. The hosted service needs GitHub repository
permissions to read metadata and create branches, issues and PRs, including read
access to vulnerability alerts. It receives no Cafe account/provider credentials,
user profiles or application runtime access. Do not add broad personal tokens,
arbitrary commands, custom managers or package-script execution.

The App, registries and hosted runtime are external trust/deployment dependencies.
Release-age holds and commit digests reduce exposure but do not establish package
safety. Failed extraction, withheld timestamps, unavailable lock generation or
failed CI must stop an update from merging, never trigger a weaker policy or a
second package manager. Disabled packages can disappear from the bot dashboard;
maintainers must still triage alerts and perform the existing full dependency and
provider audits. No automatic merging is enabled, and repository protection must
be reviewed separately before any future change to merge authority.

## Implementation and evidence

The [maintenance guide](../dependency-updates.md) owns activation, main/dev
backports, review, local strict validation and rollback. Default tests guard the
configuration's scope, disabled package families, merge/script boundaries and
security exceptions. Official Renovate validation checks the actual schema;
repository checks and a final forced desktop build gate publication. None of
those local checks proves that the App is installed or has completed its first
repository run; record that external state separately.

This is repository maintenance with no OS-specific application behavior or
provider/token policy change. Existing macOS/Linux/Windows runtime paths, CLI
pins, manifests and lockfile remain unchanged by initial onboarding.
