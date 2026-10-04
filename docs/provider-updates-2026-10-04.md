# Claude SDK qualification — October 4, 2026

Created: 2026-10-04 20:42:15 JST (UTC+0900)
Last updated: 2026-10-04 21:28:31 JST (UTC+0900)
Status: dependency update implemented; provenance and isolated compatibility checks passed. Integrated release requirements are below.

## Scope and selected release

Update Claude Agent SDK from 0.3.286 to **0.3.288**, synchronizing the server, scripts and staged desktop-runtime manifests with Yarn's lockfile. This is a compatible dependency update, not a native-provider installation or a change to account, permission, model, prompt, cache, scheduling or task-control policy. Cafe explicitly passes its configured executable through `pathToClaudeCodeExecutable`; replacing the imported SDK does not replace that executable. No provider binary, live account, user transcript, production database or paid inference was used for qualification.

At `2026-10-04T11:42:48.104Z`, SDK `latest`/`next` pointed to 0.3.289. Every numerically newer ordinary release was considered; 0.3.289 was the only one. Its complete nine-package set does not clear the repository's 24-hour hold until `2026-10-04T20:12:59.628Z` (October 5, 05:12:59.628 JST). The complete 0.3.288 set cleared at `2026-10-03T18:33:37.942Z`. The youngest package in each set was the wrapper, not a platform sibling.

CLI registry channels are a separate observation: `latest`/`next` were 2.1.289, published `2026-10-03T20:12:02.717Z`, while the named `stable` channel remained 2.1.285. A non-prerelease version and the CLI's slower `stable` channel are not interchangeable. Neither channel label authorizes updating or downgrading the user's executable. Sources: [SDK registry](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk), [CLI registry](https://registry.npmjs.org/@anthropic-ai/claude-code).

## Supply-chain evidence

Verified the wrapper and all eight exact-version native dependencies: macOS arm64/x64; Linux arm64/x64 for glibc and musl; and Windows arm64/x64. Each downloaded archive matched the registry SHA-512 integrity, and all 18 supplied registry signature entries verified against the published registry key. The signature entries share a key and are not 18 independent attestations. Registry signatures bind registry metadata to integrity; they are not an independent publisher attestation.

Every embedded manifest matched its registry identity, version, platform constraints, engine constraints, dependencies, optional/peer dependencies, scripts and executable/export entrypoints. The archive-only packaging `files` list is retained as evidence, but npm does not publish that field in its registry version object. No archive code was executed during verification.

Wrapper SRI: `sha512-W0axvKSBKC8E1rMvriV8NVMFfNv8uwN3HnJxUiFLJOQcJLp1MDp0SoAugkAKTn3WLx3JnqCxxME6bGvfNJzJoA==`.

Immutable upstream review identities:

| Source                                                                                                                                      | Revision                                   | Downloaded changelog SHA-256                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| [Claude Code changelog](https://github.com/anthropics/claude-code/blob/2bfb629dfaff0c8318047a4beb93cf1dc5b58b18/CHANGELOG.md)               | `2bfb629dfaff0c8318047a4beb93cf1dc5b58b18` | `c3b0831a2102d8d4800a2eb00c2a0d3095378d57d690e0ed1e8e3c386299f5e7` |
| [Agent SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/16cf0a783143406b1ad5c4a2b0dbf0af2be04b04/CHANGELOG.md) | `16cf0a783143406b1ad5c4a2b0dbf0af2be04b04` | `1e0ab10adf1e80e3fbacfb1b1c0710a194719bc17ec86b5a5a79cff8c268a0d0` |

## API and event compatibility

A comment-independent TypeScript declaration comparison of the verified 0.3.288 archive with 0.3.286 found no changes to public `Query` methods, `Options`, message discriminants, permission modes, task status unions or usage accounting fields. `sdk-tools.d.ts`, `core.d.ts` and `agentSdkTypes.d.ts` have unchanged semantic declarations. Additions in `sdk.d.ts` are optional informational tags, remote first-text latency fields, a per-model settings auto-compaction window and a private task-output control request/response. That internal request is not a new public `Query` method and is not used by Cafe.

The intervening SDK release notes describe improved partial-stream completion, revoked-login errors, in-process MCP retirement and initial command ordering. They also document detached WebFetch/WebSearch results under explicit urgent delivery and omission markers for oversized MCP structured content. Cafe does not enable a new delivery priority, fabricate a task completion from those placeholders, or introduce task-output polling in this update. Its explicit Manual `permissionMode: "default"` remains required; omission still delegates to native settings. [SDK release notes](https://github.com/anthropics/claude-agent-sdk-typescript/blob/16cf0a783143406b1ad5c4a2b0dbf0af2be04b04/CHANGELOG.md).

## Native fixes and security boundary

Native 2.1.287–2.1.288 contains partial-response recovery, resume/compaction consistency fixes, MCP scope reauthentication and duplicate-call prevention, headless shutdown fixes, and safer hook and shell permission handling. Relevant security changes make hook matching/serialization failures block execution and require approval for dangerous nested shell deletion and arithmetic-sensitive assignments. Background-command timeout policy still applies to SDK/unattended sessions; its removal for native interactive sessions does not remove Cafe's native SDK-session limit. These behaviors require the corresponding configured CLI; a wrapper upgrade alone is not proof they are active.

The reviewed but unadopted 2.1.289 contains further managed permission, shell-rule, symlink-read and plugin-sign-in-description hardening. Those fixes are not claimed as delivered by SDK 0.3.288, and the package hold is not bypassed. [Native release notes](https://github.com/anthropics/claude-code/blob/2bfb629dfaff0c8318047a4beb93cf1dc5b58b18/CHANGELOG.md).

## Concurrency and token policy

Inspected the verified 2.1.288 macOS arm64 native artifact as inert data, SHA-256 `bbe93063f7a0879a1021b2891e5c9354e5b3b98433e32efe6750f7710afed750`. Its environment parser still requires positive plain digits for `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, with default 20. Local Agent-tool admission checks the running-subagent count; slot acquisition increments it and a once-only release decrements it. Remote launch avoids that local check, and native feature/Ultracode exceptions remain upstream-owned. The resume path acquires a slot separately without reusing Agent-tool admission; observer activity is exempt there. This is not a universal cap on every native task or workflow, and no new global cap is imposed by Cafe.

Preserve Cafe's existing configured-CLI capability gate, optional 1–64 safety ceiling, copied per-query environment, inherited omission and whole-tree idle replacement policy. Native manual/resume exceptions are not converted into Cafe-side queues or retries. The official [environment-variable reference](https://code.claude.com/docs/en/env-vars) documents the Agent-tool scope; the [concurrency decision](decisions/per-chat-subagent-concurrency.md) defines Cafe's ownership boundary.

No change to cumulative child-inclusive Claude accounting, primary-context estimates, resumed baselines, prompt construction, Fast policy or provider-owned cache/compaction defaults is made by this dependency update. Optional upstream fields do not justify guessed usage or token-savings claims.

## Verification and replay

Host: macOS arm64, pinned Node 24.21.0 and Corepack Yarn 4.17.1. Initial source: `dev` at `3f00e8df76c6777f6452092731ef654bc25ff5d3`, tree `018110241ac5c424ec6c580654f357eb7039cd05`. Dependency-only patch SHA-256: `20165ba025b4ccb4819d4963f960ac1b97f2bca3947ee14a7222422ff33f1e00`; updated lockfile SHA-256: `c78fc9e95cf349173c638cfc19207414fbd656c419f13ea7720447a1a11ecb5d`.

The shared `corepack yarn install` passed. Fresh setup used a Git archive of that exact base plus only the three updated manifests and lockfile in `/tmp/cafe-claude-oct4-replay.ZaTyrb`:

```sh
corepack yarn install --immutable --mode=skip-build
corepack yarn workspace @cafecode/scripts test toolchain-policy.test.ts
corepack yarn workspace @cafeai/cafe-code test src/provider/Layers/ClaudeAdapter.test.ts
```

Immutable installation passed; the skip-build flag qualifies dependency resolution/linking only, not native build outputs. The existing Effect/Vitest peer warnings remain understood and are not suppressed. Toolchain tests passed 12/12 and the isolated existing Claude adapter suite passed 155/155. The latter covers explicit Manual approvals, resumed identity/usage, task identities and MCP form/URL callback validation/cancellation. Its preexisting local rollback test is not evidence of correct native conversation rewind; the separately implemented rewind must have its own stateful regressions.

A credential-free import check verified five SDK exports without calling them, matched five installed implementation/declaration files byte-for-byte to the verified wrapper archive, checked all three exact pins and the lockfile, and matched the linked native artifact to the verified archive without executing it. The immutable identities and replay commands above are the portable evidence; temporary local package reports and replay logs are not required repository inputs.

These focused synthetic passes do not prove native timeout recovery, live OAuth scope negotiation, paid inference, foreign-platform runtime behavior or long-duration workloads. Integrated formatting, lint, typecheck, full tests, relevant new compatibility regressions and the final forced desktop build must be recorded against the final combined source before completion is claimed.
