# Decision: exact-origin MCP Apps with private replay and one-use consent

Decision status: Accepted architecture within the authorized visualization/MCP Apps feature
Created: 2026-10-13 00:56:26 JST (UTC+0900)
Last updated: 2026-10-13 02:22:03 JST (UTC+0900)
Decision authority: implementation choices delegated by the user's full-feature request; no installation, live provider/profile changes or broader native permissions.
Implementation status: configured-server Codex adapter, immutable capture, protocol and consent broker integrated; focused native preview replay passes. Complete native-platform and hosted release evidence remain separate from local integration checks.
Verification status: focused synthetic owner/broker/protocol/store checks pass; complete native-platform, packaged bridge and exact hosted release evidence remain separate pending gates.
Supersedes: None. Supplements the [foundations](agent-visualization-foundations.md) and [native execution host](agent-visualization-execution-host.md).

## Context and alternatives

A configured MCP server can return a browser UI and private original tool data.
Receiving HTML, a `ui://` URI or a tool's `readOnlyHint` does not authorize running
code or invoking another tool. A saved UI must remain inspectable after its
provider stops, without inheriting live provider authority. Model-only tools and
hosted-account targets cannot silently become globally configured server calls.

We considered a general renderer-to-MCP proxy, treating a generated page as an
App, automatically trusting read-only annotations, and installing an Apps SDK.
Those choices would enlarge authority or deployment without solving provenance.
Instead, implement the stable extension directly with existing pinned Node,
Electron and Cafe's typed owned app-server client. Shared hosting is not shared
authorization: generated pages never gain the Apps operation broker.

## Decision

1. Enable external Apps only on an actual Cafe-owned Codex transport supporting
   the required native catalogue/resource methods. Capture a successful completed
   native tool item with its exact server, tool, original call ID, native thread,
   turn, provider instance and current session/runtime generation. Root/child
   witnesses come from native correlation, not received labels or arrival order.
   Refuse account-hosted targets rather than falling back to another server.
2. Fetch only the UI URI named by that exact current tool catalogue entry. Require
   the exact expected URI, resource MIME/profile and origin-call response. Snapshot
   source, metadata, original input and completed result under the immutable
   artifact's private ownership/commitment. Ordinary history carries only compact
   safe references; no raw HTML, tool JSON, URI or producer credentials.
3. Capture admission snapshots bounded JSON synchronously, then performs bounded
   asynchronous work without holding provider event ingestion. Fixed process and
   exact-owner slots have no unbounded queue. Reobserve active SQL authority before
   and after asynchronous native I/O; replacement, deletion and disposal refuse
   stale capture/actions. Do not automatically replay a failed capture.
4. Implement the stable `2026-01-26` lifecycle: strict initialize/initialized,
   input then result replay once per actual native document, bounded ping,
   presentation context and supported inline/fullscreen changes. The private
   poster lane receives only data replay, advertises no consequential operations,
   and must observe post-replay rendering before publishing pixels. Viewer
   preparation/document IPC never includes the originals; live replay is obtained
   through the exact authenticated backend owner.
5. A live document requires actual native ticket/lease/document inspection, not
   just renderer UUIDs. Tool/resource/link/message operations use one-use explicit
   consent bound to that document, original account/server and canonical request.
   Consume consent before dispatch; freshly reobserve native liveness and current
   catalogue, app visibility, finite argument schema and resource scope immediately
   before the action. `readOnlyHint` grants nothing. No provider Always-allow or
   Cancel-turn callback is repurposed.
6. Approved messages use the normal durable chat command identity and the captured
   provider selection, runtime and interaction mode. Lost acknowledgements do not
   authorize another submission. Model context is separately bounded, replace-only
   untrusted next-turn data keyed by exact native thread; a child's context never
   becomes root context, and an update never starts inference or changes developer
   instructions.
7. Native hosting uses the existing sandboxed top-frame/independent page watchdog,
   unchanged offline request/navigation and permission policy, absolute document
   lifetime and finite nonrenewable suspension for each fresh consent operation.
   Stopping/replacing the provider preserves historical poster/source inspection
   but revokes actions. Opening history does not restart a provider.

Canonical contracts and limits live in
[`mcpApps.ts`](../../packages/contracts/src/mcpApps.ts), protocol/replay in
[`mcpAppProtocol.ts`](../../packages/shared/src/mcpAppProtocol.ts), and finite
schema validation in [`mcpAppToolSchema.ts`](../../packages/shared/src/mcpAppToolSchema.ts).
The private native transport owner and action broker are
[`owner.ts`](../../apps/server/src/mcpApps/owner.ts) and
[`service.ts`](../../apps/server/src/mcpApps/service.ts).

## Security, privacy and failure consequences

App source and received JSON are adversarial/private. Encode/decode bounds precede
whole-object serialization or parsing; cycles, accessors, unknown schema keywords,
remote references and excessive collections fail with fixed non-echoing errors.
The shared pure JSON boundary is 128 KiB actual UTF-8, depth 16 and 4096 lexical
tokens. The exact input/result notification wrappers must independently fit
before capture. A separate 270,336-byte private daemon outer envelope accounts
for escaping that same bounded inner JSON; it is not expanded App authority.
Authenticated private owner/session routes admit four operations with no queue,
2048 chunks and nonrenewable 10-second body/response guards. Ordinary RPC and
scheduling budgets remain unchanged.
Unknown or draft methods, downloads, unreviewed network origins and broad resource
reads are refused, never success-shaped stubs. Links require explicit consent and
credential-free HTTP(S) destination validation; no App-controlled filesystem save,
clipboard read, shell, native management API or general HTTP/MCP proxy is exposed.

Ordinary debug output reports bounded fixed states/counts only. Explicit owner
Source/Details reads are separate from logs/telemetry. The upstream provider may
retain original requests in its own transcript; Cafe cannot promise their erasure.
No automatic forensic upload or error toast is added. Native process retirement
uncertainty retains a quarantined slot, not a guessed replacement launch.

## Compatibility, operation and evidence

The [stable extension specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
defines protocol semantics; Cafe advertises only the implemented subset. The
typed Codex protocol provenance is immutable upstream
`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`; generated types are compatibility
evidence, not proof that a user's configured binary supports the methods.
Unsupported native calls fail closed. Claude/Grok/other external Apps and
account-hosted targets remain unavailable, not inferred from generated-page tools.

No dependencies/runtime pins, installs or OS policy changes are required. Existing
inert attachment, Mermaid, native PNG save and provider permission decisions remain
in force. Rollout uses normal rebuilt-runtime adoption, never live-session repair.
Rollback can stop new Apps capability while preserving immutable history.

The [guide](../agent-visualizations.md) records replay commands, resource accounting,
supported capabilities and limitations. Focused synthetic tests verify original
data ordering, own-server/catalogue/schema gates, replacement/deletion, stale
documents, one-use consent, explicit provider selection and child/root isolation.
Actual Electron capture/watchdog/input evidence, standalone bridge execution and
Windows/macOS/Linux hosted artifacts must be qualified separately. Acceptance of
this decision alone is not a release or universal resource/input guarantee.
