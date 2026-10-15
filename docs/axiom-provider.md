# Axiom provider

Cafe connects to a separately installed native AxiomCLI using
`axiomcli acp --frontend desktop-chat` for new interactive chats. AxiomCLI owns account credentials, its account-local
native conversation history, tool policy, provider encryption and cryptographic
attestation/reply verification. Cafe owns the provider instance, child process
scope, conversation presentation, approvals and its own local history.

## Configure and sign in

In Settings → Providers, add an **Axiom** account. Leave Binary path empty to use
`axiomcli` from the backend's PATH, or select the native executable. On macOS,
the Axiom application bundles it at
`/Applications/Axiom.app/Contents/Resources/bin/axiomcli`; the installer can link
it as `/usr/local/bin/axiomcli`. A Windows configuration requires a native
executable, not a batch shim.

The instance is stored in `providerInstances`, rather than adding a legacy
`providers.axiom` mirror. Existing installations therefore do not automatically
probe or enable a new provider. Provider entries can have separate presentation,
environments, models and processes; entries using the same native Axiom profile
share that profile's account credentials. Cafe does not create shadow auth homes.

Use **Log In** when native account status requires it. Cafe first checks the
native account; an already valid account simply refreshes provider status without
creating a second login or closing its conversations. Temporary account-check
failures are reported as unknown availability, not as signed-out accounts.
For a signed-out or expired account, Cafe starts native browser sign-in under a
provider-owned temporary process scope. Desktop-chat delegates browser opening
to Cafe, which admits only the configured authentication origin and exact native
authorization route. Tokens, the authorization URL and private login handle stay
in AxiomCLI/the server, never the renderer, diagnostics or command ledger.
Completion refreshes provider status. Close this account's Cafe sessions before
changing its native sign-in. Signing in through the installed Axiom application
and refreshing the provider is also supported. Provider warnings remain inside
the chat column so that the docked Tasks panel retains its full height.

Select Axiom and a discovered model in the composer. Model selectors show the
native short model name, without a hosting-provider prefix. Thinking choices
come from the native catalog and are applied with the `thinking` configuration
option. Cafe exposes a concrete default: Medium when supported, otherwise
Enabled, then the first native choice. Explicit choices remain selected.
Discovery supports a bounded model-only refresh, without creating a chat or
running inference. Read-only account credit is optional when the native billing
contract is available; integer microUSD is displayed without decimal rounding.

## Supported session behavior

- ACP create/load, streamed text/reasoning, tool progress/diffs, plans and
  native command discovery use Cafe's existing orchestration and work log.
- Desktop startup negotiates bootstrap and Agent support, creates the thread
  under Axiom's desktop chat root, then binds its Agent to Cafe's admitted project
  directory before accepting a prompt. The process itself launches in the Cafe
  project. Native thread IDs and account ownership stay with Axiom.
- Supervised access enables Agent with `approve_commands`; Full access enables
  Agent with `full_access`. Plan interaction disables Agent: desktop mode has no
  Observe/read-only local tool profile, so planning uses supplied context and
  conversation history without local tools. Auto-accept edits retains command
  approval. These are native tool policies,
  not a claim of equivalent OS sandboxing on macOS, Windows and Linux.
- Approval replies select the exact offered option identifier. Session approval
  selects only `allow_exact_session`, never a guessed prefix grant. Cancel uses
  ACP cancellation and clears pending approvals/questions.
- Typed form questions support text, single choices and multiple choices.
  Answers remain bound to the pending native session/request and its offered
  schema. URL elicitation and client-owned terminals/filesystems are not advertised.
- Original images/files travel through Axiom attachment v2. Native limits are
  eight attachments, 5 MiB per image, 10 MiB per file and 16 MiB combined, also
  subject to Cafe's limits and the selected model's image/MIME capabilities.
  Files use exact Cafe chat ownership, metadata, size and digest admission;
  document extraction is not substituted for native file bytes.
- Stop sends native cancellation before retiring prompt ownership. Prompt
  generation has no Cafe silence deadline. Startup/control reads are bounded.
- A native process exit settles active work, releases pending interactions and
  leaves the durable account-bound resume cursor available for recovery.
  Loading never silently starts an unrelated native conversation.
- Desktop Agent configuration uses its native revision fence. Unchanged settings
  are read and validated without reconfiguring or clearing session approvals.
  Prompts and steering carry the exact approved Agent revision. A changed native
  revision or unexpected workspace receipt fails before a new prompt is admitted.
- Resume cursors bind native session ID and a private account commitment, with
  bounded native-to-Cafe turn associations for explicit native history reads.
  Wrong-account resume fails before loading history. Desktop v2 cursors additionally
  retain the exact native working-directory spelling and Agent revision for load.
- Web search is a globe toggle inside the composer, immediately to the right of
  the thinking control. Each new chat starts off; the setting stays on across
  sends, queueing and reloads until turned off in that chat. Account changes clear
  it, and it is never inherited by another chat. Queue entries retain their exact
  setting independently of later toggle changes through editing, claims
  and reload. Native prompts receive explicit `webEnabled` plus Agent revision.
  A steer must match the active turn's web setting; changed consent is queued for
  the next turn. This toggle does not stop web work already admitted by a turn.
- Native steering binds the exact active turn and stable message correlation;
  steering is text-only and limited to 64 KiB. Manual compaction uses the native
  extension and requires idle work.
- Context use is the native replacement report from a completed request, with
  its reported capacity. It is not a draft estimate or an invented billing total.
- The composer tab contains verification, without an MCP management control.
  Native MCP configuration remains in Axiom. Cafe's backend retains its scoped
  MCP protocol and revision checks; resources, prompts and MCP Apps are not
  advertised by that tool-only interface.
- MCP mutations require the exact idle account/runtime/thread/configuration and
  native revision. Secrets are write-only: blank preserves existing environment
  values, while an empty object clears them. Native credential identifiers and
  environment values are excluded from returned state. Failed/lost control
  acknowledgements are never automatically replayed. Test initializes the
  selected server and discovers its tools; it does not run model inference.
- Each ordinary message captures the reviewed MCP revision, including queue
  save/edit/claim/reload and retry paths. Prompts carry that revision and the
  native runtime rejects changed executable/tool configuration. A conversation
  with selected tools requires an explicitly reviewed revision; missing review
  fails closed. Plan prompts omit MCP configuration entirely.
- Title, branch, commit and change-request helpers explicitly keep CLI sessions
  with the native None profile, a bounded deadline and no inference retries.
  Desktop mode cannot select None through `session/set_mode`.

Cafe transactional rewind, native conversation forks, durable thread goals and
subagent concurrency overrides remain unsupported. Native prompt revision is
not Cafe's checkpointed rewind transaction, and the reviewed contract exposes no
native fork/goals/subagent control methods. Automatic Cafe scheduling injection
remains unavailable: the reviewed native MCP API persists registrations and
environment references account-wide, and ignores standard ACP session MCP
registrations. It exposes no session-only MCP registration/cleanup contract.
Cafe does not persist its private scheduling bridge into that native profile.
Native thread list/timeline APIs exist, but importing conversations created outside
Cafe remains an integration gap. Profile/logout and billing/payment controls likewise
remain outside Cafe's current UI.
Administrative native commands are filtered from discovery where they would
take over Cafe's process, account, model or history ownership. Axiom billing and
payment management remain in Axiom's product.

## Reported token costs

Usage/overview, Atrium, model/provider totals and daily ranges include **settled
Axiom request costs**, marked **Reported**. The native activity and timeline
contracts supply exact integer microUSD strings plus input, cached input, output
and reasoning counters. Cafe preserves exact amounts in its durable ledger;
numeric chart/currency presentation is bounded separately. A zero-cost settled
receipt is measured zero, not an unpriced request. Axiom rows without a usable
receipt remain unpriced even if their model name matches another provider's
published rate. Pricing overrides never replace native receipts.

Billing is independent of the current context-window meter and response
authentication. Only terminal settled records with valid counters are admitted;
cancelled/failed partial work can have a legitimate settled charge without a
verified reply. Native title/compaction activity and metadata-helper observations
use the same request identity rules. Cache-write counters and cache savings are
not invented when the native contract does not report them.

An opaque Cafe UUID derived from private native account/thread/request coordinates
deduplicates each immutable settlement. SQLite commits the checkpoint, tokens,
reported amount and measured token share atomically. Replayed events, overlapping
provider entries using the same account and resume after a backend restart cannot
add the same receipt twice. Disabled collection advances checkpoints without
adding usage, so enabling it does not backfill suppressed observations.

Native history reads reconcile pending accounting using a first timeline read
with **both cursors omitted**, then paginate request usage independently. Recovery
is bounded to eight 500-request pages and a 15-second control budget for the
owned thread; it never starts inference. Recovered costs retain the native
completion date. The overview covers recorded requests, not account-wide spend
from Axiom's separate app/API keys or payments. Other providers retain their
standard API-rate estimates, and the mixed-cost explanation distinguishes those
estimates from reported Axiom costs.

## Verification in the composer tab

Axiom's control uses the existing curved composer tools tab. It opens an
accessible inspector with **Latest reply verification** and **Cached attestation
report**, plus explicit refresh and copy-public-report actions. Opening the
inspector only subscribes to metadata. A new native session can prewarm attestation
using only its model ID; draft text never enters that request.

The server rechecks the saved chat, selected instance/model, configured provider
and exact native runtime around each dedicated report read. Reports are volatile,
not durable authorization. Settings, account/runtime/model changes and reconnect
invalidate their ownership. Public report codecs reject malformed identities,
fingerprints, expiry, unsupported protocol pairs and failed checks. The native
runtime performs cryptographic verification; Cafe validates its public report
contract and presents **Verified by local AxiomCLI**.

A fresh report does not verify a reply. Streaming is provisional. A completed
reply requires exact-current-turn native conversation request accounting with
authenticated completion for every observed request. Cancelled/incomplete output
and later billing reconciliation cannot become verified. Expiring a cached report
does not revoke an already authenticated reply.

NEAR evidence describes its attested worker/key checks. Tinfoil evidence describes
its SNP router and accepted build/TLS/HPKE verification chain. The inspector
retains the actual checks and provenance rather than claiming independently
verified GPU quotes or arbitrary model weights/source code.

Intel's exact OutOfDate posture can be accepted only after a current NEAR warning
and explicit checkbox/action for the current model/runtime. Consent belongs to
that native process and expires on restart. Accepted evidence is degraded and
retains the failed posture check. Expired evidence, invalid signatures, key/model
or TLS binding failures and other verification failures are not overridable.

Inference encryption does not encrypt Cafe's or Axiom's local conversation
databases, workspace files, clipboard/exports or external tool traffic.
Enabled web searches use external tools; their queries are outside inference encryption.

## Protocol provenance and qualification

The reviewed source copy declares AxiomCLI **0.1.13**. Its source files
`apps/axiomcli/src/acp/{server,sessions,settings,prompts,security,account}.rs`,
`crates/axiom-acp-extension/src/lib.rs`, the v0.2 JSON Schema,
`crates/axiom-inference/src/{attachments,accounting}.rs` and its native security
guide define this adapter's contract. This is compatibility review, not proof
that a local source copy built a particular installed binary.

Cafe negotiates ACP v1, extension family 0, account@2, modelCatalog@1,
threadCatalog@1, timeline@2, attachments@2, activity@1, securityEvidence@4,
steering@1 and compaction@1. New desktop sessions also require desktopChat@1,
desktopAgent@1, desktopMcp@1 and webConsent@1. Billing@4 is optional. Incompatible required versions
fail visibly without weakening the verification policy. The upstream ACP
runtime/package version is independent of these contract versions.

Default tests use isolated synthetic Node peers and public fixture evidence,
never installed providers, actual account credentials or paid inference. Browser
fixtures cover received report ownership, expiry, exact consent, copying,
keyboard dismissal/focus, MCP controls and reported-cost overview presentation.
MCP and billing fixtures use synthetic peers/receipts without launching real
MCP servers, reading profiles, keychains or making paid requests. They also run in the existing macOS/Windows focused
subset, with unchanged worker bounds and deadlines.

Native protocol-only qualification is explicit:

```sh
CAFE_AXIOMCLI_PATH=/Applications/Axiom.app/Contents/Resources/bin/axiomcli \
  corepack yarn workspace @cafeai/cafe-code test:e2e:axiom
```

This initializes the configured native binary and checks its advertised contract;
it creates no conversation and sends no inference request. Native sign-in,
deployed hardware verification, a real authenticated reply, long-running tool
cleanup and other-host behavior require separate live qualification. Source,
synthetic and local macOS evidence do not establish native Windows/Linux provider
qualification. Required repository checks end with `yarn build:desktop --force`.

The implementation sequence is recorded in
[the integration plan](axiom-provider-integration-plan.md).
