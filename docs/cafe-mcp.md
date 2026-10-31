# Cafe Code MCP

## Management tools in Cafe chats

**Settings → Cafe tools → Enable Cafe management tools** controls the backend-authoritative management endpoint. It remains enabled by default. Off rejects new management requests immediately; accepted work may finish. Only an owner connection can change it. Scheduling and visualizations retain their separate credentials, permissions and approval rules.

Cafe supplies management MCP at launch to Codex, Claude, Grok, and local OpenCode chats it owns, including explicit account homes. There is no install/remove UI or registration RPC. Ordinary provider sessions started outside Cafe do not gain a connection. Existing Cafe sessions adopt changes through their normal stop/resume lifecycle; this change does not restart a running provider.

Codex receives a private stdio server through the existing structured app-server configuration override. Claude receives the same private stdio specification through SDK query options, preserving user/project sources and permission callbacks. Local OpenCode receives a runtime-only inline configuration override in its Cafe-owned child process. Configured external OpenCode servers are unchanged. Grok retains its existing session-scoped authenticated ACP HTTP connection. Axiom remains unavailable until its native session MCP ownership/revision contract is implemented.

Management tools have owner authority over Cafe projects, chats, providers and settings. Cafe adds no management approval prompt and does not modify provider approval policy. This is broader than scheduling's proposal/list/pause capability; enabling management never approves a recurring task.

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

## External MCP clients

External clients can connect to Cafe's authenticated Streamable HTTP endpoint at
`/mcp` on the Web UI's origin. The management toggle above also controls this
endpoint. An owner client can inspect projects, chats, and providers; manage
projects and chats; send or interrupt work; update redacted provider settings;
and request provider restarts. The resume restart variant records the exact
active chats and submits durable continuation messages after that provider
restarts. Restart acknowledgements precede shutdown.

Issue a dedicated owner bearer session against the **same Cafe home and state
database as the running backend**. A built source desktop normally uses
`userdata`; development launches with a development URL use `dev` instead.

For a built source checkout, from the repository root:

```bash
node apps/server/src/bin.ts auth session issue --role owner --label cafe-mcp --ttl 30d --token-only
```

Only for a backend started with a development URL, pass that exact URL:

```bash
node apps/server/src/bin.ts auth session issue --dev-url http://127.0.0.1:5733 --role owner --label cafe-mcp --ttl 30d --token-only
```

Use the URL printed by your development runner if it differs. Do not add
`--dev-url` solely because the application was built from source: that selects
a different database. Both commands must inherit the backend's configured
`CAFE_CODE_HOME`, if any. Where the `cafe-code` CLI is already available,
`cafe-code auth session issue` accepts the same options; installing the old
registry package is not required to use these commands from a source checkout.

Configure the client with `http://127.0.0.1:3773/mcp` for the default local built
desktop, or the actual server origin and `/mcp` path. A development backend
normally uses port `13773`, not the Vite frontend port `5733`. Use HTTPS for
non-loopback connections. Send the credential only as
`Authorization: Bearer <token>`; keep it out of URLs, prompts, logs, and
source-controlled configuration.

List and revoke sessions against the same home/database:

```bash
node apps/server/src/bin.ts auth session list
node apps/server/src/bin.ts auth session revoke <session-id>
```

For development state, add the same `--dev-url` to each command.
Owner credentials grant management authority; they are separate from the narrow
session-only scheduling and visualization credentials below.

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
