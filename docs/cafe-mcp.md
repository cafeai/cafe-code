# Cafe Code MCP

Open **Settings → MCP → Cafe Code MCP** to enable or disable Cafe's management server, registered as `cafe-code`. The existing authenticated endpoint stays on by default on upgrade. Turning it off rejects new Cafe management MCP requests, including from agents running inside Cafe. Work already started may finish.

In the local desktop app, **Install** registers Cafe MCP for Codex, Claude Code, Grok, or OpenCode. It configures the provider's default user profile; it does not install the provider application. Reload MCP or restart that provider after installation. Keep Cafe Code running while using its tools. **Reinstall** repairs the registration, and **Remove** unregisters it. Custom provider homes have separate configuration. Platform-specific support restrictions are recorded in [AGENTS.md](../AGENTS.md#windows-specific-notes).

Cafe adds no per-tool approval prompts and leaves each provider's permission settings intact. Registration provides Cafe's existing project, conversation, provider, and settings tools.

## Separate Desktop Control MCP

The [virtual desktop integration](virtual-desktops-integration-plan.md#7-separate-mcp-servers-and-codex-session-integration) implements a second server, `cafe-desktop`, for Linux desktop observation, app/window operations, and input. Enable **Settings → Desktop control**. The Desktop setup section shows installed or missing components and a Check again action after installing dependencies through your distribution's package manager. Package names vary by distribution; Cafe's bundled component has separate repair guidance. This single switch enables virtual desktops, their picker/sidebar controls, and AI access together. New desktop opens a name-and-resolution dialog in the Codex composer or desktop manager. Choose a preset, portrait orientation, or custom dimensions with an aspect-ratio lock. The sidebar's **Virtual Desktops** manager can open, rename, resize, or end it. General Cafe installations continue to register only `cafe-code`.

Cafe injects the full Desktop Control definition into an attached Codex session using structured `codex app-server -c` arguments. It sets `required=true` and `default_tools_approval_mode="approve"` only for this desktop MCP, with no Cafe per-action approvals. This leaves global configuration and other MCP policies unchanged. Codex requires a valid transport definition; the `enabled` field alone cannot create one. These cases and actual model tools were verified against Codex 0.153.4. [Official OpenAI configuration documentation](https://learn.chatgpt.com/docs/config-file/config-advanced#one-off-overrides-from-the-cli)

The integration uses Cafe's app-server per conversation. `-c` applies at startup, so selection changes reconcile before the next turn by resuming the same native conversation. Overrides merge config tables; an existing `cafe-desktop` registration is reported as a conflict instead of being overwritten. Server-side revocation is immediate. The model-visible screenshot, actual input, enable/disable, and same-thread resume paths passed live qualification. Neither MCP's switch disables the other, and Desktop Control uses separate capabilities rather than general owner credentials.

The native viewer uses lossless local buffers on Wayland or X11. Apps retain real files/profiles. Turning Desktop Control off hides the picker/sidebar controls and closes viewing/control, while preserving apps until you select End desktop in the Desktop control settings tab. Closing a viewer leaves apps running. **End desktop** closes its apps and removes its entry and chat selections. Rebooted or exited sessions are removed when Cafe next checks them; backend reconnections preserve surviving sessions. Cleanup failures remain visible for retry. Unsaved application state is not restored. Conversation history and saved observations remain available. Human input takes priority, and the viewer top bar or Ctrl+Alt+Enter returns control to Codex. See [native prerequisites and remaining qualification](virtual-desktop-compatibility.md).

Desktop tools now include `window` (fullscreen, floating, resize, position, move, swap, close, scratchpad hide/restore), `layout`, `workspace`, `workspaces`, and relative `focus`. `windows` returns both windows and containers with parent/workspace IDs, layout, visibility, fullscreen and scratchpad state. For two full-size terminals, observe, inspect `windows`, call `layout` with their shared parent ID and `action: {"type":"set","layout":"tabbed"}`, then `focus` a terminal and observe again. Sway may change container IDs when rearranging a layout.

`sway_query` provides bounded compositor state, with `containerId` for smaller tree queries. `sway_command` accepts up to 8192 UTF-8 bytes of unrestricted Sway syntax and reports actual per-command results, partial failures and truncation. This includes `exec` (shell commands with normal user access) and `exit` (ends the private desktop and its apps). It uses the existing selected-desktop capability and human-control checks, with no new approval prompt. A failed/lost reply can follow a successful action: inspect state before repeating it. Use `launch` for ordinary app launching, since it also reports whether a new window appeared.

New desktops use compact private runtime paths so application IPC sockets fit Linux's pathname limit. Existing long-path demo desktops are removed for this development upgrade, with no live-directory migration. Human shortcuts are listed in the [native README](../native/virtual-desktop/README.md).

## Configuration and credentials

**Saved observations:** Settings → Desktop control keeps the latest **50** observations across this environment by default. Change **Saved observations** to any nonnegative whole number; **0** clears saved screenshots and stops saving new ones. Lowering the limit removes the oldest observations. Click **View observation** on a `cafe-desktop.observe` tool call to see the exact captured image, time, dimensions, and frame. Saved images survive app restarts; calls made before this feature cannot be restored.

Screenshots are private local PNG files, fetched only when opening their preview through an authenticated owner connection. Conversation events retain only a small validated reference. Closing the preview releases its image, and browsers receive `no-store` responses. Expiration and hard conversation deletion immediately revoke retrieval; bounded cleanup removes retired files and retries failed deletions. Disabling Desktop Control preserves retained screenshots until the configured limit or conversation deletion removes them.

`act` can group known input steps and return a final screenshot. Conditional observations omit unchanged images, and explicit window/region crops preserve native pixels with guarded coordinates. Screenshots returned by `act` have the same saved-preview behavior as `observe`. See [desktop tool efficiency](desktop-token-efficiency.md) for examples, limits, launch diagnostics and usage measurement.

The installer preserves unrelated provider settings and comments. It refuses invalid files, unsafe links/permissions, and an existing `cafe-code` registration belonging to another environment. Codex and Grok use user TOML; Claude uses user JSON; OpenCode uses its existing JSONC file when available. Claude's default terminal and Cafe configuration locations are both updated because Cafe explicitly sets `CLAUDE_CONFIG_DIR` when launching it. Explicit provider-home environment overrides are honored.

Provider configs contain a local executable and structured bridge arguments, with no bearer token. The bridge is copied under the current Cafe environment's private `mcp` directory and runs through Cafe's existing executable in Node mode. Its adjacent connection file is private. Cafe republishes the current backend address on startup, reuses valid credentials, and rotates them before expiry without requiring another install. Revoked credentials remain revoked; use Reinstall to repair them or a connection that expired while Cafe was closed for a month. Never copy that connection file into project configuration or logs.

The bridge reads connection details for every call, connects only to the exact loopback MCP path, rejects redirects, and never automatically retries a mutation. A lost response can mean work completed; inspect its result before repeating it. Input/output messages have a 16 MiB limit and at most four HTTP requests can be in flight. Images use native MCP image content.

Install/remove operations belong to the backend scope and serialize across windows. Closing the requesting window does not cancel an admitted write. The UI reads actual configuration state; it does not claim that an already-running provider has reloaded its tools.

## Qualification

Default tests cover configuration preservation/conflicts, private files, bridge image forwarding, fragmented input, cancellation, bounds, credential renewal, install ownership, and endpoint access checks. Browser tests cover install/remove feedback, conflicting configs, local-environment gating, and failed toggles.

Codex 0.153.4, Claude Code 2.1.263, and the installed Grok CLI recognized generated configurations in isolated temporary homes. OpenCode configuration follows Cafe's pinned `@opencode-ai/sdk` contract; a native OpenCode binary was not available for this check. Sources: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude MCP](https://code.claude.com/docs/en/mcp), [Grok MCP](https://docs.x.ai/build/features/mcp-servers), and the pinned SDK's `Config.mcp`/`McpLocalConfig` types. No provider auth files or model calls are needed for configuration checks.

The standalone artifact test is deliberately opt-in because it launches a real Electron process. It copies each of the Cafe management and Desktop Control entrypoints alone into a private empty directory, then verifies initialization, discovery, text, and image results. This catches missing sibling chunks that running a bridge inside `dist` would hide. Linux CI runs this test after building. It uses a local fixture MCP server and temporary credentials, not a provider account:

```sh
corepack yarn workspace @cafeai/cafe-code build:bundle
CAFE_CODE_MCP_BRIDGE_E2E=1 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/CafeMcpBridge.e2e.test.ts
corepack yarn workspace @cafecode/web test:browser src/components/settings/McpSettings.browser.tsx
```

For packaged qualification, set `CAFE_CODE_MCP_BRIDGE_DIR` to a directory containing the two entrypoints extracted from the built app and `CAFE_CODE_MCP_BRIDGE_EXECUTABLE` to its executable or AppImage. Both bridges must remain independent single-file bundles; bundling their entrypoints together can create a shared chunk that providers do not receive.

The separate Linux configuration test launches the installed Codex binary, but reads only generated temporary config: no user credentials, MCP tool processes, or model requests. Set `CODEX_BIN` if the intended binary is not on PATH. This does not qualify app-server discovery or actual desktop control:

```sh
CAFE_CODE_CODEX_MCP_CONFIG_E2E=1 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/CodexMcpConfiguration.e2e.test.ts
```

Repository verification remains `yarn fmt`, `yarn lint`, `yarn typecheck`, and `yarn test`, followed by `yarn build:desktop --force` as the final check, using the pinned Yarn through Corepack.

**Display resolution:** Settings → Desktop control stores the default for new desktops (initially 1280×800). Each dimension can be 320–2048 pixels at scale 1. Display settings in a desktop’s menu change only that running session. Agents can use `get_display` and `set_display`; resizing follows existing ownership rules and requires a fresh `observe` before further input. Resizing or fitting the viewer window does not change the guest resolution.
