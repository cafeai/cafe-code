# Axiom integration repair plan

Date: 2026-11-16. Scope: the six findings from the Axiom–Cafe Code integration
review. Work stays on the existing development checkouts. Preserve unrelated
local edits, credentials and native profiles; do not restart applications,
publish releases, push changes or perform paid inference.

## Work allocation

Three workers implement independent parts in the shared checkout. Each worker
writes meaningful regression coverage but runs no tests, typechecking, formatting,
linting or builds. The coordinator waits for all workers to finish, reviews the
combined changes, and owns the single consolidated validation phase.

| Worker                     | Findings                                                                                               | Primary ownership                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol and compatibility | 1: reject current native versions; 6: obsolete contract coverage                                       | Axiom ACP support and its tests, current public contract fixture and drift checks, opt-in native qualification                                              |
| Runtime and commands       | 3: failed native turns reported as completed; 4: obsolete command dispatch and inaccessible compaction | Axiom adapter and its tests, shared synthetic Axiom peer, native ACP prompt failure handling and regression tests, required orchestration command admission |
| MCP and composer           | 2: remote MCP state rejected; 5: unreachable MCP revision review                                       | MCP contracts and tests, Axiom MCP control and browser coverage, composer mounting/revision ownership                                                       |

The coordinator owns this plan, the final provider guide and architecture
instructions, integration review and consolidated verification. Workers coordinate
before touching another worker's files. The runtime worker owns the shared mock
peer and incorporates requested fixture changes from the other workers.

## Repairs and acceptance

1. **Negotiate the current reviewed contract.** Support the documented compatible
   activity v1/v2 and desktop MCP v1/v2 contracts independently of product version.
   Preserve required account, attachment, security-evidence and runtime identity
   checks. Reject unknown incompatible versions with actionable diagnostics.
   Installed/current AxiomCLI 0.1.22 initialization must pass without admitting
   incomplete or incompatible security contracts.

2. **Represent local and remote MCP transports correctly.** A remote connection
   has a validated destination and may have an empty local command. Retain native
   transport/authentication metadata without exposing credentials. A disabled or
   unselected remote connection must not prevent session startup or an unrelated
   prompt. Mutations must preserve exact native revision and session ownership.

3. **Preserve terminal failures.** Use structured native failure outcomes rather
   than uncorrelated error text followed by successful completion. Cafe must
   publish a failed turn with useful sanitized feedback, keep partial replies
   unverified, and retain cancellation and exact-once completion behavior.
   Qualify both native wire behavior and Cafe's interpretation.

4. **Use explicit native command dispatch.** Negotiate command invocation and
   route deliberately selected native commands to the dedicated method. Preserve
   ordinary prompt text and the native ownership/control restrictions. Make
   supported idle Axiom compaction reachable through the actual UI/orchestration
   path. Do not turn pasted prompt text into administrative authority.

5. **Restore MCP review in the composer.** Mount the existing control, capture
   the acknowledged revision for the exact account/chat/runtime/model, and keep
   direct sends, queues and revision changes coherent. A native thread with
   selected tools must have a visible way to review or change the selection and
   then send. Keep consent explicit and credentials write-only.

6. **Detect contract drift in ordinary coverage.** Replace the old synthetic
   0.1.13 assumptions with a reviewed current public contract fixture, meaningful
   compatibility/refusal cases, and an explicit update procedure. Default tests
   remain credential-free and independent of neighboring checkouts or installed
   providers. Keep isolated native qualification opt-in and cover the current
   advertised versions and the failure/command/MCP boundary.

## Dependencies and integration

- Runtime and MCP workers can implement against known current DTOs while protocol
  negotiation is being updated.
- Protocol and runtime workers agree on command feature admission and the shared
  peer's current initialization metadata. Composer command intent wiring is
  coordinated with the MCP worker before overlapping edits.
- Review exact failure/cancellation ownership, unknown feature versions, remote
  MCP entries, explicit command intent and stale MCP acknowledgements together
  before beginning validation.
- Billing v7 UI and native image-generation parity are follow-up scope; they were
  additional review observations, not part of the six assigned findings.

## Consolidated validation

Only after every worker reports implementation complete:

1. Review combined diffs against the recorded pre-existing edits. Update the
   authoritative provider guide and Axiom architecture instructions.
2. Select the repository-pinned Node and Corepack Yarn. Run CPU-heavy work at
   `nice -n 10` on macOS/Linux, retaining existing memory, worker and deadline
   bounds.
3. Run formatting, lint/audit checks, repository typechecking, the repository
   Node test graph and required browser tests as one coordinated batch. Include
   the new regression cases; report unrelated baseline failures separately.
4. Run the affected Axiom Rust checks if native code changed, followed by the
   isolated native protocol qualification with temporary roots and no credentials
   or paid inference. Never weaken authentication or evidence checks for testing.
5. Resolve failures centrally and recheck affected work. Run
   `corepack yarn build:desktop --force` as the final verification step.
6. Record actual results and remaining native-host qualification limits. A build
   does not restart the running applications or prove runtime adoption.

## Completion record

All six repairs are implemented and the three worker assignments are complete.
Workers authored regression coverage without executing checks. The coordinator
integrated explicit command intent across the shared dispatch/queue boundaries,
preserved custom first-message instructions and pending copied context, and owns
all validation and any corrections found there. Separate grouping and Keychain
work uses the coordinated shared-checkout handoffs; its later edits do not
inherit qualification from earlier input snapshots. Exact per-attempt logs,
input hashes and final gate outcomes are recorded in the coordinator's handback.
