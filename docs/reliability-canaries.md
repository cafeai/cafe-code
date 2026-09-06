# Reliability canaries

The `Reliability and dependency canaries` workflow runs manually or twice weekly
against `dev`. It is separate from PR checks because package registries, native
installers, process handoff and wall-clock load are external dependencies.
GitHub enables scheduled triggers only after this workflow is present on the
repository's default branch; pushing it to `dev` alone does not activate the
schedule. The normal release merge should promote the workflow unchanged.

- Dependency scanning includes every workspace and transitive dependency, with
  no security-advisory exceptions. Deprecation warnings are not classified as
  vulnerabilities; inspect them separately during normal package maintenance.
- Process checks use synthetic provider events and isolated daemon fixtures on
  macOS/Linux. They exercise real process restart and health under large-event
  load without provider accounts or inference.
- Packaged macOS/Linux/Windows checks install or extract the produced artifact, run
  the existing runtime self-test and authenticated backend/renderer readiness
  checks, then clean up only test-owned processes and files.

Run the credential-free process checks locally with the pinned toolchain:

```sh
corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/providerDaemonRestart.e2e.test.ts integration/providerPipelineLiveness.e2e.test.ts
corepack yarn npm audit --all --recursive --no-deprecations
```

Real-account provider canaries remain explicit opt-ins. Never configure account
credentials for scheduled PR/untrusted-branch execution or silently run paid
prompts as part of installation. For native artifact commands and platform
prerequisites, use the existing `test:native-*-artifact` commands after building
the corresponding artifact; Windows installer smoke requires an isolated CI
runner or its existing explicit local opt-in.

Failure triage should distinguish readiness, provider ownership, event journal
durability, canonical ingestion, accounting settlement and renderer delivery.
Retry only bounded, idempotent infrastructure observations or the exact storage
write. Never resend an inference prompt merely because its acknowledgement was
lost.
