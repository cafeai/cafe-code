# Claude provider update — October 27–28

The source update selects Claude Agent SDK **0.3.311** and the separately
bundled Windows Claude Code **2.1.311**. Source changes and package admission
do not establish that an installed application or user-selected provider has
been updated; local and hosted verification remain separate observations.

## Release channel and age

At the October 28 05:28 JST registry recheck, Claude Code's `latest` and `next`
tags had advanced to 2.1.312, while its separate `stable` tag was still 2.1.308;
the SDK's `latest` and `next` were 0.3.312. The 312 wrapper packages were
published on October 27 at 18:36–18:37 UTC and had not cleared the 24-hour hold
at that recheck. This change selects the previously audited 311 family rather
than bypassing the age gate. A non-prerelease published as `latest` is not
evidence that the separate CLI `stable` channel has advanced.

The last of the SDK 0.3.311 wrapper and eight platform packages was published
at 2026-10-26 19:51:06.091 UTC, and the last of the Claude Code 2.1.311 wrapper
and eight platform packages at 2026-10-26 19:54:26.350 UTC. Their complete
24-hour holds cleared at 2026-10-27 19:51:06.091 UTC and 19:54:26.350 UTC,
respectively. The October 28 05:28 JST recheck compared all 18 exact identities,
archive digest metadata and registry signatures to the preserved archive audit;
the youngest had passed 24 hours by approximately 34 minutes. Retain the existing
age policy and all other integrity, compatibility, platform, and verification gates.

Read-only verification of the npm registry's published public keys and signed
`name@version:integrity` records passed both ECDSA signatures for each of the 18
exact wrapper/platform package identities, 36 signatures total. This verifies
registry metadata signatures, not executable behavior or the release-age gate.
A serial, bounded, read-only stream of all 18 tarballs independently matched
registry SHA-512 and SHA-1 digests and the embedded package name/version; the
Windows native package manifests also matched their intended `win32` CPU. This
is not a full manifest-field comparison or native execution test. The Claude
Code wrapper declares lifecycle scripts; the managed bundle does not run them.

## Scope and upstream changes

SDK 0.3.311 adds separate five-minute and one-hour cache-creation fields to
`ModelUsage`, and requires Node 18.14 or later. Code 2.1.311 reports fixes for
SDK/headless transcript ordering, compaction, late MCP connections for
subagents, and interruption of stalled MCP resource reads. Version 2.1.309
reports security fixes involving sandbox shell startup, symlinked write-deny
paths, MCP configuration and permission checks. Those are upstream release
claims, not proof of any particular Cafe failure. SDK 0.3.309 also reports
managed-settings restriction and embedded-extraction fixes; a source search
found no Cafe use of those named SDK APIs. The published SDK declarations were
compared directly against 0.3.308; full compatibility tests remain required.

The shipped `sdk.d.ts` describes both TTL fields as optional subsets of the
aggregate cache-creation count, potentially absent or incomplete for resumed
sessions and unreported lifetimes. They cannot safely be added to the aggregate
or interpreted as complete coverage. It also adds `mcpMount` to the source of
`SDKPermissionRuleEntry`, `liveReply` to the private MCP-status control request,
and managed-settings marketplace `pluginDigests`. A search of Cafe's application,
package, and script sources found no calls to `list_permission_rules`, no
consumer of that rule-entry source union, no `liveReply` request, and no
`pluginDigests` or `managedSettings` call site. These additions therefore need
no new Cafe control based on the inspected call sites; they remain delegated to
the selected provider. This source audit does not demonstrate live-provider
behavior or justify overriding permissions or loading plugin hooks.

The SDK update keeps the server, scripts, staged desktop runtime,
and lockfile on the same exact version. The Windows managed-provider manifest is a separate
CLI bundle with its own exact package URLs and SHA-512 values. Existing source
execution uses its selected configured CLI; upgrading the SDK does not upgrade
that external executable. The managed bundle is used for fresh Windows installs;
normal application updates retain the existing exclusion from fresh provider
bootstrap. Changing a source pin alone does not upgrade an existing selected
provider generation or prove live runtime adoption.

Sources: [SDK 0.3.311 release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.311),
[SDK 0.3.312 release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.312),
[SDK 0.3.309 release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.309),
[Claude Code 2.1.311 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.311),
[Claude Code 2.1.312 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.312),
[Claude Code 2.1.309 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.309),
[SDK registry metadata](https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk),
[CLI registry metadata](https://registry.npmjs.org/@anthropic-ai%2fclaude-code),
[npm registry signing keys](https://registry.npmjs.org/-/npm/v1/keys).
