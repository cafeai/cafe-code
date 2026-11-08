# Decision: own native HTTP transport errors through connection retirement

Decision status: Accepted within the reported backend-disconnection repair
Implementation status: Implemented in source; rebuilt runtime adoption pending
Verification status: Native regression and HTTP compatibility protect this
contract; exact hosted CI and runtime adoption are separately qualified
Created: 2026-11-08 03:38:48 JST (UTC+0900)
Last updated: 2026-11-08 08:56:34 JST (UTC+0900)
Decision authority: The user's recurrent Debug disconnection report and request
to investigate the running application's debug statistics.

## Context

A local backend exited with code 1 after an unhandled native Socket error:
`write EPIPE`. Its stack reached the pinned platform-node HTTP adapter's
`handleResponse` and `ServerResponse.end` small-response path. The desktop
started another backend, but requests and the renderer connection were
interrupted until it became ready. The observed stack does not identify the
request, route or reason that the client disconnected.

The pinned `@effect/platform-node` 4.0.0-beta.59 adapter can return an HTTP
refusal from an asynchronous WebSocket upgrade. Node removes its ordinary HTTP
socket error handler when handing over an upgrade; the adapter's close listener
owns request cancellation but does not consume the socket's native error event.
A late response can therefore escape the request lifetime as an unhandled
EventEmitter error. Ordinary small responses have a related asynchronous
response-write boundary.

## Decision

The application-owned HTTP adapter registers an error owner for each accepted
native socket before listening, and for each ordinary native response before
calling the Effect handler. One weak identity set per kind prevents duplicate
listeners without retaining closed transports. A native error destroys only
that exact socket or response, idempotently. Existing close events still cancel
the corresponding request fiber through the upstream adapter.

Keep each error owner on its transport object through upgrade, response finish,
native close and queued late writes. Removing it when the route effect returns
or on finish would reopen the asynchronous error gap. The object and its
listener can be collected together; there is no strong collection of closed
connections. Server shutdown removes only the application's connection
admission listener after the existing shutdown lifetime. Other HTTP/WebSocket
listeners remain installed and receive their normal events.

This is a transport boundary, not a process-wide exception handler. Do not
catch arbitrary application defects globally, ignore server startup failures,
inspect or log opaque native error objects, retry uncertain requests, or change
authentication, authorization, provider ownership, backpressure, compression,
shutdown budgets or native request cancellation. A client disconnect must not
grant any provider action or shutdown authority.

## Verification boundary

The native failed-upgrade/late-response regression runs in a test-owned child.
The unchanged pre-fix adapter failed with an actual unhandled `ECONNRESET`
write error and native exit code 1. The repaired adapter observes the same
native failure, serves an independent healthy request and closes cleanly.
The historical small response's exact `EPIPE` timing was not reproduced. Both
errors exercise the same missing socket error owner, without synthetic error
emission. A large single `ServerResponse.end` call and first client data alone
cannot establish that a write remains pending on every host. An attempted
first-data handshake still reached native peer close on Windows without the
required write-error witness; that observation does not identify the exact
kernel completion path.

Use separate native peers for reset and FIN. Combining shutdown and reset on
one TCP handle violates the [libuv reset contract](https://docs.libuv.org/en/v1.x/tcp.html#c.uv_tcp_close_reset).
The reset peer never sends FIN. After route admission, a bounded raw upgrade
suffix fills the accepted socket's real readable high-water mark without being
drained. In the pinned Node implementation, the deferred readable observation
follows synchronous native read-stop from backpressure. Only then may the
client reset its own socket; join its actual close and padding write callback
before releasing the rejected response. This keeps the reset from being
consumed first by an ordinary read. The regression must still observe an actual
`EPIPE` or `ECONNRESET` from `write` or `writev`; a read error or peer close is
insufficient. Native Windows execution remains a separate CI qualification.

The second peer retains the original FIN request and abandons its read side
after actual response data using ordinary close, without a reset on that same
handle. Both responses share one never-mutated, bounded 16 MiB allocation.
Case-bound observations prevent either peer from supplying another's witness.
The independent healthy response and clean child exit remain mandatory.
Failure-only diagnostics contain bounded phase/case names and counts, never
response bytes or arbitrary native error text.

Cleanup is registered before asynchronous acquisition and joins the exact
native child, requests and sockets. Existing request, authentication and
WebSocket behavior passed its canonical compatibility tests. These focused
checks do not represent the full repository test suite or hosted CI.

Source tests do not prove adoption by an already running backend. Publishing,
rebuilding, delivering a bundle and restarting Debug retain their separate
authorization and verification requirements. The observed crash also does not
establish the causes of earlier heartbeat delays, slow queries or rich-health
timeouts.
