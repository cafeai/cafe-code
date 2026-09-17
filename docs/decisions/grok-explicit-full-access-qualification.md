# Explicit Grok Full access qualification

**Decision status:** Accepted within the user-authorized Grok compatibility change.

**Created:** 2026-09-17 18:30:57 JST (UTC+0900)

**Latest revision:** 2026-09-17 18:46:45 JST (UTC+0900)

**Implementation status:** Implemented and regression-tested, including repository-wide tests, typechecking, lint and targeted browser checks.

**Supersedes:** None.

## Context

Cafe's Grok availability check starts a disposable read-only ACP process for authentication and model discovery. Grok 1.0.34 rejects symlinked container-runtime socket endpoints while applying that sandbox. A host can therefore support ordinary unsandboxed Grok while failing Cafe's protected qualification. Treating this as general provider unavailability prevents selecting Grok even though the existing Full access chat mode could work.

## Decision

Keep protected qualification as the default. Offer an explicit, confirmed **Use without sandbox** action for a Grok provider instance. Persist its narrowly scoped consent as `allowUnsandboxedProbe`; missing or false means protected checks, and revocation returns to that policy. The preference selects only the connection-check process profile, not a thread's runtime access mode. It is deliberately not another general sandbox-disable toggle.

With consent, qualification launches once with sandbox off and native default/ask permission policy. It initializes ACP, authenticates, and discovers capabilities without sending model prompts or registering Cafe's per-thread MCP tools. A successful result can make Grok selectable, but it reports sandbox support as **not checked**, not available. Protected qualification failures retain a typed **sandbox unavailable** result and fixed safe reason codes. No failed protected check automatically retries unsandboxed.

Actual sessions continue to use Cafe's existing runtime/interaction-mode mapping. Users select **Full access** for unsandboxed normal chat; this mode also bypasses ordinary approval prompts. Plan, protected chat modes, and separate text-generation helpers retain their existing sandbox requirements and fail closed if those requirements cannot be enforced.

## Alternatives and rationale

- Automatically disable sandboxing on macOS or after a failure: rejected because this would silently change an execution boundary.
- Change Docker configuration: rejected as an automatic repair because other clients may depend on the optional socket link.
- Add a second general sandbox toggle: rejected because it could contradict per-thread access policy and Plan mode.
- Require protected qualification for every use: rejected because it conflates sandbox support with provider connectivity and disables an already-supported explicit Full access mode.

## Security, privacy, and operations

The deliberate security change is permission to run disposable connection-check processes outside the OS sandbox after user confirmation. Native approval behavior, shell-free ownership, bounded lifetime, authentication rules and sanitized diagnostics remain in place. Approval policy alone is not a substitute for an OS sandbox; the confirmation must say so. No prompts, output, credentials, socket targets, or raw stderr are added to status metadata.

Consent is scoped to the exact provider instance and stored with its configuration. The existing settings-write authorization applies. Saving configuration may reload the instance, so the UI must advise making this change between sessions. Reverting consent is not a command to stop an existing Full access thread; actual session access remains controlled by the chat's normal access selector. No Docker changes, credential mutations, or new runtime dependencies are required.

The existing provider-status disk cache is not bound to runtime configuration.
Grok therefore retains only its cached model catalog during initial hydration,
not cached readiness, authentication, failure text or sandbox conclusions. The
new scope performs its normal bounded initial check using current consent. This
prevents an old unsandboxed success from being presented as fresh protected
qualification after consent is revoked.

## Implementation and evidence

The canonical contracts are `GrokSettings` and `ServerProviderSandbox`; `checkGrokProviderStatus` applies qualification policy. The dedicated Grok settings action owns user confirmation. `grokSandboxProfileForRuntimeMode` remains the sole runtime mapping, and disposable Grok text generation remains read-only.

Required evidence covers absent/false/true consent, explicit process flags, safe failure classification, revocation, confirmation/cancellation and per-instance preservation, plus unchanged runtime and helper protection. The repository's formatting, lint, typecheck, test and forced desktop-build gates apply. Passing qualification does not prove a full model turn or platform-wide provider support.

Regression coverage lives in `GrokProvider.test.ts`, `providerStatusCache.test.ts`,
the contracts settings/server tests, `GrokSandboxSettings.browser.tsx`,
`GrokAdapter.test.ts`, and `GrokTextGeneration.test.ts`. It exercises consent and
revocation, no-prompt/no-MCP qualification, configuration-independent cache
invalidation, canceled UI actions, and retained protection outside qualification.

See [the Grok guide](../grok-build.md) for user-facing behavior and limitations.
