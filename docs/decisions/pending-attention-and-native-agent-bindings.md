# Pending attention and current native agent bindings

Status: accepted

Last updated: 2026-11-09

The shell's pending-decision counts describe the whole chat. The ordinary
500-activity detail window must therefore retain unresolved approval and question
requests independently of recent tool traffic. A completed root, a click, an old
timestamp or a quiet transcript does not prove that a provider callback ended.
Keep its exact request payload and existing native-owner authorization. Never
answer a request merely to test whether it is still pending.

The detail query and live store retain up to 64 additional pending identities,
with independent approval and question namespaces. They also retain each selected
identity's latest terminal witness. A request still in the ordinary window keeps
its exact terminal witness too: a legacy equal-clock resolution can sort before
the request in the history cursor while settling it in the interaction fold.
The ordinary window and history cursor order remain unchanged. Known sequences
outrank unsequenced legacy records, then clock, resolution tie rank and BINARY
identity ordering settle lifecycle ties. Ordinary response errors do not settle a
request; only the existing channel-specific stale/unknown cases do.

`pendingRequestRetentionTruncated` reports an actual pending payload omitted from
the ordinary window and additional budget. It is display-only and optional for
legacy peers. A live client that has lost a payload cannot infer completeness
from the remaining subset; a new authoritative detail snapshot can clear the
warning. Indexed request-kind candidates avoid ordinary tool-history reads, but
the SQL still inspects that chat's request history; the extra payload budget is
not a claim of constant historical query work.

Claude and Codex can explicitly start the same native child/task under a newer
root turn within one native runtime. Per-turn lifecycle history and capabilities
remain immutable. For current counts and the active roster, a fully bound
`task.started` with exact task/child identity selects the current owning turn.
Only that turn's head supplies current liveness. A later old-turn progress,
completion or ambient edge cannot retire or revive the new owner. Retain the
start pointer separately from the live head, including after head invalidation.
Unbound legacy progress, generic task controls and tool item IDs retain their
existing turn namespaces. Runtime replacement, task-generation checks, history
authorization and individual Stop/background controls remain unchanged.

Ingestion validates the exact encoded start once and maintains one private
`projection_native_agent_bindings` row per native task slot, atomically with the
activity and live-work projections. Progress reads check only that source witness
inside SQLite; they do not rehydrate historical start payloads. Migration 105
backfills normalized start pointers and separately indexed legacy NULL-turn
starts in keyset pages of 64 with a native event-loop opportunity between pages.
The older normalized lifecycle table excluded NULL-turn rows, so relying on it
alone could restore an obsolete turn-bound owner. Working memory and each additional witness are bounded
(1 MiB per witness); total one-time migration work depends on existing pointers.
Oversized or malformed evidence does not acquire a binding. Source mutation or
deletion invalidates its proof while retaining the owner/order watermark, so a
late older start cannot refill the slot. Invalid means unknown liveness, never a
synthetic completion. Exact fully qualified owner revalidation or a newer admitted
start can renew proof. Hard deletion purges the projection and fences resurrection
even on the supported foreign-key-disabled purge path.

Detail retains additional native start witnesses only for identities selected by
the existing bounded history lanes and active owners. Each selected start keeps
its exact owning head, including a descriptor-free completion, so retaining a
start cannot revive finished work. Inactive, unselected bindings remain private
metadata and do not trigger historical payload comparisons or output. Missing
owner-head sources are unconfirmed, including when no other worker remains.
Total metadata work still depends on the stored binding count.

The Task Atrium keeps full historical rows and their exact detail/control identities,
but derives running membership from the same current-owner and source-hint policy
as the composer. Its bounded input must include descriptor-free terminal edges.
Exact-current-runtime zero counts can suppress stale running claims without
inventing completion or deleting history. Include the immutable live-work object
in its cache identity: shell-only hint changes must retire stale membership while
clock-only updates can still reuse it.

The current-runtime shell also carries at most 64 `unconfirmedAgentIds` display
hints after source retirement. The active roster applies them only to that exact
runtime, so an older retained start cannot reappear while an independent worker
is still live. Hint changes invalidate the summary even when counts are equal.
Overflow is explicit; the client withholds that runtime's unconfirmed roster and
shows an unavailable-status notice. Neither hints nor a zero count manufacture a
terminal history event, settle a request or authorize provider recovery/control.
Fully qualified inter-root rows without a parent turn remain read-only: they
retain runtime-scoped display identity and cannot borrow history or control
capabilities from a turn-owned incarnation.

Attention animation effects must follow the exact engine instance they own.
When settings replace that instance, reapply current focused/aggregate attention
state and retire the original polling/ring timer. Replacement must not replay
historical pulses. Owner-state regressions cover this without asserting transient
pixels or decorative animation timing.

Claude's structured permission and AskUserQuestion callbacks await their own
decisions. Ordinary assistant prose is not a native question callback, and
independently admitted background work may continue. The pinned SDK 0.3.314 and
the reviewed CLI 2.1.316 release retain this contract; this change does not alter
question cadence, prompts or native provider installations. See the official
[SDK user-input documentation](https://code.claude.com/docs/en/agent-sdk/user-input),
[subagent documentation](https://code.claude.com/docs/en/sub-agents) and
[2.1.316 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.316).

Selected permission policy is intent, not proof of native adoption. A turn-start
projection can already contain the requested value before the live owner changes;
the reactor must also compare the actual selected provider session. Normal
automatic approvals happen upstream, but explicit and native confirmation paths
can still reach Claude's `canUseTool` callback in Bypass mode, including one-time
shell confirmations in SDK 0.3.318.

Cafe's explicit Bypass selection also approves these individual action callbacks
after the exact live query has independently established its primary native
init owner and adopted the current Bypass intent. A cached full-access label,
pre-init status, foreign/child frame or old query cannot grant adoption. An exact
native setter acknowledgement can adopt its own intent, unless a newer native
mode observation has arrived. Withdraw automatic permission before mode-change
IO and synchronously on an admitted native downgrade; bind observations and
acknowledgements to their captured intent so delayed work cannot authorize a
later Bypass selection or a replacement query.

Automatic approval returns only the unchanged input for that one call. It never
echoes suggested rules or writes persistent permission settings, including when
`suppressAlwaysAllowRule` or `defaultToNo` accompanies the callback. A matched
explicit `permissions.ask` rule still requires the user's decision. Unknown or
unadopted modes retain the ordinary approval panel and its one-time/default-
decline restrictions. The panel's fixed explanation reports only the received
restriction, not an unrecorded native reason. `AskUserQuestion` still awaits real
answers, and `ExitPlanMode` retains Cafe's separate plan-review flow. Native
denials and hooks that do not reach this callback remain upstream decisions.

Synthetic adapter tests qualify action approval, unchanged input/no rule writes,
mode adoption, retirement and the retained human-input routes. They do not prove
adoption by an already running backend or exercise real provider inference.
See [Claude permission evaluation](https://code.claude.com/docs/en/agent-sdk/permissions).
