# Claude Agent SDK 326 compatibility

Created: 2026-11-18 03:10:21 JST (UTC+0900)
Last updated: 2026-11-18 03:10:21 JST (UTC+0900)

Cafe selects Agent SDK **0.3.326** in its server, scripts and staged desktop
runtime dependencies. The official [SDK release notes](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.326)
and [CLI release notes](https://github.com/anthropics/claude-code/releases/tag/v2.1.326)
describe the corresponding native release. Repository dependency changes do not
replace a configured external executable or update an already running query.
Package admission and managed-installation integrity remain separate checks.

## Private MCP initialization

SDK 326 can carry MCP launch configuration through its initialize exchange
instead of the native command line. Cafe selects this delivery only when the
existing observation of the configured executable names a canonical, finite,
stable version at least **2.1.326**. Unknown, older, malformed and prerelease
versions retain explicit `argv` delivery. The SDK package version, model label
and a historical session do not qualify this protocol. One opening freezes its
existing native-version observation for configuration and ownership metadata.

This reduces command-line exposure of Cafe's private MCP connection configuration
on qualified runtimes. Legacy delivery remains visible to process-inspection
facilities, as before; it is a compatibility path, not the same privacy claim.
Cafe preserves the SDK's native initialize acknowledgement checks and does not
retry a failed opening through another delivery. The change grants no tool,
permission, account, project or replay authority, and does not turn on strict
MCP configuration or suppress user/project MCP sources.

## Native capability and event compatibility

[SDK 325](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.325)
corrects reported effort levels under organization/model caps. Cafe now retains
an explicitly empty native effort list through normalization. Such a list removes
the effort and Ultracode controls, including previously saved selections, instead
of restoring static catalog options. Unrelated settings remain available.
Absent or malformed discovery is still distinct from a conclusive native cap.

The existing progress path accepts the hook-wait heartbeat introduced in
[SDK 323](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.323)
without inventing a task/subagent or an input-consumption receipt. Existing
informational-warning and configuration-failure handling remain in place;
new native warning tags do not grant continuation or configuration-write
authority. Native sandbox, permission and MCP-denial fixes remain upstream's
behavior; Cafe adds no override to restore older automatic approvals.

## Verification scope

The query-process policy owner covers stable/old/unknown/prerelease gates. An
actual-SDK serializer test uses only inert in-memory peer streams to check that
MCP configuration arrives in initialize and private sentinels stay out of argv.
It does not invoke a provider or prove live native adoption. Existing adapter
fixtures cover account binding, MCP configuration and permissions across both
delivery generations, plus quiet hook heartbeats. The model-metadata owner
checks an empty native cap through normal discovery and session-option dispatch.

No Projects connector, native agent-team support, archive surface or automatic
restart is introduced by this provider update.
