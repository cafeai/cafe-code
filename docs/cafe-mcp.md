# Cafe Code MCP

## Management tools in Cafe chats

**Settings → Cafe tools → Enable Cafe management tools** controls the backend-authoritative management endpoint. It remains enabled by default. Off rejects new management requests immediately; accepted work may finish. Only an owner connection can change it. Scheduling and visualizations retain their separate credentials, permissions and approval rules.

Cafe supplies management MCP at launch to Codex, Claude, Grok, and local OpenCode chats it owns, including explicit account homes. There is no install/remove UI or registration RPC. Ordinary provider sessions started outside Cafe do not gain a connection. Existing Cafe sessions adopt changes through their normal stop/resume lifecycle; this change does not restart a running provider.

Codex receives a private stdio server through the existing structured app-server configuration override. Claude receives the same private stdio specification through SDK query options, preserving user/project sources and permission callbacks. Local OpenCode receives a runtime-only inline configuration override in its Cafe-owned child process. Configured external OpenCode servers are unchanged. Grok retains its existing session-scoped authenticated ACP HTTP connection. Axiom remains unavailable until its native session MCP ownership/revision contract is implemented.

Management tools have owner authority over Cafe projects, chats, providers and settings. Cafe adds no management approval prompt and does not modify provider approval policy. This is broader than scheduling's proposal/list/pause capability; enabling management never approves a recurring task.

## Separate scheduling and visualization connections

Cafe automatically gives each Codex, Claude and Grok session a private, chat-and-account-bound connection for proposing, listing and pausing follow-ups. Separate account profiles/custom homes are supported without editing saved MCP configuration. Review proposals and the paying account in **Tasks → Scheduled**, then choose **Approve & enable**. Switching accounts requires renewed review. These narrow tools remain independent of the management toggle. See [scheduled follow-ups](scheduled-followups.md) and [session authority](decisions/session-scoped-scheduling-tools.md).

When a local desktop host is available, Cafe-owned Codex and Claude sessions also receive a separate visualization connection. Exact active chat/account/native generation and completed native-call proofs govern publication; Grok is not enabled without equivalent provenance. Viewing and Codex external Apps retain their own native/consent gates. See [agent visualizations](agent-visualizations.md).

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
