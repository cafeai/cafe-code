# Close the Claude query before joining its message reader

Date: 2026-11-02 JST (UTC+0900)
Status: Accepted

## Problem

The Claude SDK exposes its messages as an async generator. Effect's async-iterable
stream finalizer awaits that generator's `return()`. When a read is pending,
JavaScript queues `return()` behind the pending `next()`. The public query
`close()` operation releases the SDK's input reader during cleanup.

Waiting for stream interruption before calling `close()` creates a dependency
cycle on an idle query. The session lifecycle permit stays held, so subsequent
sends and stops can wait behind retirement. A caller's daemon transport timeout
does not cancel the admitted command or prove that no input was submitted.

## Decision

Retirement first fences the existing query and revokes its bindings, pending
interactions and prompt queue. It requests closure of that exact query before
joining its message-reader fiber. Closure, any already-required rewind process
exit observation, and the reader join share the existing ten-second retirement
budget. A public `close()` request alone is not proof of native process exit.

Keep the exact reader handle and the uncertain-closure fence until retirement
succeeds. A throwing close, deadline or interrupted join must not publish a
successful session exit, remove the retained owner or admit a replacement.
An explicit later stop can retry closure of that same retained query. Do not
signal an inferred PID, start a competing query or replay a timed-out message.

## Failure presentation

A durably accepted message can fail before receiving a turn ID. Its failure
activity must retain the exact message ID and durable intent sequence. The main
Work Log admits these failures only for the current canonical unstarted-message
suffix, after the selected latest turn's boundary. It shows fixed public wording;
opaque provider error text is not a preview or an inferred retry instruction.

Older detail-only failure rows lack those identities. A legacy notice may use
an exact, unique canonical-message timestamp in that same suffix for presentation
only. Partial correlation, ambiguity and later-turn boundaries refuse admission.
Neither form grants delivery, cancellation, retry or native-owner authority.
Historical and subagent readers keep their existing filtering.

## Verification and limits

Use a real async generator held in `next()` whose exact query close releases
the read. The regression must detect the ordering error without leaving its
test-owned reader alive. Also cover failed close, retained ownership and bounded
reader retirement. Renderer policy tests cover current and legacy notices,
privacy, ambiguous/stale identities and retirement after a later turn.

This repair does not retroactively settle commands in a running older daemon.
Source changes and a rebuilt bundle do not attest live adoption. Restarting the
app or stopping provider work remains a separate explicit user action. Debug
running-command metadata and completed spans cannot establish an unobserved
internal phase; report that uncertainty instead of guessing from a timeout.
