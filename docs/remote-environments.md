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

Owners can optionally enable **Two-factor authentication** in Settings →
Connections & remote access on the selected server. Scan the QR code in an
authenticator app (or enter the manual key), then confirm a working six-digit
code. Enrollment expires after ten minutes and belongs to the exact owner
session that started it. Ten recovery codes are shown once; save them privately.
Each recovery code has 128 random bits and works once. Cafe stores only their
SHA-256 hashes in its private server secret store.

Once enabled, every new password or pairing login requires an authenticator
code or an unused recovery code, through either the browser-cookie or bearer
endpoint. A wrong code does not consume a pairing link. The exact short-lived
native desktop bootstrap capability remains exempt. Existing authenticated
sessions keep working; owners can revoke devices separately. Disabling 2FA
requires an owner session plus a fresh code or recovery code. Changing or
clearing the admin password does not disable 2FA.

The second-factor budget belongs to this server, across IP addresses, usernames,
cookie/bearer logins, recovery attempts, enrollment confirmation and disabling.
The first five failed guesses trigger a 30-second cooldown. Each further
failure doubles that cooldown, capped at one hour. Requests refused during a
cooldown do not extend it. After 100 consecutive failures, active six-digit
codes remain locked until an unused recovery code succeeds after the cooldown.
Only successful second-factor verification resets the failure counter. New
enrollments cannot reset it. Before enrollment is complete, the same cooldown
applies without the recovery-only lock, since no recovery codes exist yet.

Attempt reservations, cooldowns, accepted TOTP steps and recovery-code
consumption are committed together through a serialized private secret-file
lane before returning success. They survive backend restart. At most 16
operations enter the lane; overload gets an immediate `429`, rather than an
unbounded queue. Cooldown replies use `429` with `Retry-After`. Missing codes do
not spend guesses. Malformed/unreadable storage fails closed. Only a validated
password or unconsumed pairing credential reaches the second-factor verifier,
so arbitrary unauthenticated traffic cannot spend its guessing budget. Native
TLS admission and bounded request-body readers continue to apply.

TOTP uses RFC 6238 SHA-1, six digits, a 30-second period, and at most one adjacent
time step in each direction. Accepted steps (including the enrollment proof)
cannot be reused. See [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238) and
[NIST's OTP and rate-limiting guidance](https://pages.nist.gov/800-63-4/sp800-63b.html).

macOS also controls the desktop app's access to servers on your local network.
Both source launches and packaged apps declare this use in their app metadata;
the declaration does not grant access. Allow Cafe Code when macOS asks. If LAN
connections fail while a browser can reach the same server, check System Settings
→ Privacy & Security → Local Network. A connection that worked from one launch
context can fail after relaunching from another; app identity and OS permission
state must be checked separately from certificate trust and the saved login.

Source launches brand and ad-hoc sign their private Electron runtime copy so
the main app and helpers have matching Cafe bundle and signing identifiers.
The launcher seals nested frameworks first and verifies the full bundle before
caching it. An old source copy whose signing identifier remains `Electron` can
fail LAN admission even when the settings switch is enabled. Updating the source
launcher rebuilds that cache on the next launch; the installed Electron package
and packaged release signing are separate. This development signature does not
grant Local Network access or provide an Apple-issued persistent signing identity.
Default `yarn start:desktop` and `yarn restart:desktop` launch a small native
Debug host through LaunchServices. The host lives at
`~/Library/Application Support/Cafe Code Source Hosts/v1-<arch>/Cafe Code (Debug).app`
and has the distinct identity `com.cafeai.cafecode.debug.source-host.v1`. It is
compiled and ad-hoc signed once, with its own main executable UUID. It launches
the separately verified Debug Electron bundle directly as its child and stays
alive for that child's lifetime. Electron opens the network connections itself;
there is no forwarding service or tunnel.

macOS attributes helper networking to the responsible parent app. Keeping this
small signed bundle unchanged gives ordinary source rebuilds a stable responsible
identity, even when the Electron runtime or JavaScript changes. Allow **Cafe Code
(Debug)** when the new host first requests Local Network access. The launcher
verifies the cached host's signature, versioned source/plist receipt, ownership,
and UUID, and refuses to replace or re-sign an existing identity when those
inputs differ. A change to the native host protocol or its signed metadata
requires a deliberate host version bump and new consent. It does not inherit
Production's grant or use a weaker custom code-signing requirement.

After the existing profile owner finishes graceful shutdown, a hosted Debug
restart exits with code 75. Its native parent waits for the actual child exit
before launching the successor, retaining the same responsible app and permission.
The absolute main entrypoint and configured Debug home remain fixed, and inherited
Electron Node-only mode is cleared. Packaged release relaunch is unchanged. App output
remains in private `source-launch-*.stdout.log` / `*.stderr.log` files under Cafe's
restart log directory. An explicit custom restart command retains its chosen
launch context.

This is a source-development identity policy, not a general macOS privacy reset.
[Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)
documents responsible-app attribution, ad-hoc signing limitations, UUID collisions,
and the absence of a supported per-app reset before macOS 27.2. Native qualification
must exercise the branded app's actual LAN TLS operation after consent and again
after a native restart. Shell curl/SSH and localhost TLS tests do not qualify this
permission boundary. A small isolated GUI Electron fixture on macOS 27.0.1 qualified
direct TLS through the v1 host before and after an exit-75 restart, with the same
native parent and certificate fingerprint. This does not establish every macOS
version's behavior or replace an end-to-end saved-environment pairing check.

For a self-signed HTTPS server, the desktop app asks for certificate approval
before sending a sign-in credential. Compare the displayed SHA-256 fingerprint
with the server's public certificate. Approval applies only to that HTTPS/WSS
origin (including its port) and certificate, is stored privately in the local
Cafe app data, and does not change operating-system trust. A changed certificate
needs new approval. Expired certificates, wrong addresses and other TLS failures
cannot be overridden. Pure browser clients use their browser/OS certificate trust.
Approval is offered only when explicitly adding a saved environment; background
reconnects never display trust prompts or replay a password.

Source launches through `yarn start:desktop` filter only Chromium's exact
`ssl_client_socket_impl.cc` authority-handshake line (`net_error -202`) from
the child's terminal stderr. Chromium emits that line before Electron can
apply Cafe's saved certificate approval. Rejected certificates still produce
Cafe's `TLS certificate rejected` warning with a finite reason, without URLs,
query tokens or certificate contents. Other TLS failures, GPU errors and app
output retain their original bytes. Filtering uses bounded line buffering and
backpressure and drains final stderr before the launcher exits. Headless server
output, direct packaged-app launches and macOS LaunchServices restart logs keep
their existing output path.

This changes log presentation only. Certificate approval remains bound to the
exact HTTPS/WSS origin, port and fingerprint. Electron's earlier session verifier
receives a hostname without a destination port and caches results, so Cafe does
not move its origin-bound approval there or change global TLS trust.

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
settings all belong to that server. Saved connections apply streamed provider
status changes to that server's current configuration after its identity snapshot.
Enabling a provider, completing login or refreshing status updates its availability,
models and last-checked time without reconnecting, while retaining newer settings
and leaving other servers unchanged. Emptying the Recycle Bin affects only its
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

| Feature                                                                                                                   | Where it runs                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chats, standalone chats, projects, Git, worktrees, scheduled follow-ups and attachments                                   | Selected server; the Mac renders the results.                                                                                                                                                                            |
| Provider configuration, updates, restarts, usage, diagnostics, keybindings, custom instructions and access administration | Selected server. Provider login opens its supported host login window; complete it on that PC.                                                                                                                           |
| MCP registration and dictation credentials                                                                                | Selected server, subject to its owner/transport/runtime capabilities. Remote MCP installation requires a desktop-mode backend. Chat dictation uses the local microphone with the selected server's ephemeral credential. |
| File links and work-log file links                                                                                        | Local desktop files open in the configured external editor; remote file actions copy the path. Cafe has no in-app remote text viewer, editor or terminal.                                                                |
| Finder/Explorer, native folder pickers, app installation/exposure/certificates and Mac global dictation                   | The machine running that native app. Remote paths never launch a Mac editor or Finder. Mac global dictation uses the Mac's local Cafe credential and native permissions, separately from remote chat dictation.          |

Computer use and the earlier Linux virtual desktop viewer have been removed.
Cafe exposes no desktop input or saved-observation HTTP routes. Saved remote
environments do not grant access to a computer's desktop.

Network reachability, DNS, tunnels, certificates, CORS and browser mixed-content
policy still apply. Adding a connection does not install an SSH tunnel or alter
the host's firewall. The Mac desktop app continues to run its local Cafe helper
for its own UI, storage and native integrations; project execution can stay on
the PC.

## LAN access and firewall ports

Enable network/LAN access in Cafe before connecting from another device, then
allow the selected backend ports through that host's firewall. Built desktop
defaults are:

- HTTPS/WSS Web UI: `3775/tcp`.
- HTTP certificate bootstrap page: `3773/tcp`. With HTTPS enabled, external
  cleartext access does not admit authenticated API, WebSocket, attachment, or
  MCP traffic. Explicit HTTP-only mode retains its separate policy.

For a host using `ufw`:

```bash
sudo ufw allow 3775/tcp comment 'Cafe Code HTTPS'
sudo ufw allow 3773/tcp comment 'Cafe Code HTTP'
```

For `corepack yarn dev:desktop`, defaults are HTTPS `13775`, backend HTTP
`13773`, and Vite `5733`. Open only the ports needed for your configured setup:

```bash
sudo ufw allow 13775/tcp comment 'Cafe Code dev HTTPS'
sudo ufw allow 13773/tcp comment 'Cafe Code dev backend'
sudo ufw allow 5733/tcp comment 'Cafe Code dev Vite'
```

Use the printed ports when a busy port or `CAFE_CODE_PORT`,
`CAFE_CODE_HTTPS_PORT`, `CAFE_CODE_DEV_INSTANCE`, or `CAFE_CODE_PORT_OFFSET`
changes them. Firewall rules alone do not configure certificate trust, pairing,
CORS, a reverse proxy, or a tunnel. Use the server's advertised secure pairing
details for a remote connection.

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
qualification on that host.
