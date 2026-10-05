# Remote workspaces

Add a reachable Cafe server in Settings → WebUI → Saved environments → Add
environment. Use **Pairing URL**, **Host + Code**, or **Host + Login**. Login uses
the target server's Cafe admin password. Username is an optional session label,
not a separate account or the PC's operating-system login. Bare hosts default to
HTTPS; include an explicit scheme and port when needed.

Password login calls `/api/auth/bootstrap/password/bearer` and grants the same
owner role as the web login. Pairing grants a client session. Bootstrap secrets
are cleared on submission, method change and close. They are never persisted,
automatically retried, or forwarded through redirects. Desktop saves only the
resulting bearer encrypted with Electron safeStorage in its private registry.
Browser local storage contains connection metadata; bearer sessions live in
session storage. Reconnect uses the bearer and mints a fresh short-lived WS token.
An expired or revoked session requires signing in again.

The **Workspace server** selector beneath the sidebar logo appears only after a
remote environment is saved. Remote MCP installation, in-app desktop viewing,
server-specific help and settings failure feedback apply only to saved remote
workspaces. Primary-only desktop and browser sessions keep their existing controls,
wording and settings save behavior. Select a server with the selector. Opening a
chat selects its server before Desk renders. Each server retains its own Desk
layout, and drafts retain their environment. A disconnected selected server
cannot fall back to executing a write on the Mac. Reconnect it with the sidebar
button or manage its saved login in WebUI settings.

| Feature                                                                                                             | Where it runs                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chats, standalone chats, projects, Git, worktrees, scheduled follow-ups and attachments                             | Selected server; the Mac renders the results.                                                                                                                                                                                                                 |
| Provider configuration, updates, restarts, usage, diagnostics, keybindings, system prompt and access administration | Selected server. Provider login opens its supported host login window; complete it on that PC.                                                                                                                                                                |
| MCP registration and dictation credentials                                                                          | Selected server, subject to its owner/transport/runtime capabilities. Remote MCP installation requires a desktop-mode backend. Chat dictation uses the local microphone with the selected server's ephemeral credential.                                      |
| File links and work-log file links                                                                                  | Local desktop files open in the configured external editor; remote file actions copy the path. Cafe has no in-app remote text viewer, editor or terminal.                                                                                                     |
| Virtual desktop viewer                                                                                              | Linux virtual desktops can be viewed and controlled inside the Mac/Windows/browser frontend. Linux runtime prerequisites remain on the server. Windows/macOS hosts do not acquire Linux virtual desktops. The existing local Linux native viewer is retained. |
| Finder/Explorer, native folder pickers, app installation/exposure/certificates and Mac global dictation             | The machine running that native app. Remote paths never launch a Mac editor or Finder. Mac global dictation uses the Mac's local Cafe credential and native permissions, separately from remote chat dictation.                                               |

Remote desktop viewer input uses owner-authenticated
`POST /api/workspace` over HTTPS or an observed loopback connection. Install the
updated Cafe backend on the PC as well as the updated Mac frontend. Older servers
can still supply their existing chat/project APIs but cannot supply these new
desktop control operations. Cafe's existing HTTPS proxy or a trusted local TLS proxy
provides the protected backend hop. Direct cleartext LAN requests cannot invoke
the new owner controls.

Desktop frames remain private, bounded authenticated PNGs; input and control
leases are not written to conversation history or operational logs. **Take
control** explicitly pauses agent input. Owner/session, desktop incarnation and
native control epoch fence every action. A native viewer or agent takeover
invalidates older input. Closing releases the current lease; lost viewers expire
after 30 seconds. Queued input is cancelled on close and is never retried.

Network reachability, DNS, tunnels, certificates, CORS and browser mixed-content
policy still apply. Adding a connection does not install an SSH tunnel or alter
the host's firewall. The Mac desktop app continues to run its local Cafe helper
for its own UI, storage and native integrations; project execution can stay on
the PC.

## Qualification

Unit tests cover connection authentication, environment-bound API and access
administration, per-server state, HTTP owner/transport admission, rejection of
removed file and terminal operations, and viewer lease takeover, incarnation and
expiry. Browser fixtures cover remote routes/drafts and selection, Desk navigation,
settings, provider controls, usage, MCP, dictation, secret clearing and constrained
layout. The default test suite does not start real providers or use user credentials.

The implementation was checked on macOS. A separate Linux PC, real remote provider
authentication, production certificates and the Linux native viewer's new human-input
protocol still require native end-to-end qualification on that host. Manager
fixtures on macOS establish lease policy, not native Linux input execution.
