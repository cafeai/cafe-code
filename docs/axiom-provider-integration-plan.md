# Axiom provider integration plan

## Objective and ownership

Add Axiom as a first-class Cafe provider using the installed native `axiomcli`
over local ACP v1. Keep Axiom's native verifier, encryption, credentials, tool
policy and account-local history authoritative. Reuse Cafe's provider registry,
daemon, orchestration, model picker, approval UI and composer tools tab.

Work on `feat/axiom-provider` from committed `dev`, in an isolated worktree.
Do not include existing uncommitted changes from the original checkout. No push,
release, CLI update, account mutation or billable qualification is implicit in
building and testing this feature.

The reviewed protocol source is AxiomCLI 0.1.13 in the local release source copy.
ACP v1 and Axiom extension family 0 are separate from the product version.
Require the exact understood feature contracts, including `account@2`,
`modelCatalog@1`, `activity@1`, `timeline@2` and `securityEvidence@4`.
Negotiate additional capabilities only when Cafe implements their full contract.

## Implementation sequence

1. **Contracts and native transport**
   - Define bounded schemas for Axiom negotiation, model/account metadata,
     security reports, ordered activity, usage, and native resume identity.
   - Add `AxiomSettings`, provider metadata and built-in registration.
   - Reuse `effect-acp` and shared ACP session transport. Support agents using
     extension-owned authentication without weakening existing Grok admission.
   - Launch structured `axiomcli acp --frontend cli` arguments with the exact
     server-resolved workspace and provider environment; no shell on native
     executables and no Axiom Desktop workspace takeover.
   - Bound startup/probes and protocol frames; preserve unlimited normal prompt
     duration, scope-owned process cleanup and content-free diagnostics.

2. **Discovery, account access and helper generation**
   - Detect the configured binary/version and expose clear installed, disabled,
     unauthenticated, unsupported and ready snapshots.
   - Discover native models, thinking controls, image/file MIME capabilities,
     context/output limits and commands instead of hard-coding a catalog.
   - Use Axiom-owned native login/account status; keep tokens in the native
     credential store. Expose an explicit sign-in action and allow refresh.
   - Implement scoped one-shot generation for Cafe title/metadata helpers using
     the same provider path and a no-tools native mode; no inference retries.
   - Preserve provider account/runtime identity for continuation and reject
     cross-account resume. Keep maintenance explicit and manually installed.

3. **Sessions, turns and durable lifecycle**
   - Implement create/load, effective model/thinking/mode selection, streamed
     text/reasoning, tool states/diffs, plans and native command discovery.
   - Translate approval choices using exact offered identifiers; preserve
     restrictive native policy and cancellation. Support structured questions
     only when the negotiated elicitation contract is compatible.
   - Admit attachments from Cafe-owned files with native bounds/capabilities.
     Never substitute file extraction for Axiom's original-file contract.
   - Return prompt admission promptly and run generation in the session scope.
     Bind every completion/cancellation to its exact native session and turn.
   - Stop/cancel pending questions and approvals and retire only owned children.
     Process exit must settle active work and allow native-history recovery.
   - Retain validated account/runtime-bound resume cursors; load never silently
     creates a replacement conversation. Reload/reconnect only catches up UI.
   - Implement negotiated native compaction and steering with exact turn IDs
     and accepted-message identity; unsupported operations use existing Cafe
     capability routing. Do not fabricate fork, rewind, goals, subagent limits,
     MCP injection or native sandbox guarantees absent from Axiom's protocol.

4. **Attestation and reply verification**
   - Carry an optional typed public security projection through authenticated
     provider/daemon/session surfaces, scoped to account/runtime/thread/model.
   - Use model-only `_axiom/security/prewarm` without prompt or draft content;
     explicit refresh uses `_axiom/security/verify` for the loaded native thread.
   - Validate public report identity, supported protocol pairs, key fingerprints,
     checks, hard expiry and bounds; the native binary owns cryptographic checks.
   - Fence late reports after account/runtime/model changes. Missing or expired
     reports never retain a green verification state.
   - Track latest reply authentication separately from report freshness. Streamed
     content is provisional; cancel/failure/accounting cannot verify a reply.
   - Preserve explicit exact-model outdated-TEE consent, runtime-only consent
     lifetime and yellow degraded status. No automatic consent or fallback.
   - Reuse the curved composer tools tab with an Axiom shield/status control and
     accessible inspector: reply state, attestation state, checks, key/protocol,
     freshness, provenance, explicit refresh and copy-public-report.
   - Explain router/worker scope accurately. Local conversation storage and
     external tools are outside the inference-encryption claim.
   - Include en/ja/ko, light/dark, narrow layouts, scale, keyboard focus/Escape,
     reduced motion and stale selection handling.

5. **Qualification and delivery**
   - Test negotiation, malformed/bounded frames, discovery/account errors,
     exact offered permission IDs, questions, model/mode changes, attachments,
     streaming/terminal ordering, cancellation/exit and resume ownership with
     isolated synthetic Node ACP peers and injected protocol fixtures.
   - Test security expiry, wrong model/account/runtime, duplicate/out-of-order
     activity, provisional/incomplete replies and exact explicit consent.
   - Exercise provider settings/model picker and the real composer inspector
     in credential-free browser fixtures; include new browser cases in the
     existing macOS/Windows focused subset without increasing runner budgets.
   - Document installation/sign-in, executable configuration, supported native
     capabilities, verification meaning and opt-in native qualification.
     Update AGENTS.md with the implemented architecture.
   - Run repository-pinned Corepack Yarn 4.17.1 on Node 24.21.0: `yarn fmt`,
     `yarn lint`, `yarn typecheck`, `yarn test`, focused browser checks, then
     `yarn build:desktop --force` as the final verification command.
   - Review changes and report exact local evidence and unresolved native-host
     qualification. Keep live provider/inference checks opt-in `*.e2e.test.ts`.

## Acceptance

A user can configure/select Axiom, authenticate through its native account flow,
send supported inputs, review approvals, see streamed work, stop generation and
resume durable native history. Axiom's composer tab exposes truthful, separately
scoped attestation and latest-reply information without redesigning the chat.
Existing providers retain their behavior. All required repository checks and the
forced desktop build pass. Unsupported native capabilities are documented and
accurately advertised, with no partial implementations or counterfeit evidence.
