# Private encrypted relay protocol

Use a small approved discovery mesh with a one-hop data plane. Mesh peers are
operator-approved, while the data relay is assumed able to observe, modify,
replay, omit and truncate forwarded bytes. A malicious relay can deny service
and correlate addresses, timing, volume and a stable per-network host key learned
by actively probing it. It cannot authenticate a different pinned host or decrypt
the application channel without endpoint compromise. Code delivery from the
trusted viewer origin remains trusted. See [operations and enrollment](../relay.md).

The maintained public `@libp2p/noise` 17.0.7 adapter uses
Noise_XX_25519_ChaChaPoly_SHA256, its exported pure JS backend, a fresh instance per
circuit, public message-stream APIs and a capability-denying public Upgrader.
There is no handwritten handshake, fake interface cast, private crypto API,
plaintext fallback, provider probe, 0-RTT app data, or persistent Noise static key.
The expected host identity is mandatory for outbound channels. All upstream
logger scopes are permanently disabled, including the connection logger.

The prologue binds the protocol major, chosen network, opaque host locator,
registration incarnation and viewer nonce. Encrypted BIND/BIND_ACK additionally
bind the authenticated device and offered admission key. The relay knows neither
the application pairing secret nor the saved device private key/Cafe bearer.
Network, relay, host, device and admission identities/capabilities are separate.
TLS authenticates each public relay endpoint; it does not replace host pinning.

JCS-encoded signed descriptors reject duplicate keys, noncanonical bytes,
unknown fields, invalid keys/IDs, rollback, expiry and unsafe endpoints. Nodes
poll direct signed, nonce/time-bound snapshots over private WireGuard HTTP. Each
node publishes only its own live, incarnation-bound, expiring registrations.
Snapshots have finite replay/verification budgets. Mesh reachability never
creates membership authority and copied records cannot renew a failed node.
This deliberately uses signed polling rather than a second Noise mesh protocol.

The outer v1 envelope has an exact 24-byte header, bounded control records and
65536-byte total limit. Unknown opcodes, flags, counts and inconsistent lengths
fail shut. Native WebSocket compression is disabled. A pre-library record guard
bounds Noise handshake records to 4 KiB and 16 KiB total rather than inheriting
an upstream 16 MiB decoder allowance. Independent original partial-record
lifetimes do not refresh from unrelated WINDOW traffic.

Inner records carry a 16-byte header, at most 16 KiB data and deterministic
padding buckets up to 32768 bytes. Flow control charges complete encoded/padded
bytes and encryption/outer overhead. Windows are absolute cumulative ceilings;
repeated credits cannot create capacity. Each circuit has 64 KiB channel credit,
32 KiB per-stream credit, sixteen streams and at most two bulk HTTP streams.
Authenticated FIN reports the exact byte count; EOF/reset is incomplete.

RESET may cross already-admitted DATA/FIN. Previously allocated IDs below this
channel's exact monotonic allocation watermark may be drained without retaining
or delivering payload. They still consume validated channel credit and frame/rate
budgets; future IDs and other opcodes fail shut. This prevents request
cancellation from retiring healthy unrelated streams. No cancelled stream gains
new application authority. Closing a circuit owns no provider turn or pending
approval callback. It joins its admitted auth/request/validation jobs before
releasing the application owner. Cancelled-but-draining request handlers retain
their admission slot; at most sixteen are admitted per channel, including at
most two bulk handlers through cancellation. Host handshake
and closing-session work also retains an exact bounded owner until joined.

Admission is layered: eight native accepted sockets including TLS/live sockets,
eight anonymous owners, four host preauthentication handshakes, two recovery
owners (at most one per locator), 64 combined transport/circuit owners, 256 KiB
per-owner pending bytes and 16 MiB aggregate pending bytes. Control has a separate
32 KiB reservation. Registrations are capped at 32, tickets/directory at 1024,
tickets per registration at 32, IP tracking at 4096 prefixes. Capacities reserve
synchronously before async work and release exact reservations at owned close.

IPv6 limits aggregate by /64. Native TCP admission uses actual socket addresses.
HTTP and WebSocket admission accept Cloudflare's forwarded client address only
with this operator's private per-node gateway credential; arbitrary direct
forwarding claims cannot select a limiter bucket. Native TCP and cheap discovery
HTTP use separate 16-burst/four-per-second prefix lanes;
anonymous WS admission uses four-burst/twelve-per-minute. Global admission is
bounded independently. Browser CORS preflights count as HTTP work, so discovery
cannot use the much smaller anonymous WS budget. Endpoint sends are paced;
WINDOW messages coalesce; circuit draining rotates fairly. Host receive budgets
cover the broker's complete aggregate budget, rather than mistake several
healthy viewers for one abusive viewer. Resource ceilings are independent of
application authorization. This is overload containment, not upstream DDoS
protection, NAT identity, fleet-wide quotas or an audited capacity benchmark.
Desktop Cafe hosts must solve proof of work before reserving server capacity.
Browser viewers do not solve work for discovery, pairing, connecting or
reconnecting. Host work grants capacity only; the existing private pilot still
requires operator-issued host enrollment and ordinary end-to-end viewer auth.

### Desktop host reservation proof of work

The version-one host-only HTTP protocol has three bounded POST endpoints:
`/v1/host/challenge`, `/v1/host/claim` and `/v1/host/release`.
Challenge issuance checks the enrolled host’s existing capacity credential but
allocates no slot or retained challenge record. A fresh per-boot HMAC-SHA-256 key
authenticates each challenge’s network, node, boot, host admission key, locator,
claim ID, reservation purpose, one-slot amount, duration, nonce, issue/expiry
times and difficulty. It is independent of offline signing and forwarding keys.
Challenges expire in thirty seconds. The relay checks the MAC and four puzzle
results before bounded signature verification and atomic capacity admission.

Each puzzle hashes a domain-separated challenge digest, a part index and a
32-bit big-endian nonce. Four independent parts each require d-2 leading zero
bits, for approximately 2^d total SHA-256 trials and four verification hashes.
The default effective difficulty is 20 bits (about 1,048,576 expected trials).
At 24 occupied slots it can rise to 21 bits, and at 28 to 22. Decreases use
lower occupancy thresholds and every change has a thirty-second cooldown.
Already-issued authenticated challenges remain valid until expiry. A private
node policy can choose an 18–24-bit base and a two-to-ten-minute duration;
adaptive increases are capped at 24. Policy changes require a rolling restart,
and ordinary operator renewal preserves the policy and forwarding keys.

A small local qualification on 2026-11-10 used Node 24.22.1 at nice 15, including
worker startup and exit: eight 20-bit solves took 260–816 ms, and four 22-bit
solves took 554–3049 ms. Every sampled solve completed within the work cap.
These are observations on one Mac, not a fleet or slow-hardware guarantee.

A reservation lasts ten minutes by default. The desktop starts renewal two
minutes before expiry; shorter configured durations use a proportional margin.
Fresh work extends its paid expiry. Ordinary forty-second heartbeats renew only
the existing short liveness lease, clamped to paid expiry; they cannot keep a
slot forever. Unpaid, expired, wrong-host, wrong-node and old-boot registration
credentials fail closed. An unexpired reservation can reconnect without work,
including while a renewal attempt is backing off. Replacing the connection
retires only the exact previous registration. Signed release reclaims the slot;
a delayed release cannot remove a different reservation incarnation.

After a desktop restart loses its volatile capability, the enrolled host can
pay fresh work to reclaim its existing slot. Reclaim rotates the reservation
identity and credential without allocating a second slot, so a delayed release
from the previous desktop owner cannot remove the replacement.

Primary and warm-standby registrations consume one paid slot each at their own
relay. Existing standby capacity permits immediate recovery. New capacity on a
different node requires its own work; proofs cannot be transferred across nodes.
The desktop retains only volatile reservation capabilities, and a relay restart
invalidates them. Returning viewers retain the existing recovery and app-auth
flow without mining. Host admission is enforced at the relay for both direct
origins and the Cloudflare gateway, so bypassing the edge does not skip work.

The desktop backend owns one bounded FIFO across its configured networks, with
at most eight admitted work jobs and one active solver worker. The worker runs
fixed checked-in Node source with public puzzle bytes, an empty environment,
no inherited preload arguments and finite heap/stack limits. It never runs on
the renderer thread or executes relay-supplied code. It accepts at most 24-bit
challenges, limits hashing to four seconds and 67,108,864 trials, and has an
additional half-second parent termination allowance. Cancellation joins exact
worker exit and native HTTP close before adoption or replacement. Automatic
work is limited to once per node per minute; failures add bounded exponential
backoff. These limits are separate from browser/device authentication.

Each node permits four concurrent host proof verifiers, at most 32 reserved
hosts and 256 short-lived claim receipts. A retried identical signed claim
returns its original result; it cannot allocate another slot or extend the paid
period again. Live replay receipts are never evicted to admit new work. The
client permits one identical-claim retry after an uncertain transport response,
while explicit denials do not trigger retries. Request/response bodies, queued
jobs and deadlines are bounded, and shutdown fences in-flight verification.
Existing authenticated-IP, native socket, global resource and ticket limits
remain in force. Work supplements those limits and provider network mitigation;
it does not independently protect viewer traffic or upstream bandwidth.

Application pairing uses a distinct full-strength 256-bit fragment secret and a
five-minute one-use SQL invitation. Direct/native pairing credentials cannot
consume it. Missing/wrong second factor leaves it unconsumed. Consumption,
ordinary bearer issuance and exact network/host/device/session binding commit
in one transaction. A failed binding returns no unbound credential. Resume needs
both the saved bearer and the Noise device identity; a stolen ordinary bearer
cannot register another device. One-use relay tickets authorize transport
capacity only. A bounded paired recovery lane is followed by ordinary app auth.
A lost pair/password/OTP result is indeterminate and never retried automatically.

HTTP ingress uses existing application handlers in process, enumerated routes
and an exact private request context. Cookies and forwarded/native claims are
stripped. There is no local HTTP/TCP proxy or arbitrary destination. The adapter
retains the exact listening router services, supplies each stream's own request
scope, and preserves it through response streaming. Relay RPC uses bounded
NDJSON over a private virtual upgrade; direct RPC keeps its ordinary framing.
Incoming RPC lines are capped at 128 MiB to preserve the existing
120000-character prompt and eight inline image attachment contract. Unfinished
prefixes are charged twice their UTF-8 length against one shared 256 MiB
backend-wide prefix budget, including closing channels. Complete small commands
need no retained-prefix reservation and can pass while another stream holds a
large partial message. Browser send queues stream large commands under credit.
Application
schemas, roles, session checks and durable command receipts remain authoritative.

HTTP deadlines are five minutes for relay transfers, distinct from the existing
direct file budget. Blob uploads slice to 16 KiB; already-buffered application
responses retain their existing maximum 25 MiB body bound and stream under
transport credit. Application buffers/decoded state are separate from transport
retention. The browser uses explicit target HTTP/socket dependencies, not global
fetch/WebSocket patches or a service-worker proxy. Private media uses inert blob
URLs with exact abort/revocation ownership. Relays cannot supply viewer HTML,
scripts, service workers, proxy destinations or navigation redirects.

Host selection smooths measured host-to-relay RTT and uses hysteresis; a primary
and standby maintain live registrations. Discovery may redirect geographically
near viewers to the host's better relay. Mesh serving needs no quorum and does
not forward app bytes across relay nodes. A descriptor/root/network is explicitly
selected, so alternative meshes need no official bootstrap. This pilot deliberately
starts with static VPS hostnames; DNS steering is a later bootstrap optimization.
