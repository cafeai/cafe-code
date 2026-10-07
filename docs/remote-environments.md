# Remote workspaces

Add a reachable Cafe server in Settings → WebUI → Saved environments → Add
environment. Use **Pairing URL**, **Host + Code**, or **Host + Password**. Password login uses
the target server's Cafe admin password and does not require a username. Bare hosts default to
HTTPS; include an explicit scheme and port when needed.

Password login calls `/api/auth/bootstrap/password/bearer` and grants the same
owner role as the web login. Pairing grants a client session. Bootstrap secrets
are cleared on submission, method change and close. They are never persisted,
automatically retried, or forwarded through redirects. Desktop saves only the
resulting bearer encrypted with Electron safeStorage in its private registry.
Browser local storage contains connection metadata; bearer sessions live in
session storage. Reconnect uses the bearer and mints a fresh short-lived WS token.
An expired or revoked session requires signing in again.

macOS also controls the desktop app's access to servers on your local network.
Both source launches and packaged apps declare this use in their app metadata;
the declaration does not grant access. Allow Cafe Code when macOS asks. If LAN
connections fail while a browser can reach the same server, check System Settings
→ Privacy & Security → Local Network. A connection that worked from one launch
context can fail after relaunching from another; app identity and OS permission
state must be checked separately from certificate trust and the saved login.

For a self-signed HTTPS server, the desktop app asks for certificate approval
before sending a sign-in credential. Compare the displayed SHA-256 fingerprint
with the server's public certificate. Approval applies only to that HTTPS/WSS
origin (including its port) and certificate, is stored privately in the local
Cafe app data, and does not change operating-system trust. A changed certificate
needs new approval. Expired certificates, wrong addresses and other TLS failures
cannot be overridden. Pure browser clients use their browser/OS certificate trust.
Approval is offered only when explicitly adding a saved environment; background
reconnects never display trust prompts or replay a password.

Cafe refreshes its generated self-signed certificate on backend startup when
the current LAN addresses are missing from it. After a DHCP address change,
restart/update Cafe on the server before connecting to the new address. That
refresh changes its fingerprint, so saved desktop clients need to add the server
again and approve its new certificate. Externally provisioned certificates keep
their existing identity policy.

The **Workspace server** selector beneath the sidebar logo appears only after a
remote environment is saved. Remote MCP installation, server-specific help and
settings failure feedback apply only to saved remote
workspaces. Primary-only desktop and browser sessions keep their existing controls,
wording and settings save behavior. Selecting a server switches the whole app:
chat and project lists, search, new chats/projects, Archive, Recycle Bin, task
activity, unread indicators, provider updates, usage, diagnostics and server-backed
settings all belong to that server. Emptying the Recycle Bin affects only its
history. Other connected servers keep their work and cached data, and do not
appear in the selected server's catalogs or activity indicators.

Switching while in Settings retains the current section; Back returns to the
selected server's Desk. Opening a new chat deep link selects its server before
Desk renders. Each server retains its own Desk layout, and drafts retain their
environment, including repositories with matching identities on multiple servers.
Light/dark theme choices are remembered separately per saved server on this
frontend device. Custom sidebar images load and upload using the selected server's
authenticated connection. The saved connection registry remains available from
WebUI settings so you can add, remove or reconnect any saved server. Native app
installation, operating-system permissions and other machine-only controls still
belong to the computer running the frontend. A disconnected selected server
cannot fall back to executing a write on the Mac. Reconnect it with the sidebar
button or manage its saved login in WebUI settings.

| Feature                                                                                                             | Where it runs                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chats, standalone chats, projects, Git, worktrees, scheduled follow-ups and attachments                             | Selected server; the Mac renders the results.                                                                                                                                                                            |
| Provider configuration, updates, restarts, usage, diagnostics, keybindings, system prompt and access administration | Selected server. Provider login opens its supported host login window; complete it on that PC.                                                                                                                           |
| MCP registration and dictation credentials                                                                          | Selected server, subject to its owner/transport/runtime capabilities. Remote MCP installation requires a desktop-mode backend. Chat dictation uses the local microphone with the selected server's ephemeral credential. |
| File links and work-log file links                                                                                  | Local desktop files open in the configured external editor; remote file actions copy the path. Cafe has no in-app remote text viewer, editor or terminal.                                                                |
| Finder/Explorer, native folder pickers, app installation/exposure/certificates and Mac global dictation             | The machine running that native app. Remote paths never launch a Mac editor or Finder. Mac global dictation uses the Mac's local Cafe credential and native permissions, separately from remote chat dictation.          |

The interim Linux virtual desktop viewer and its input HTTP routes have been
removed. The Cua replacement starts with local native control; saved remote
environments do not grant access to a computer's desktop. Historical conversation
screenshots remain available through authenticated, private observation reads.

Network reachability, DNS, tunnels, certificates, CORS and browser mixed-content
policy still apply. Adding a connection does not install an SSH tunnel or alter
the host's firewall. The Mac desktop app continues to run its local Cafe helper
for its own UI, storage and native integrations; project execution can stay on
the PC.

## Qualification

Unit tests cover connection authentication, environment-bound API and access
administration and per-server state. Browser fixtures cover remote routes/drafts
and selection, Desk navigation,
settings, provider controls, usage, MCP, dictation, secret clearing and constrained
layout. The default test suite does not start real providers or use user credentials.

The certificate policy, approval/cancel/persistence behavior and DHCP refresh
have default regressions. Qualify the real Electron HTTPS/WSS event boundary with
`CAFE_CODE_REMOTE_TLS_E2E=1 yarn workspace @cafecode/desktop test src/settings/RemoteCertificateElectron.e2e.test.ts`.
This opt-in test uses an isolated desktop profile, synthetic localhost TLS/WS
peers and the checked-in test-only certificate; it never connects to a user's
server or uses credentials. It requires a native graphical Electron runtime.

The implementation was checked on macOS. A separate Linux PC, real remote provider
authentication and production certificates still require native end-to-end
qualification on that host. Native Cua desktop permissions, capture and input
will need separate host qualification before that feature is enabled.
