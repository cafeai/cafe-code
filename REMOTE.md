# Remote Access

Use this when you want to connect to a Cafe Code server from another device such as a phone, tablet, or separate desktop app.

## Recommended Setup

Use a trusted private network that meshes your devices together, such as a tailnet.

That gives you:

- a stable address to connect to
- transport security at the network layer
- less exposure than opening the server to the public internet

## Enabling Network Access

There are two ways to expose your server for remote connections: from the desktop app or from the CLI.

### Option 1: Desktop App

If you are already running the desktop app and want to make it reachable from other devices:

1. Open **Settings** → **Connections**.
2. Under **Manage Local Backend**, toggle **Network access** on. This will restart the app and run the backend on all network interfaces.
3. The settings panel will show the default reachable endpoint, with a `+N` control when more endpoints are available. Expand it to inspect alternatives such as loopback, LAN, private-network, or HTTPS endpoints.
4. Use **Create Link** to generate a pairing link you can share with another device.

The default endpoint controls the QR code and primary copy action for pairing links. You can change it from the expanded endpoint list. The preference is stored by endpoint type, so choosing the local LAN endpoint survives normal IP address changes when you move between networks.

When no user default is saved, the app uses the built-in LAN endpoint for pairing links when
available. You can set another endpoint as the default from the expanded endpoint list.

- HTTPS/WSS-compatible endpoints are useful when another trusted client can reach that endpoint
  directly.
- Non-loopback HTTP endpoints are useful for direct LAN pairing.
- Loopback-only endpoints are not useful for another device unless that device is the same machine.

If the copied link points directly at `http://192.168.x.y:3773`, open it from a client that can reach that LAN address. Pairing links are direct backend links; Cafe Code no longer ships a hosted static web app for browser-side pairing.

### Tailscale Endpoints

When the desktop app can detect Tailscale, it adds Tailnet endpoints to the reachable endpoint list.

Depending on your Tailscale setup, this may include:

- the machine's `100.x.y.z` Tailnet IP
- a MagicDNS name
- an HTTPS MagicDNS endpoint when Tailscale Serve is configured for this backend

The Tailscale HTTPS endpoint uses the clean MagicDNS URL, such as
`https://machine.tailnet.ts.net/`, and is disabled until the app verifies that the URL reaches this
backend. Use **Setup** on the Tailscale HTTPS row to opt in. The desktop app restarts the backend
with the same server-side behavior as `cafe-code serve --tailscale-serve`, then the server asks Tailscale
Serve to proxy HTTPS traffic to the local backend.

The Tailscale support is an endpoint provider add-on. The core remote model still works without Tailscale: LAN HTTP endpoints, custom HTTPS endpoints, future tunnels, and SSH-launched environments all use the same saved environment and pairing flow.

Plain HTTP Tailnet endpoints can work from a desktop client or another browser page served over HTTP. HTTPS Tailnet endpoints are preferable for clients opened from secure browser contexts because browsers block HTTPS pages from connecting to insecure HTTP or WS backends.

### Option 2: Headless Server (CLI)

Use this when you want to run the server without a GUI, for example on a remote machine over SSH.

Run the server with `cafe-code serve`.

```bash
npx cafe-code serve --host "$(tailscale ip -4)"
```

`cafe-code serve` starts the server without opening a browser and prints:

- a connection string
- a pairing token
- a pairing URL
- a QR code for the pairing URL

From there, connect from another device in either of these ways:

- scan the QR code on your phone
- in the desktop app, enter the full pairing URL
- in the desktop app, enter the host and token separately

Use `cafe-code serve --help` for the full flag reference. It supports the same general startup options as the normal server command, including an optional `cwd` argument.

For HTTPS pairing over Tailscale, opt in to Tailscale Serve:

```bash
npx cafe-code serve --tailscale-serve
```

By default this configures Tailscale Serve on HTTPS port 443 and advertises
`https://machine.tailnet.ts.net/`. Advanced users can choose a different HTTPS port:

```bash
npx cafe-code serve --tailscale-serve --tailscale-serve-port 8443
```

> Note
> The GUIs do not currently support adding projects on remote environments.
> For now, use `cafe-code project ...` on the server machine instead.
> Full GUI support for remote project management is coming soon.

### Option 3: Desktop-Managed SSH Launch

Use this when you want the desktop app to start or reuse Cafe Code on another machine over SSH.

1. Open **Settings** → **Connections**.
2. Under **Remote Environments**, choose **Add environment**.
3. Select the SSH launch flow.
4. Enter the SSH target, such as `user@example.com`.
5. Confirm the launch. The desktop app probes the host, starts or reuses a remote Cafe Code server, opens a local port forward, and saves the environment.

After setup, the renderer connects to a local forwarded HTTP/WebSocket endpoint. The remote host still owns the actual Cafe Code server, projects, files, git state, terminals, and provider sessions.

SSH launch is a desktop feature because it needs local process and SSH access. Once the environment is paired and saved, it uses the same environment list and connection model as direct LAN, Tailscale, HTTPS, or future tunnel-backed environments.

#### SSH Launch Troubleshooting

The desktop SSH launcher connects with a non-interactive `sh` session, writes a small launcher script under `~/.cafecode/ssh-launch/<host-key>/`, starts or reuses a remote Cafe Code server, and forwards the remote loopback port back to your desktop. Existing `~/.t3/ssh-launch` state remains supported as a legacy fallback.

The remote host must have a compatible Node.js runtime. Cafe Code uses the server package's `engines.node` requirement:

```text
^22.16 || ^23.11 || >=24.10
```

During SSH launch, Cafe Code first checks whether `node` is already available on `PATH`. If it is missing, the launcher tries common non-interactive shell locations and version-manager shims/activation hooks:

- `~/.local/bin`, `~/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
- Volta via `~/.volta/bin`
- asdf via `~/.asdf/shims`, `~/.asdf/bin`, or `~/.asdf/asdf.sh`
- mise via `~/.local/share/mise/shims`, `~/.mise/shims`, or `mise activate sh`
- fnm via `fnm env --use-on-cd --shell sh` or `fnm env --shell sh`
- nodenv via `~/.nodenv/bin`, `~/.nodenv/shims`, or `nodenv init -`
- nvm via `$NVM_DIR/nvm.sh`, then `nvm use default`, `nvm use node`, or `nvm use --lts`
- installed nvm versions under `$NVM_DIR/versions/node/*/bin`

If launch fails with `node: command not found`, a port-scan failure, or a message that the remote Node version does not satisfy the required range, SSH into the host and check the same non-interactive shell path Cafe Code uses:

```bash
ssh user@example.com 'sh -lc "command -v node && node --version"'
```

If that does not print a compatible Node version, configure your version manager for non-interactive shells or install a compatible Node binary in one of the searched locations. For example, with nvm you may need a default alias:

```bash
nvm alias default 24
```

With mise/asdf/fnm/nodenv, make sure the tool's shim directory is installed and points at a Node version satisfying the range above.

If reconnecting after an app update fails, retry the SSH launch once. The launcher now compares its generated runner script, stops stale launcher-managed remote servers, clears the SSH launch PID/port state, and starts a fresh remote server. You should not normally need to delete `~/.cafecode/ssh-launch` or kill `cafe-code` processes manually.

## How Pairing Works

The remote device does not need a long-lived secret up front.

Instead:

1. `cafe-code serve` issues a one-time owner pairing token.
2. The remote device exchanges that token with the server.
3. The server creates an authenticated session for that device.

After pairing, future access is session-based. You do not need to keep reusing the original token unless you are pairing a new device.

## Managing Access Later

Use `cafe-code auth` to manage access after the initial pairing flow.

Typical uses:

- issue additional pairing credentials
- inspect active sessions
- revoke old pairing links or sessions

Use `cafe-code auth --help` and the nested subcommand help pages for the full reference.

## Security Notes

- Treat pairing URLs and pairing tokens like passwords.
- Prefer binding `--host` to a trusted private address, such as a Tailnet IP, instead of exposing the server broadly.
- Anyone with a valid pairing credential can create a session until that credential expires or is revoked.
- Pairing links keep the credential in the URL hash so it is not sent in HTTP requests, but it can still be exposed through browser history, screenshots, logs, or copy/paste.
- Use `cafe-code auth` to revoke credentials or sessions you no longer trust.
