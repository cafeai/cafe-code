# Cafe Code MCP

## Built-in chat scheduling

Scheduling inside Cafe does **not** use the installer below. Cafe automatically gives each Codex, Claude and Grok session a private, chat-and-account-bound connection for proposing, listing and pausing follow-ups. Separate account profiles/custom homes are supported without editing saved MCP configuration. Review proposals and the paying account in **Tasks → Scheduled**, then choose **Approve & enable**. Switching accounts requires renewed review; the old session cannot target the replacement account. Normal provider tool permissions remain authoritative.

These narrow tools are independent of the broad management toggle. Already-running old providers need normal rebuilt-runtime adoption and session restart/resume. See [scheduled follow-ups](scheduled-followups.md) and [session authority](decisions/session-scoped-scheduling-tools.md).

## Optional management connection

Open **Settings → MCP → Cafe Code MCP** to enable or disable Cafe's management server, registered as `cafe-code`. The existing authenticated endpoint stays on by default on upgrade. Turning it off rejects new Cafe management MCP requests, including from agents running inside Cafe. Work already started may finish.

In the local desktop app, **Install** registers Cafe MCP for Codex, Claude Code, Grok, or OpenCode. It configures the provider's default user profile; it does not install the provider application. Reload MCP or restart that provider after installation. Keep Cafe Code running while using its tools. **Reinstall** repairs the registration, and **Remove** unregisters it. Custom provider homes have separate configuration. Platform-specific support restrictions are recorded in [AGENTS.md](../AGENTS.md#windows-specific-notes).

Cafe adds no per-tool management approval prompts and leaves each provider's permission settings intact. Registration provides Cafe's existing project, conversation, provider, and settings tools. Scheduled follow-up proposals still require owner approval in Tasks before execution.

The interim Linux Desktop Control MCP has been removed. Native control is being rebuilt around the pinned, local Cua Driver; no desktop tools are currently registered. General Cafe installations continue to register only `cafe-code`. Saved observation references and private PNG reads from existing conversations are retained. This migration does not delete files, profiles, conversation history or saved screenshots.

## Configuration and credentials

The installer preserves unrelated provider settings and comments. It refuses invalid files, unsafe links/permissions, and an existing `cafe-code` registration belonging to another environment. Codex and Grok use user TOML; Claude uses user JSON; OpenCode uses its existing JSONC file when available. Claude's default terminal configuration and the explicit default-directory configuration are both updated to support existing launches. Cafe's default macOS Claude account prefers its previous configuration and Keychain login, falling back to the terminal environment only when local authentication checks confirm that Cafe's store has no login and the terminal store does. Explicit provider-home and authentication overrides remain authoritative. See [Claude authentication selection](claude-authentication.md).

Provider configs contain a local executable and structured bridge arguments, with no bearer token. The bridge is copied under the current Cafe environment's private `mcp` directory and runs through Cafe's existing executable in Node mode. Its adjacent connection file is private. Cafe republishes the current backend address on startup, reuses valid credentials, and rotates them before expiry without requiring another install. Revoked credentials remain revoked; use Reinstall to repair them or a connection that expired while Cafe was closed for a month. Never copy that connection file into project configuration or logs.

The bridge reads connection details for every call, connects only to the exact loopback MCP path, rejects redirects, and never automatically retries a mutation. A lost response can mean work completed; inspect its result before repeating it. Input/output messages have a 16 MiB limit and at most four HTTP requests can be in flight. Images use native MCP image content.

Install/remove operations belong to the backend scope and serialize across windows. Closing the requesting window does not cancel an admitted write. The UI reads actual configuration state; it does not claim that an already-running provider has reloaded its tools.

## Qualification

Default tests cover configuration preservation/conflicts, private files, bridge image forwarding, fragmented input, cancellation, bounds, credential renewal, install ownership, and endpoint access checks. Browser tests cover install/remove feedback, conflicting configs, local-environment gating, and failed toggles.

Codex 0.153.4, Claude Code 2.1.263, and the installed Grok CLI recognized generated configurations in isolated temporary homes. OpenCode configuration follows Cafe's pinned `@opencode-ai/sdk` contract; a native OpenCode binary was not available for this check. Sources: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude MCP](https://code.claude.com/docs/en/mcp), [Grok MCP](https://docs.x.ai/build/features/mcp-servers), and the pinned SDK's `Config.mcp`/`McpLocalConfig` types. No provider auth files or model calls are needed for configuration checks.

The standalone artifact test is deliberately opt-in because it launches a real Electron process. It copies each Cafe management and scheduling entrypoint alone into a private empty directory, then verifies initialization, discovery, text, and image results. This catches missing sibling chunks that running a bridge inside `dist` would hide. Linux CI runs this test after building. It uses a local fixture MCP server and temporary credentials, not a provider account:

```sh
corepack yarn workspace @cafeai/cafe-code build:bundle
CAFE_CODE_MCP_BRIDGE_E2E=1 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/CafeMcpBridge.e2e.test.ts
corepack yarn workspace @cafecode/web test:browser src/components/settings/McpSettings.browser.tsx
```

For packaged qualification, set `CAFE_CODE_MCP_BRIDGE_DIR` to a directory containing the management and scheduling entrypoints extracted from the built app and `CAFE_CODE_MCP_BRIDGE_EXECUTABLE` to its executable or AppImage. All bridges must remain independent single-file bundles; bundling their entrypoints together can create a shared chunk that providers do not receive. The same isolated artifact test also qualifies session scheduling's separate audience.

Repository verification remains `yarn fmt`, `yarn lint`, `yarn typecheck`, and `yarn test`, followed by `yarn build:desktop --force` as the final check, using the pinned Yarn through Corepack.
