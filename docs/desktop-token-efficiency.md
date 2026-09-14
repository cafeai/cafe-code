# Desktop tool efficiency

Observe an unfamiliar desktop, group predictable input, and capture at the next
decision point. The same tools support single actions for exploratory work.

```js
await act({
  actions: [
    { kind: "key", keys: ["Control_L", "a"] },
    { kind: "text", text: "bamboo" },
    { kind: "key", keys: ["Return"] },
  ],
  waitFor: { type: "screen_change", timeoutMs: 3000 },
  observeAfter: "if_changed",
});
```

A sequence permits 24 steps, 4096 UTF-8 text bytes total, and 45 seconds.
`waitFor` supports a screen change or a visible window selected by `windowId`
and/or `appId`, for at most five seconds. Local polls are 350 ms apart and stop
on cancellation. A changed screen is not proof an application finished loading.
`observeAfter: "always"` forces pixels; `"none"` (the compatibility default)
returns only the action result. A timeout never repeats an action.

`observe({ since: observationId })` omits identical image content. Hashing happens
before PNG compression in the disposable encoder. Geometry or control changes
always require fresh pixels. `observe({ force: true })` recovers a full screenshot.
There is no continuous capture loop.

For small dialogs, `observe({ windowId })` or
`observe({ region: { x, y, width, height } })` returns a native-resolution crop.
Pass its `observationId` to `act` and use coordinates within that image. Cafe
translates them to desktop coordinates and rejects stale geometry, hidden/moved
windows, expired references or ownership changes. References last five minutes,
are private to that capability, and work even when screenshot retention is zero.
Conditional observation with `since` alone keeps the prior crop; an observation
without `since` or a target returns the full desktop.

Sequences stop on failure, cancellation or human takeover. `completed` counts
acknowledged steps; `uncertainStep` is one-based and may have partially executed.
Inspect before continuing. Competing model mutations are rejected while a
sequence runs. Human takeover and turn cancellation keep their immediate path.
Older surviving workers require a new desktop for guarded crops/sequences.

`windows` returns compact window data; use `detail: true` for container/layout
diagnostics. `list_apps` accepts a name/ID `query`. Successful structured window
operations and input return compact acknowledgements. Raw Sway commands keep
their per-command results and partial failures.

Launch outcomes distinguish `window_appeared`, `terminal_opened`,
`launcher_exited`, `running_without_window`, and `unverified`. A terminal wrapper
does not verify the requested application. A launcher can fork or forward to an
existing profile; its exit alone does not prove failure. There is no automatic
relaunch or GPU/profile workaround.

For repetitive application work, use its supported scripting interface when
appropriate, such as Blender's Python console for arranging many objects, then
visually verify the result.

## Measuring

Desktop → Technical details shows runtime totals for calls, actions, screenshots,
unchanged captures omitted, text characters and failures. Snapshot counters also
include local capture count, emitted pixels and elapsed tool time. They reset
when the runtime owner restarts and do not retain arguments or images.

The read-only, opt-in Node script reports provider usage and desktop calls/images
from a local Codex JSONL transcript:

```sh
node scripts/review-desktop-usage.ts /path/to/local-transcript.jsonl
```

Its output contains only numeric aggregates. Input includes cached input;
subtract cached input once to calculate uncached input. Tool calls are not model
responses: code mode may group multiple calls into one response. Image bytes and
reply text characters are not token counts.

The reviewed completed Blender install/browse turn had 55 model responses,
154 desktop calls, 50 screenshots, 4,902,923 input tokens (4,811,264 cached) and
9,631 output tokens. These are the baseline, not a post-change result. Compare
equivalent completed tasks and check errors/retries and saved output quality.
Unit/native fixtures verify that a three-step interaction can return one final
image and that identical observations emit none; they cannot predict a model's
future behavior or establish a percentage reduction on the Blender task.

`VirtualDesktopNative.e2e.test.ts` includes credential-free sequence, exact crop,
conditional image, stale geometry, native key preflight and launch-exit checks
alongside its Wayland/X11 input/viewer coverage. Run it only with the documented
opt-in native setup; live provider qualification remains separate.
