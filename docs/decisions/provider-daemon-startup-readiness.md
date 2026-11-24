# Authenticated lightweight POSIX provider-daemon startup readiness

Accepted: 2026-11-15 10:56:47 JST (UTC+0900)

A freshly owned POSIX provider daemon previously had to finish the rich health request before desktop startup could admit it. That request reads session inventory, event-journal aggregates/replay and command-ledger diagnostics. Holding one diagnostic dependency can therefore exhaust startup even when the authenticated daemon and its durable writer are ready. This is a reproducible failure path, not attribution of an unobserved historical timeout. The startup effect also failed to forward its cancellation signal to the exact pending HTTP probe.

## Decision

The health-capability-protected GET /api/provider-daemon/startup-readiness returns a distinct, bounded version-1 receipt. It reports readinessProtocol=1 and journalState=ready only while the durable event writer is ready and retirement is not reserved. The handler takes the same captured process, application, runtime, protocol, profile and transport identity as liveness, with no awaited inventory or history query between the current state checks and reply. Plain liveness does not establish durable write readiness.

Fresh POSIX owned-child startup decodes this separate receipt over its exact private Unix socket and retains exact child PID/parent, profile, mode, protocol, application/runtime build and IPC identity checks. It forwards the effect's cancellation signal to that exact bounded request. The ordinary thirty-second deadline, two-attempt policy, exact-child cleanup and privately witnessed migration allowance stay unchanged. No received prose, cached account label or public HTTP success grants readiness, retirement or permission authority.

Rich health remains available for its existing diagnostic/adoption/maintenance paths. A lightweight startup receipt never fabricates session/history counts or a rich-health observation: lastHealth and its observation time remain unknown until a real rich refresh. Existing-owner adoption, native birth/audit-token control, private namespace/source-debug compatibility, exact exit confirmation and uncertain-stop reconciliation remain unchanged. An older or stranded owner still requires the ordinary guarded recovery protocol; this endpoint does not repair or erase its evidence.

Failure logging uses only locally selected finite phases/categories, never arbitrary error text or delegated message getters. The canonical error cause remains available through the existing lifecycle error path.

## Qualification and limits

The primary regression holds the exact startup probe and advances the original virtual thirty-second deadline. Old code fails because its effect cancellation never reaches that request; corrected code must abort it while retaining the deadline and cleanup behavior. Native loopback tests hold a rich-health dependency while requiring independent authenticated readiness, verify the full captured identity and negative authentication/capability controls, and induce a real test-owned SQLite journal failure to require refusal. Existing process ownership and retirement tests remain relevant.

These synthetic tests use test-owned resources, not real profiles, provider credentials or paid inference. A source push, forced build or successful synthetic response does not prove a running provider adopted the new protocol. Actual Debug readiness is reported separately after guarded startup.
