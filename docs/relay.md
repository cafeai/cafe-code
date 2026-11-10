# Encrypted relay private pilot

This branch adds outbound relay access to a Cafe backend and a trusted browser
viewer. The same viewer can run in an isolated Electron browser window. Native
saved-environment enrollment in the installed desktop UI is not included in this
pilot. Existing direct connections and their pairing codes keep their own flow.

The implementation is in `packages/relay`, `apps/relay`,
`apps/server/src/relay`, and `apps/web/src/environments/relay`. See
[the trust and protocol decision](decisions/encrypted-relay-pilot.md).

## Initial endpoints

The initial deployment uses the existing VPS names. All nodes run the same relay;
UK has the separately owned trusted static viewer service. No custom domain,
GeoDNS, public signup, paid provider session, or production Cafe profile is needed.

| Region  | Relay URL                                      | Private discovery address |
| ------- | ---------------------------------------------- | ------------------------- |
| UK      | `wss://vps-692e150f.vps.ovh.net:8443/v1/relay` | `10.200.0.11:9443`        |
| Canada  | `wss://vps-697b49f9.vps.ovh.ca:8443/v1/relay`  | `10.200.0.12:9443`        |
| US West | `wss://vps-7bd57ed1.vps.ovh.us:8443/v1/relay`  | `10.200.0.13:9443`        |

The intended trusted viewer origin is
`https://vps-692e150f.vps.ovh.net:19443`. This is a delivery trust decision,
independent of mesh selection. A relay descriptor never chooses browser code.
The UK OS administrator remains trusted for this origin. A compromised relay
worker cannot write its assets or read the viewer's TLS files; compromise of the
OS administrator or trusted viewer code is outside the E2E relay guarantee.
Use a separately controlled static origin when adding operators you do not trust
with browser code. New page loads also depend on that origin being reachable.
An already connected viewer can recover on another relay while it remains open.

## Host enrollment and invitations

Use the repository-pinned Node and Corepack Yarn 4.17.1. Build and qualify the
source before installing it; a relay rollout does not update a running Cafe app.
The app must adopt this branch's backend and frontend on a later user-controlled
launch. Do not restart the user's existing app to install relay configuration.

The operator CLI accepts a private canonical JSON recipe and a private local
operator directory. It creates the network signing key, individual node keys,
one host's per-node enrollment capabilities, signed descriptor, and host config.
It never prints credentials. For example, with the built artifact:

```sh
node apps/relay/dist/main.mjs configure --directory /absolute/private/operator-dir --spec /absolute/private/recipe.json
```

The recipe is canonical JSON with `version: 1`, `viewerOrigin`, and `nodes`.
Each node has `publicUrl` and `wireGuardAddress`. The operator directory and recipe
must be owned by the operator and private (0700 directory, 0600 file). Use the
public and private endpoints in the table. The generated `node-0.json`, etc., go
only to their respective nodes as root-owned service-group-readable files. The
root signing key and complete operator directory never go to a relay.
`network.json` is public; `host-config.json` and enrollment keys are private.
Do not paste these into logs, tickets or PRs.

Place the host config at `<effective Cafe stateDir>/relay/config.json` (0600) in a
canonical private `relay` directory (0700), owned by the backend user. It has
`version: 1` and up to four explicit `networks`; each entry contains `descriptor`,
`viewerOrigin`, opaque `locator`, and `credentials` (`nodeId`, `token`,
`admissionPrivateKey`). Configure the intended Debug or Production profile
explicitly. Never copy credentials or provider sessions between profiles.
The backend creates a separate 0600 `host-<networkId>.key` in that directory.
No config means relay access is disabled. An invalid existing config fails shut.
Explicit relay host enrollment is currently qualified on POSIX; ordinary Windows
launches with no relay configuration keep their existing behavior.

On that host, open Settings → Connections → Manage relays. An owner can create a
client or owner invitation and revoke an unused invitation. Share the complete
private link out of band. It includes a 256-bit single-use pairing secret in the
fragment, the expected host key, the chosen network root/minimum revision, and a
separate single-use capacity ticket. It expires within five minutes. Enter an
authenticator/recovery code before connecting when enabled. Preauthentication
channels have short deadlines; an expired/dropped capacity grant needs a fresh
link even if the application invitation has not been consumed.

The viewer clears the fragment synchronously before discovery. Pairing happens
inside pinned Noise, then the ordinary Cafe session and exact device binding
commit together. A lost successful response is indeterminate: obtain a fresh
invitation; the viewer never automatically resends pairing secrets/passwords/OTP.
Revocation of a session also denies subsequent HTTP/RPC and resume. Closing a
relay channel never cancels provider work or unresolved approvals on the host.

Browser device keys, bearer and reconnect tickets are wrapped in this tab’s
session storage with a nonextractable AES-GCM key held in IndexedDB. Only public
connection metadata and that wrapping key persist in IndexedDB. Credentials
survive same-tab reload; a new browser session needs a fresh invitation. Same-origin code is still trusted; wrapping is not
protection against a compromised endpoint/XSS. The application pairing secret is
not saved. `/relay/connect` lists saved opaque host identifiers; selecting a host
resumes only when this tab still holds its saved device key and bearer. A bearer alone cannot enroll a new
device. Closing the browser session or removing its session storage loses that device’s local credentials.

Opening `/relay/connect` with no usable credentials shows host setup instructions,
including the requirement for a relay-enabled, enrolled Cafe computer. It does
not show an empty computer selector, a two-factor field or a Connect action.
Previously saved public metadata without this tab's credential record is not
offered as a reconnectable computer. The two-factor field belongs only to a
valid new invitation and explains that it is an authenticator/recovery code,
separate from the pairing link. Browser setup does not enroll or upgrade the host.

## Membership, selection and recovery

The operator's Ed25519 root signs an expiring, increasing-revision descriptor
with at most sixteen approved nodes. Re-run the same private recipe to renew it
or add nodes while retaining keys. Distribute the new per-node configs and HUP
only the service managed by systemd. Verify `relay-configuration-reloaded` and
fetch the exact signed revision from every node. Never roll a descriptor back.
Node removal is explicit root-authorized membership; direct signed peer records
cannot enroll nodes or authorize hosts. Directory snapshots contain only the
sending node's own temporary records and cannot refresh another node's lease.

The pilot operator CLI preserves an existing node list when extending it;
node removal/credential rotation requires an explicitly reviewed replacement
configuration under the same root. It is not an automatic operator signup API.
Existing hosts need refreshed private credentials/configuration and adoption to
use newly enrolled capacity nodes; host config hot reload is not implemented.
Likewise renew the host descriptor before its expiry (default thirty days).

Hosts measure their own relay RTT, smooth observations, and apply hysteresis.
They register at the best node and keep a warm standby. Viewer discovery can
start in another region and return the serving node; application bytes go through
one relay. GeoDNS can later optimize bootstrap location; it must not replace the
host pin, root checks, or host-to-relay selection policy. There is no guarantee of
the global end-to-end mathematical minimum, or migration without a short reconnect.

Each transport has a fresh Noise channel. A relay loss invalidates its tickets
and boot-specific registration; an already paired viewer can use bounded recovery
admission on a surviving approved node, then prove its saved device and Cafe
session. Membership has no leader/quorum. Recovery does not automatically replay
application commands. Existing durable command receipts retain their semantics.

For an alternative network, both host and invitation explicitly select that
network's root, bootstrap URLs and enrollment. It can run independently of these
VPSs. There is no automatic fallback to the official network on failure.

## Operations and rollback

Templates in `ops/relay` are for these dedicated test VPSs. Remote sudo was
explicitly authorized for them; it is not permission for sudo on the Mac.
Use the rebuilt pinned SSH profile and preserve WireGuard, SSH and existing
firewall rules. Do not run a public flood or simulate failure by rebooting a VPS.
Use exact systemd units for a one-node service stop/start after local gates.

The relay runs as its own unprivileged UID from a root-owned version directory,
with a 256 MiB JS heap, 384 MiB memory high watermark, 512 MiB memory maximum,
zero swap, one CPU quota, 64 tasks, 1024 FDs and positive niceness. This is a small
private pilot, not a tested public service capacity promise. Keep only current
and previous artifact versions, and keep logs fixed-category and bounded. Never
log paths, invitations, HTTP contents, auth tokens, keys or raw peer exceptions.

Use the verified official Node 24.22.1 Linux x64 runtime. Its distribution archive
SHA-256 is `6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6`;
verify again against the [official distribution manifest](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt)
before extracting. The relay bundle includes its locked JS dependencies; no
package installation runs on a VPS.

Public 8443 serves only WSS and bounded discovery/latency/health responses.
Private 9443 binds the node's WireGuard address. UK 19443 serves immutable trusted
viewer assets through a distinct unprivileged nginx service, with no API proxy.
Its nginx config uses bounded connections/timeouts and the standard
[static file and symlink controls](https://nginx.org/en/docs/http/ngx_http_core_module.html#disable_symlinks).
The relay UID cannot update code, root configuration or viewer assets.

Certbot keeps each normal TLS private key on its own VPS. Publish only root-owned
0640 copies into that service's configuration directory. The supplied renewal
unit temporarily opens port 80 for standalone ACME, closes it on exit, verifies
the certificate/key pair, publishes it, then reloads only the exact owned
services. Enable that timer only after successful issuance and publication.
Do not copy production TLS private keys onto the development Mac. Certificate
expiry, descriptor expiry and service health all need ordinary monitoring.

For rollback, validate the previous retained artifact/configuration, point the
root-owned `current` symlink at that immutable directory, and restart only the
relay service. Existing channels on that node close; standby recovery remains
available. Preserve network identity, root/host/device keys and database history.
Do not roll back an accepted membership revision or delete another owner's state.

## Qualification commands and limits

### cafecode.sh edge deployment

`ops/relay/wrangler.json` deploys the separate `cafecode-relay-edge` Worker in
the account owning `cafecode.sh`. Its custom domains provision DNS and TLS for
`relay.cafecode.sh` (compiled trusted viewer), `relay-uk.cafecode.sh`,
`relay-ca.cafecode.sh`, and `relay-us-west.cafecode.sh`. The regional names
forward only the public discovery/health paths and WebSocket upgrade to their
fixed OVH TLS origins on port 8443. WireGuard mesh traffic remains direct and
private. The application circuit still uses exactly one OVH relay; Cloudflare
adds an edge transport proxy. Host latency measurements include that edge path.
The apex website and unrelated Workers are outside this deployment.

All asset requests run through the Worker first. Regional endpoints cannot
serve viewer JavaScript. Incoming cookies, authorization and forwarded-IP
headers are excluded from origin requests; origin cookies, redirects and
arbitrary error bodies cannot reach the browser. Signed discovery bytes pass
unchanged within finite request/response bounds. WebSocket handshakes have a
bounded deadline; the successful native upgrade is passed through without
terminating Noise. Neither Worker logging nor preview hostnames are enabled.

Cloudflare and the trusted viewer publisher are additional infrastructure
trust dependencies. Relays still cannot decrypt application content, while
Cloudflare can see connection metadata. The native relay does not trust proxy
IP headers: its IP limits apply conservatively to Cloudflare egress addresses.
This can reduce fairness for users sharing an edge and does not qualify public
capacity. Origin hostnames remain reachable for compatibility, so this is not
complete origin shielding or a volumetric DDoS qualification.

Deploy only qualified, frozen `apps/web/dist` assets and
`apps/relay/dist/cloudflare.mjs` with the authenticated Wrangler profile and
explicit account in that config. Never overwrite an unrelated existing custom
domain. Publish a higher root-signed membership revision advertising the new
regional WSS URLs, preserving node identities, keys and grants; reload the
three exact relay units. The ordinary operator CLI deliberately refuses URL
changes to existing nodes, so this migration needs an explicit reviewed root
signature rather than weakening that guard. Keep the old signed revision and
configuration receipts intact. Update the staged host enrollment's viewer
origin to `https://relay.cafecode.sh`; an already running Cafe backend does not
hot-adopt that configuration.

For an opt-in public application check, put the private host enrollment at
`<private-state-root>/relay/config.json`, with the same no-follow, single-link,
0700-directory/0600-file rules as normal relay enrollment. Run:

```sh
CAFE_RELAY_PUBLIC_E2E=1 CAFE_RELAY_PUBLIC_STATE_ROOT=/absolute/private-state-root \
  nice -n 10 corepack yarn workspace @cafeai/cafe-code test src/server.test.ts \
  -t 'opens the public Cafe viewer' --maxWorkers=1
```

This owns an isolated test application/SQLite database and fresh sandboxed
Chromium profile, using normal public DNS/TLS, the actual deployed viewer and
real regional discovery. It pairs and opens the synthetic project/thread,
and exercises actual encrypted HTTP, typed RPC, attachment and branding routes.
Provider services remain fake and no real Cafe profile is opened. The public
test is excluded from ordinary test execution. Its readiness receipt observes
the exact host's completed start and adopted registrations before issuing an
invitation; scheduling startup or opening a transport is insufficient. The
observer adds no native probes or permission authority. Close its exact browser before
the test application's scoped backend is finalized. The listening router owns
early relay retirement and joins the same cached close operation as the runtime
layer, so admitted RPC requests drain before their application services retire.
Each retired stream also aborts its exact application request Effect. Request
scope cleanup is still joined separately, without the cancelled signal, before
the handler releases its slot. The ordinary router test holds a real descriptor
request, cancels that stream, observes its Effect interruption before releasing
the test gate, and then uses typed RPC on the same healthy session.

Run the focused core/native/auth tests and complete repository qualification:

```sh
nice -n 10 corepack yarn workspace @cafecode/relay test --maxWorkers=1
nice -n 10 corepack yarn workspace @cafecode/relay-server test --maxWorkers=1
nice -n 10 corepack yarn workspace @cafeai/cafe-code test src/relay/auth.test.ts src/server.test.ts --maxWorkers=1
nice -n 10 corepack yarn verify:local --fresh --typecheck-concurrency=1 --test-concurrency=1
```

The complete coordinator performs formatting, lint, audit, actual compiler
API/CLI qualification, every discovered Node program, the separate copied-native
Codex tail, complete local native browser groups, and the fresh forced desktop
build last. It uses the existing bounded local workers/barriers, not hosted CI
scheduling. Failed/skipped/partial work must remain distinguishable from passes.

The opt-in HTTPS/WSS browser test uses a preobtained public certificate for
`vps-692e150f.vps.ovh.net`, with its synthetic private key retained locally.
Supply `CAFE_RELAY_NATIVE_E2E=1`, `CAFE_RELAY_TLS_KEY` and
`CAFE_RELAY_TLS_CERT` only to `corepack yarn workspace @cafecode/web test:relay`.
It runs Chromium and Electron sequentially with fresh owned profiles, mapping
only that hostname to loopback. It uses normal TLS validation, no browser
certificate bypass, trust-store write or live ACME/provider request. The key
must never be committed; an expired fixture certificate must be renewed separately.
The dedicated entry is absent from shipped viewer assets. Ordinary `yarn test`
does not require that certificate or start Electron for this test.

After building `@cafecode/web`, the documented opt-in
`CAFE_RELAY_APP_E2E=1` with the same local TLS variables runs the `compiled Cafe`
case in `apps/server/src/server.test.ts`. It serves the actual compiled viewer,
pairs against the real Cafe router and test-owned SQLite authentication, and
opens the synthetic project/thread through encrypted HTTP and typed RPC in an
isolated Chromium profile. All provider services remain synthetic. Run it with
`corepack yarn workspace @cafeai/cafe-code test src/server.test.ts -t 'compiled Cafe' --maxWorkers=1`.
The ordinary router case retains its original deadline and needs no browser.

After building `@cafecode/relay-server`, set `CAFE_RELAY_ARTIFACT` to the absolute
`apps/relay/dist/main.mjs` path when running its `src/process.test.ts` case. This
qualifies three exact compiled service children, reload and mesh discovery;
ordinary tests continue to use the source entry without depending on build output.

Evidence must state the exact source, runtime, dependency lock, artifacts and
checks actually observed. The protocol has not had an independent security audit.
TLS/browser native allocations, application file buffers (up to the existing
25 MiB body limit), decoded application state, renderer DOM, OS buffers, and
provider memory are outside the relay ciphertext-retention counter. Native WS
allocation in a browser cannot be prebounded by JavaScript. No physical erasure,
anonymity, volumetric DDoS immunity or public launch readiness is claimed.
