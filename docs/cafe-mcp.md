# Cafe Code MCP

## Management tools in Cafe chats

**Settings → Cafe tools → Enable Cafe management tools** controls the backend-authoritative management endpoint. It remains enabled by default. Off rejects new management requests immediately; accepted work may finish. Only an owner connection can change it. Scheduling and visualizations retain their separate credentials, permissions and approval rules.

Cafe supplies management MCP at launch to Codex, Claude, Grok, and local OpenCode chats it owns, including explicit account homes. There is no install/remove UI or registration RPC. Ordinary provider sessions started outside Cafe do not gain a connection. Existing Cafe sessions adopt changes through their normal stop/resume lifecycle; this change does not restart a running provider.

Codex receives a private stdio server through the existing structured app-server configuration override. Claude receives the same private stdio specification through SDK query options, preserving user/project sources and permission callbacks. Local OpenCode receives a runtime-only inline configuration override in its Cafe-owned child process. Configured external OpenCode servers are unchanged. Grok retains its existing session-scoped authenticated ACP HTTP connection. Axiom remains unavailable until its native session MCP ownership/revision contract is implemented.

Management tools have owner authority over Cafe projects, chats, providers and settings. Cafe adds no management approval prompt and does not modify provider approval policy. This is broader than scheduling's proposal/list/pause capability; enabling management never approves a recurring task.

## Management contract v2

The management server advertises version `2.0.0`. Existing action names and
exact-ID targeting remain. Discovery defaults are now bounded and provider
discovery is compact; clients which previously assumed complete inventories
must follow pagination. All structured management results, including question
details and receipts, have an identical JSON text fallback for clients which
only deliver text to the model. Public failures contain a finite `error` object
with `code`, `message`, `nextAction` and `mayHaveApplied`; native/SQL errors and
submitted settings are not echoed.

Start with `get_cafe_context({})` on a Cafe-issued connection. It returns the
signed launch Cafe chat's metadata, project/workspace and separate configured
and projected-session provider IDs without loading transcripts, enumerating
providers or opening a native session. Manual/legacy connections pass an
explicit `threadId`. Inherited subagents still identify the launch Cafe chat.
The context is recorded projection/launch information, not native adoption or
liveness proof, and never follows the currently selected UI window.

Tool history presents recognized Cafe management invocations as actions such as
“Viewed Cafe Code threads” or “Checked Cafe Code context and quota.” Running and
failed calls retain their observed lifecycle wording. Native callback answers
and asynchronous restarts say “Submitted”/“Requested”; a tool acknowledgement
never becomes provider consumption or restart-completion proof. The compact row
hides the random server suffix and argument IDs; hover details retain the exact
invocation. This presentation also applies to retained history with invocation
metadata, without rewriting events, native tool names or operation identities.
Unknown/foreign tools keep their existing presentation. Name recognition is
display formatting only and grants no server trust or management authority.

Only discover IDs that are missing:

- `list_projects` supports title `query`, exact `workspaceRoot`, `limit` and
  `cursor`, plus its existing `includeDeleted` option.
- `list_threads` supports title `query`, `projectId`, lifecycle `state`, provider
  `status`, `limit` and `cursor`. Duplicate titles remain distinct candidates
  with stable IDs; mutations never resolve a title or choose a fuzzy match.
- `get_project` defaults to an active-chat page and accepts the same title and
  lifecycle filters, including explicit `state: "all"`.
- `list_providers` supports `query` and exact `instanceId` and omits model
  catalogs by default. `modelCount`/`modelsIncluded` make that omission explicit.
  `includeModels: true` returns at most 100 models per provider and sets
  `modelsTruncated` when necessary.
- `list_provider_models` reads one instance's model page. Search matches model
  name or slug; `includeOptions: true` adds its capability/option descriptors.
  It never refreshes an account or makes a model request.

Discovery pages default to 20 entries, allow 1–100, and return `hasMore`,
`nextCursor` and the current `totalMatches`. Copy the cursor unchanged and
retain the same filters. Stable-ID keysets tolerate edits/deletions without
offset shifts; these are live reads, not a frozen snapshot. A foreign/malformed
cursor is refused. Complete JSON results have a 4 MiB ceiling; request smaller
pages/options when a complete response cannot fit.

### Thread groups and origin

Coordinators can keep worker chats out of the top-level sidebar by creating a
named group beneath a parent Cafe chat and creating workers in it:

1. `create_thread_group({ title, description? })` — the owner defaults to the
   signed launch chat; manual connections pass `ownerThreadId`. A parent may
   own up to 128 live groups; membership is unlimited and there is no worker or
   concurrency cap.
2. `create_thread({ ..., groupId, description? })` for each worker.
3. `list_threads({ groupId })` to find members, then `get_thread_status` /
   `wait_for_thread` on exact IDs. `get_cafe_context.ownedGroups` returns the
   first page of the launch chat's groups; continue with
   `list_thread_groups({ ownerThreadId, cursor: nextCursor })`.
4. `delete_thread_group({ groupId })` moves the group, every member and every
   nested group to the Recycle Bin and keeps the parent. Active members get a
   stop request; the result says `recorded`, not stopped.
   `restore_thread_group` restores only that group's subtree deleted with it.

Thread summaries include `groupId`, the editable `origin` label (Human / Agent /
Unknown and whether a person set it), the separate recorded `provenance`
(`creationPath`, `originThreadId`, `recordedAt`; `null` when unrecorded) and an
optional `description`. Callers cannot set provenance. A signed launch claim
records the Cafe chat that made the call, not a native subagent; a manual owner
client records `mcp-owner-client`. `update_thread({ description })` edits the
description; only people change the origin label. None of these fields grants
permission, native ownership or retry authority.

For a tracked `create_thread`/`create_thread_group`, `get_operation` returns
`plannedTargets` naming the exact ID the reserved action creates. Finding it
confirms the action. Not finding it at one moment is **not** proof the
original, possibly delayed action cannot still create it, and never authorizes
a replacement request or replay. See
[the decision](decisions/thread-groups-and-origin.md).

### Settings patches and hidden values

`get_provider_settings` returns redacted settings plus the built-in driver's
finite JSON `configSchema` when conversion is supported (`null` otherwise).
`set_provider_settings` prepares its patch from the latest settings under the
same settings writer used by ordinary updates. Its `completed` phase means the
settings were saved, not that a running provider adopted them.

Environment entries patch exact names; unmentioned names remain. Missing,
empty or redacted values preserve an existing sensitive value. A copied
`valueRedacted: true` can only preserve an existing sensitive variable; it
cannot install a secret or change its classification. Supply a nonempty
explicit value to replace a secret. Use `{ "name": "API_KEY", "clear": true }`
or `clearEnvironment: ["API_KEY"]` to remove one. Duplicate or contradictory
updates are refused before saving. An empty environment array is an empty
patch, not permission to clear all credentials.

`config` is a shallow field patch. `clearConfigKeys` removes exact keys;
`replaceConfig: true` explicitly replaces other config fields. OpenCode's saved
server password remains protected by its existing redaction witness even on
replacement: clear `serverPassword` explicitly to remove it. Ordinary settings
writes, profile selection, native permissions and provider adoption policies
retain their existing paths.

### Status and bounded waiting

`get_thread_status` reads a lightweight shell and returns pending approval/input
flags, a safe failure flag, current live task/agent counts, root-turn state,
`waitingFor`, `rootComplete`, `wholeChatIdle`, `observedAt` and an opaque
`observationToken`. The same database read transaction includes the exact
`pendingTurnStart` message ID/time; a recorded but not yet started input is not
reported as an idle chat. Root completion can coexist with current live children.
Unconfirmed child-retirement hints do not establish an idle whole chat. No raw
provider failure, transcript, native probe or ownership renewal is returned.

Pass the exact token to `wait_for_thread` with the same `threadId` and optionally
the exact `turnId`. It returns `changed`, `attention`, `turn-changed` or `timeout`.
The requested wait defaults to 20 seconds and is capped at 25 seconds; the
elapsed budget uses the monotonic clock. At most eight waits are admitted across
stateless management requests in a backend. Cancellation/failure releases that
exact admission; excess calls fail rather than queue without bound. A timeout
is an observation result and does not prove completion or authorize a retry.

`get_thread` remains available for message content. `messageLimit: 0` reads only
the shell and reports `hasMoreMessages: null` because messages were not queried.
Positive limits select at most 100 recent rows directly without hydrating
plans, checkpoints, attachments or tool activity. Individual text above 64 KiB
or text exceeding the cumulative 1 MiB encoded-message budget is returned as
empty with `textOmitted: true` and `omittedMessageTexts`; it is never presented
as complete truncated wording. `hasMoreMessages` describes older rows beyond
the inspected tail, not omitted text within it.

### Action receipts and lost acknowledgements

Management mutations accept an optional UUID `requestId`. Generate and retain
one **before** an action when its acknowledgement may need reconciliation.
Successful actions return `phase` plus an `operation` reference on the
authenticated endpoint. The server reserves the exact bearer-session/request
tuple durably **before** calling the action and binds it to the tool and a
canonical digest of its arguments, including the exact target. Argument object
key order does not create a new intent. Changed tools/arguments under the same
ID are refused. A repeated known successful intent returns its stored receipt;
unconfirmed/failed attempts remain reserved and are never executed again.
If the action returns its own receipt but settling the management journal fails,
the response retains that action result with `operation.state: "unconfirmed"`.
Journal failure does not change a known action result into an execution failure
or permit another execution.

Use `get_operation({ "requestId": "the-retained-uuid" })` to reconcile:

| State         | Evidence                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------- |
| `unconfirmed` | Reserved attempt; execution/settlement may be in progress or interrupted.                     |
| `recorded`    | Durable orchestration intent; no native consumption or finished-work proof.                   |
| `scheduled`   | Restart acknowledged before its asynchronous teardown.                                        |
| `completed`   | Settings saved, or the restart policy operation returned; resumed turns can still be running. |
| `failed`      | The attempt failed; partial effects remain possible and the ID stays consumed.                |

Question responses retain their stronger `resolution` distinction: recorded
callback intent and an operation receipt do not confirm native consumption or
create a primary-chat settlement notice. Native settlement still requires the
original exact request/session ownership. Scheduling retains its separate
proposal/revision/owner-approval protocol and does not gain these mutation IDs.

Tracking is scoped to the **exact bearer session**, with an opaque `scopeId` and
credential `expiresAt`. Rotation/reissuance changes the scope; a missing receipt
in another scope never proves an earlier action did not run. A missing or
uncertain receipt must not trigger automatic replay. Authentication/revocation
remain authoritative independently of these read-only receipts.

The SQLite ledger retains at most 10,000 unexpired receipts, each at most 64 KiB.
Capacity refusal starts no new action and never evicts live deduplication
evidence; expired credential namespaces can be pruned on admission. Stored data
is limited to hashed scope/intent, tool, timestamps, public result identifiers
and fixed errors. Prompts, answers, config/environment values and raw native
failures are not copied into this ledger. Interrupted attempts stay unconfirmed
rather than being reconstructed as successful or automatically resubmitted.

## Context and quota status

Use `get_thread_usage` to check remaining context and provider quota without
loading messages or starting a provider request:

```json
{ "threadId": "the-cafe-thread-id" }
```

Cafe-issued management connections may omit `threadId` to use their signed
launch chat. External/manual and legacy connections must pass it explicitly.
An inherited subagent connection still identifies the launch **Cafe chat**;
it does not identify the child's independent native context window. An owner
may request another Cafe chat explicitly, as with the other management reads.

The response contains three separate records:

- `target` identifies the selected Cafe chat. `launchMatchesSession` compares
  launch intent with the projected provider instance when both are known;
  it is not a native-generation or liveness proof.
- `context` reports last-observed tokens, native capacity when available,
  remaining tokens/percentage, processed tokens and reported compaction
  settings. `observedAt` dates that report. Historical reports lack native
  owner attribution and remain labelled `ownerAttribution: "not-recorded"`,
  including after an account switch. Native token totals already include
  reasoning; the tool does not add it again or expose Codex's hidden internal
  compaction estimate. Saved context overrides do not replace reported capacity.
- `quota` reports cached account-shared allowance for `providerInstanceId`,
  including separate exact limit buckets, primary/secondary percentages and
  native durations, reset timestamps in **epoch seconds**, credit balance and
  the authoritative available reset count. This is not a per-chat token budget.
  Multiple chats using the same provider account share it. `checkedAt` dates
  the cached account snapshot; retained individual windows may be older.

Missing readings are `null`/`unknown`, not zero or unlimited. A reset-only
window retains its reset time while its remaining percentage stays unknown.
Credit balances remain provider strings without an inferred currency. Up to
128 limit buckets are returned with an explicit `truncated` flag. The exact
legacy view uses the existing `codex` bucket key when no limit ID was reported;
that compatibility key alone does not identify a model-specific allowance. The
projected session instance takes precedence over a configured next-turn
selection; a legacy session without that instance is labelled `configured`.
Providers without cached account quota return unknown rather than triggering
a native probe or borrowing another chat's passive report.

These are passive reads of projection metadata and the provider registry.
They do not refresh account state, enumerate native sessions, renew runtime
ownership, run inference, or return authentication details or transcripts.
The context lookup uses a dedicated partial ordering index and hydrates one
context activity, independently of the chat's recent tool-activity cap.
Existing `get_thread` clients may use `messageLimit: 0` for an empty message
list; `get_thread_usage` is the dedicated usage-only interface.

The default target is taken only from an internally issued signed launch
claim on the verified bearer session. Subject strings, cookies, client labels,
query parameters and extra thread headers cannot choose it. Existing manually
issued owner tokens retain explicit-target access. See
[the resource-status decision](decisions/mcp-thread-resource-status.md).

## Pending questions and answers

The owner-authorized management connection provides five question tools. Each
requires an explicit Cafe `threadId`; these tools do not infer a native child
thread or use the currently selected window.

| Tool                     | Behavior                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `list_thread_questions`  | List current native callback requests and one page of saved inline questions, without question wording. |
| `get_thread_question`    | Read the complete questionnaire or selected inline question, including every available option.          |
| `answer_thread_question` | Submit a complete native response, or durably record an inline answer as an ordinary chat message.      |
| `skip_thread_question`   | Explicitly skip the selected inline question, or every question in a supported native callback.         |
| `clear_thread_question`  | Explicitly dismiss the selected inline question, or every question in a supported native callback.      |

Start with `list_thread_questions`, then copy its exact `target` to
`get_thread_question`. Callback targets contain `kind: "callback"`, the opaque
`requestId` and its exact `createdAt`; inline targets contain `kind: "async"`,
the saved `activityId` and zero-based `questionIndex`. Preserve these values
unchanged. A reused ID with a different creation time is another callback
incarnation, not permission to answer the original one.

The list's `limit` is 1–64 **inline activity records**, default 20; one activity
can contain several questions. `asyncPendingQuestionCount` counts only the
current page. Native requests repeat on every page. Follow `nextCursor` while
`hasMore` is true, deduplicating repeated native targets. Pagination uses the
immutable creation-time/activity-ID tuple, so marking an inline question
handled does not move it across a cursor. Unreadable, oversized or unsupported
records remain explicit omission/availability evidence. An empty incomplete
view reports `hasPendingQuestions: null`; only a complete first-page view can
report `false`. Do not interpret a page count, a missing card, or a truncated
native-retention budget as proof that the entire chat has no questions.

For a callback, `answer_thread_question` takes an `answers` map keyed by the
exact question IDs. Values are nonempty text or text arrays. Every question
must occur exactly once across `answers` and any `unanswered` map. Explicit
`"skipped"` or `"dismissed"` dispositions require the callback's advertised
unanswered capability. `canAnswer`, `canSkip`, `canClear` and
`unsupportedReason` explain availability; an absent capability never means
support. Provider-specific interaction forms and malformed/duplicate question
IDs are not treated as ordinary questionnaires. Permission approvals remain
separate: none of these tools approves a command or changes provider policy.

For an inline question, use the single `answer` text field. Cafe rechecks the
exact saved question under its database writer and atomically records the
quoted question/answer message, ordinary start-or-steer intent, handled index,
and primary-chat notice. Skip and clear record handling plus a notice without
starting a turn or supplying an invented answer. Neither operation deletes
chat history. A stale, already handled, malformed or foreign question is
refused; concurrent callers cannot consume the same question twice.

Mutation receipts distinguish `resolution: "recorded"` for durable inline
handling from `resolution: "provider-confirmation-required"` for a queued
native callback response. `accepted: true` and a dispatch sequence do **not**
prove native resolution, provider submission or completed work. Native
responses retain their exact provider/session ownership and require canonical
callback settlement. A native method returning or an ordinary response-failed
activity alone is not settlement. Re-read pending questions after confirmation;
never automatically retry an uncertain mutation response.

Successful MCP handling appears as normal primary-chat content identifying
that the question was resolved through MCP and showing the exact question and
submitted answer, skip, or dismissal. It is not hidden solely in the work log
and is not inserted into the provider's model conversation as a system
message. Native notices appear only after actual canonical settlement; inline
notices share the answer/handling transaction. Native dispatch receipts do not
guarantee a later notice across backend interruption: uncertain correlation
is not reconstructed from a matching answer or saved intent. Reconcile the
current callback state rather than treating that receipt as resolution.
Additional notice retention is limited to the newest prefix of at most 64
eligible notices and 1 MiB of encoded payload beyond the ordinary activity
tail. A large receipt can exhaust the byte budget before 64 notices; this
does not promise unlimited visible history or erase pending callbacks.

Reads use a dedicated question context: thread metadata plus the existing
bounded native pending-attention projection, without hydrating messages,
plans or checkpoints. Indexed inline pages and exact saved-activity lookups
reach questions older than the recent tool tail. Full question details are
bounded and refused rather than silently truncated. Fixed public errors do
not expose native errors, database details, credentials or unrelated chat
content. Listing or reading never starts a provider, refreshes credentials,
answers a callback or invokes paid inference. See
[the pending-question decision](decisions/mcp-pending-questions.md).

## External MCP clients

External clients can connect to Cafe's authenticated Streamable HTTP endpoint at
`/mcp` on the Web UI's origin. The management toggle above also controls this
endpoint. An owner client can inspect projects, chats, and providers; manage
projects and chats; send or interrupt work; update redacted provider settings;
and request provider restarts. The resume restart variant records the exact
active chats and submits durable continuation messages after that provider
restarts. Restart acknowledgements precede shutdown.

Issue a dedicated owner bearer session against the **same configured Cafe root
and explicit data profile as the running backend**. Source desktop and repository
development launches use Debug; installed releases use Production even with
diagnostic logging enabled. Direct standalone CLI commands retain their existing
defaults unless a profile is explicit. See [data profiles](data-profiles.md).

For a source Debug desktop, from the repository root:

```bash
node apps/server/src/bin.ts auth session issue --data-profile debug --role owner --label cafe-mcp --ttl 30d --token-only
```

Use `--data-profile production` when administering Production. If the backend
uses a custom configured parent, pass that same `--base-dir /chosen/cafe-root`
or inherit its configured `CAFE_CODE_HOME`; do not append `.debug` yourself.
Preserve any explicit development-URL selection used by that backend, rather
than adding `--dev-url` merely because the code was built from source. Where
the `cafe-code` CLI is available it accepts the same auth options; installing
an older registry package is unnecessary.

Connect to the actual backend origin with `/mcp`: packaged Production normally
uses `http://127.0.0.1:3773/mcp` and source Debug normally uses
`http://127.0.0.1:13773/mcp`. Use the origin printed by the runner if it differs;
the Vite frontend port is not the backend MCP port. Use HTTPS for non-loopback
connections. Send the credential only as `Authorization: Bearer <token>`; keep
it out of URLs, prompts, logs and source-controlled configuration.

List and revoke sessions using the same root and profile:

```bash
node apps/server/src/bin.ts auth session list --data-profile debug
node apps/server/src/bin.ts auth session revoke <session-id> --data-profile debug
```

Replace the profile and retain the same root/development selection when
administering another backend. Owner credentials grant management authority;
they are separate from the narrow scheduling and visualization credentials below.

## Separate scheduling and visualization connections

Cafe automatically gives each Codex, Claude and Grok session a private, chat-and-account-bound connection for proposing, listing and pausing follow-ups. Separate account profiles/custom homes are supported without editing saved MCP configuration. Review proposals and the paying account in **Tasks → Scheduled**, then choose **Approve & enable**. Switching accounts requires renewed review. These narrow tools remain independent of the management toggle. See [scheduled follow-ups](scheduled-followups.md) and [session authority](decisions/session-scoped-scheduling-tools.md).

When a local desktop host is available and the actual launch mode is Full access, Cafe-owned Codex and Claude sessions
receive a **separate session-only** `visualization-mcp-bridge.mjs` connection for
`publish_visualization`. It is not the management
connection or scheduling audience and does not edit provider profiles or approval
policies. Exact active chat/account/native generation and completed native-call
proofs govern publication; Grok is not enabled without equivalent provenance.
Current persisted thread Full access is rechecked before publication and source
loading. No preview execution or poster is required. Ordinary unsandboxed
same-origin frames run in chat while visible and can access parent authority;
Full access is the required risk boundary, not proof of trustworthy code.
Existing sessions require normal rebuilt-runtime adoption rather than a live
retrofit. Codex external Apps retain exact configured-origin/one-use consent. See
[agent visualizations and their current qualification limits](agent-visualizations.md).

## Credentials and compatibility retirement

Each new stdio connection uses a server-minted private temporary directory, a copied independent bridge bundle, and a private connection file. The native Cafe executable runs in Node mode with structured argv. Tokens appear only in the private file and authenticated HTTP headers, never argv, provider configuration, native event logs or UI feedback. Windows retains user-owned inherited ACLs; POSIX systems retain private modes and owner checks.

The provider's session scope owns credential revocation, refresh and exact-file cleanup, including failed startup. Credentials last 30 days and refresh daily within seven days of expiry. Refresh first verifies the current credential; owner revocation is never repaired in the background. Ending a session revokes all of its issued credentials, including a token rotated while a request was in flight, without revoking another session. Uncertain namespace cleanup preserves replacement files while retiring authority. Grok retains its existing 24-hour credential and scope cleanup.

The bridge rereads its connection on every call, uses only the exact authenticated loopback endpoint, rejects redirects, and never retries a mutation automatically. A lost response may mean work completed. Input and output are bounded to 16 MiB with four requests in flight. Native MCP image results remain supported.

On desktop upgrade, Cafe recognizes its old private connection and retires matching legacy registrations from the previous default profile locations. This is removal-only compatibility code. It compares original bytes before writing, preserves unrelated settings/comments/full-range TOML values, and refuses malformed, unsafe or conflicting entries. The HTTP endpoint rejects the old installer credential subject regardless of whether a registration can safely be removed. The old installer/renewal path cannot issue new credentials. Custom account authentication selection is unchanged; see [Claude authentication selection](claude-authentication.md).

## Qualification

Credential-free tests cover private publication, independent session cleanup, missing assets, rotation/revocation, namespace replacement, exact legacy registration retirement, configuration preservation, bounds, cancellation, image results, and endpoint access checks. Provider launch fixtures verify structured overrides without starting a provider or reading a real provider profile. Browser fixtures verify automatic-connection copy, owner/remote toggle authority, retained translated failures and absence of installation controls. This is source/isolated-runtime evidence, not live provider or native Windows qualification.

The standalone artifact test is opt-in because it launches a real Electron process. It copies each built bridge alone into a private empty directory, then verifies initialization, discovery, text/image results and exact audience/endpoint refusal. This catches uncopied sibling chunks. Quality jobs run it after building with a local fixture server and temporary credentials, without provider accounts:

```sh
corepack yarn workspace @cafeai/cafe-code build:bundle
CAFE_CODE_MCP_BRIDGE_E2E=1 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/CafeMcpBridge.e2e.test.ts
corepack yarn workspace @cafecode/web test:browser src/components/settings/SettingsPanels.browser.tsx src/components/settings/McpSettings.browser.tsx
```

For packaged qualification, set `CAFE_CODE_MCP_BRIDGE_DIR` to the extracted entrypoint directory and `CAFE_CODE_MCP_BRIDGE_EXECUTABLE` to the exact native executable or AppImage. Keep the bridge entrypoints independent single-file bundles with code splitting disabled.

Repository verification remains `yarn fmt`, `yarn lint`, `yarn typecheck`, and `yarn test`, followed by `yarn build:desktop --force` as the final check, using the pinned Yarn through Corepack.
