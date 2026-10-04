# Decision: durable, idle-only scheduled follow-ups

Status: Accepted; implemented with isolated regression coverage
Internal MCP connectivity is partially superseded by [automatic session-scoped scheduling tools](session-scoped-scheduling-tools.md). Durable scheduling and owner-approval decisions below remain authoritative.
Last updated: 2026-10-04 19:04:35 JST (UTC+0900)
Decision authority: user-approved same-chat scheduling for Codex, Claude, and Grok, existing visual themes, persistence and thorough verification before publishing to dev.

## Context

Scheduling belongs in Cafe's Tasks panel but must continue independently of renderer connections. Provider-native automation APIs differ; blindly injecting a prompt into an active chat can steer existing work, repeat paid requests after a crash, or inherit expanded permissions. Cafe's existing MCP credential authenticates an owner but does not attest the current chat or an explicit human scheduling request.

## Decision

The main backend owns a scoped scheduler, durable SQLite definitions and occurrence ledger. Migration 84 is schema-only and never scans or rewrites historical conversations. Contracts remain schema-only; shared recurrence and result parsing have explicit shared-package subpaths. No provider adapter timer, OS cron job, new runtime/package manager, or detached service is introduced.

Use the normal provider-neutral orchestration path with a separate server-only scheduled intent. A uniquely minted occurrence binds schedule revision, chat, command, message, and eventually exact native turn. Admission runs inside the engine's SQL event/receipt transaction. It takes the writer before validating authoritative busy state, account/profile, permission mode, and revision. Busy rejection rolls back the claim and waits; no steering fallback is allowed. A second exact pre-I/O compare-and-set checks later controls and commits an immutable attempt marker before a possible external send. Preparation uses existing provider runtime identity checks and does not change chat model defaults.

Persist the full command once before enqueueing. A lost local acknowledgement may retry only that exact command identity/payload through receipt deduplication. Only an authoritative rejected-busy receipt permits a new admission command. Once a send may have occurred, never clear its marker or replay it automatically. Reconciliation uses indexed exact pending-message/native-turn projections, not a transcript scan or a timeout on quiet model generation. Unknown submissions remain fenced until exact evidence resolves them. Terminal occurrence and schedule completion settle in one transaction.

One unfinished occurrence per schedule is enforced by a partial unique index. Indexed, bounded, fairly rotated scans prevent long-running/unknown work from starving newer schedules. Missed intervals coalesce arithmetically; calendar calculations are bounded. Calendar rules use named-zone civil-time round trips: invalid spring-forward times are skipped, repeated fall-back times occur once. UTC civil candidates avoid the pinned cron library's ambiguous zoned-next behavior.

Owner UI creates/approves schedules. Authenticated paired clients can read but cannot enable paid recurring work. MCP creates or edits proposals requiring owner confirmation and can pause; it cannot enable, resume, run, or report by public occurrence ID. Final structured result metadata is admitted only from the canonical completed assistant message for the exact occurrence, with later user controls invalidating automated quiet/finish decisions. One bounded strict parser is shared with display-only footer removal; storage is unchanged. Automatic finish additionally requires explicit owner permission and the current schedule revision.

Stop/archive/delete revocation is committed via the runtime-control ledger before ordinary provider side effects. Pause/edit/delete never terminate a running provider. Model overrides stay on the configured profile and do not alter ordinary chat defaults. Permission changes require renewed approval; the profile ID is not a guarantee that externally replaced credentials represent the same billing account.

## Persistence and lifecycle

SQLite state survives backend and renderer restarts. Timers restart only after normal orchestration startup; they are not renderer effects. Closing a window while the backend remains alive does not pause scheduling. Explicit backend shutdown and host sleep suspend execution; restarting coalesces missed work without a backlog burst. Active native turns continue under existing daemon lifecycle rules, not new scheduler process ownership. Ambiguous acceptance is never repaired by restarting a provider or replaying user content.

## Security and operational consequences

- No schedule permission can broaden normal provider permission policy. No arbitrary commands, executable names, paths, or credentials are accepted by scheduling APIs.
- Revision fencing rejects stale editors and proposals. Server-side validation bounds instructions, models/options, recurrence, history pages, and queries.
- Raw schema/SQL/provider exceptions are not returned through scheduling MCP or logged with user instructions.
- Notifications consult canonical state; failures are not hidden by a stale pre-completion run row. A bounded projection catch-up ends conservatively if evidence is missing.
- Existing color tokens and responsive Tasks/popover patterns are retained. No separate palette or always-expanded unbounded history is introduced.
- Existing live provider processes and databases are not used as test fixtures.

## Alternatives rejected

Provider-specific native schedulers would create incompatible ownership and duplicate execution paths. Renderer timers lose work on disconnection and can multiply with multiple windows. Unauthenticated result IDs or trusting an MCP tool's prose would let unrelated callers finish or silence another chat's run. Blind retries and catch-up bursts risk repeated external actions and charges. A background OS service is a separate lifecycle/installation decision, not implied by durable scheduling.

## Verification

### Renderer visibility implementation

Updated: 2026-10-05 05:54:23 JST (UTC+0900). The owner requested inline proposal visibility while explicitly retaining approval. The conversation tail now projects saved schedules with bounded pagination and pending proposals first; it does not fabricate a message/turn association. Review opens the existing Tasks editor rather than creating a second approval/mutation path. Merely displaying or opening a card cannot authorize execution.

Tasks and conversation cards subscribe to one exact environment/chat read resource. One visible, reference-counted poller coalesces reads, generation-fences manual refresh/reconnect results and retires cached instructions at the last unsubscribe. Renderer polling discovers proposals even with Tasks closed but never drives scheduling. Failed reads preserve clearly labelled last-known rows. Review uses the selected chat/account and the saved revision, and resets on ownership changes; the backend remains the final authority. Provider session, persistence and delivery decisions above are unchanged.

Qualification covers strict contracts, timezone/DST/date-line behavior, genuine SQLite persistence/concurrency/revision/control fences, exact command deduplication, all three provider dispatch paths, lost acknowledgements, preparation/Stop races, canonical outcomes and notifications, owner-vs-paired RPC, real in-memory MCP transport, renderer reopening, responsive browser controls, and preservation of chat defaults/themes.

Required release gates: `yarn fmt`, `yarn lint`, `yarn typecheck`, `yarn test`, browser qualification, then `yarn build:desktop --force` last on the pinned standalone Node/Corepack Yarn runtime. Verify the exact published commit in hosted CI; synthetic tests do not claim live provider inference or execution while the host is asleep.
