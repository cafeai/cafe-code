# Generation speed

Cafe shows how fast the model is producing output, in tokens per second, in two
places:

- **Working line above the composer**: hovering or focusing it reveals the
  elapsed time and, once a response in the current turn has been measured,
  `· 84 tok/s`.
- **Context window details** (ring popover or docked session rail): a
  `Speed: 92 tok/s` alongside the compact `Processed: 5m` total for the chat's
  most recent measurements. These facts wrap together when a narrow panel
  cannot fit both; the generic automatic-compaction sentence is omitted.

Both show the average over the most recent **5 seconds of measured decoding**
(`GENERATION_RATE_WINDOW_MS`). The window is generation time, not wall time:
providers report output tokens once per response, so a wall-clock window would
be empty for most of a long reasoning response. Responses are weighted by their
duration, and a response straddling the window edge contributes proportionally.

## What a sample measures

Each sample pairs one response's provider-reported output tokens (including
reasoning tokens) with the interval Cafe observed while that response streamed:
from its first streamed output to its last output edge. Time to first token,
tool execution and approval waits are excluded, so this is decode speed rather
than turn throughput. Adapters attach a sample as
`ThreadTokenUsageSnapshot.responseGeneration` on the usage snapshot that closes
the response; it reaches the renderer through the existing
`context-window.updated` activity.

| Provider       | Window                                    | End                                                        | Not sampled                                                                       |
| -------------- | ----------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Claude         | first content block after `message_start` | `message_delta` (cumulative `output_tokens`)               | messages containing Anthropic-hosted tool blocks                                  |
| Codex          | first reasoning/message/plan output       | last output edge, or the response's first local tool start | responses with hosted web search, image generation or compaction; retried streams |
| Grok, OpenCode | —                                         | —                                                          | not measured; the UI shows nothing                                                |

Codex sends `thread/tokenUsage/updated` only after the response's tools finish
(`send_token_count_event` follows `drain_in_flight` in
`codex-rs/core/src/session/turn.rs`), so its arrival never ends the window. The
exact `rawResponse/completed` marker requires `experimentalRawEvents`, which
Cafe leaves disabled. Later tool starts can wait for Codex's serial tool lock or
an approval, so only the first one counts, and none after a resolved server
request. A second parallel call's argument generation is unobserved and can make
a sample read slightly high.

Only the root conversation is measured: Codex subagents are separate native
threads and Claude nested-agent frames are excluded. Samples under 50 ms or
above 5,000 tok/s are dropped as measurement artifacts.

## Boundaries

The figure is display-only. It never affects billing, usage accounting,
liveness, retry or lifecycle decisions, and its absence means "not measured",
never zero speed. Sample timing comes from Cafe's observation of the stream
(Codex's own `emittedAtMs` when present), so heavy local load can make a sample
read slightly low. Older servers and history recorded before this feature
simply show no rate.

Important files: `apps/server/src/provider/responseGenerationClock.ts`,
`codexResponseGeneration.ts`, `claudeResponseGeneration.ts`, and
`apps/web/src/lib/generationRate.ts`.
