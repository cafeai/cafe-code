# Video reference analysis

Cafe Code accepts video references through the chat composer on desktop and in the authenticated
WebUI. The implementation is provider-neutral: it converts video into the image-and-text inputs
that both Claude Code and Codex can consume consistently.

## Operator flow

1. Choose the paperclip in the prompt composer, paste, or drop a video.
2. Cafe Code decodes the file locally in the renderer and samples chronological frames.
3. The draft receives one JPEG contact sheet and an `EffectRecreationSpec v1` text block containing
   frame timestamps, approximate visual-change intensity, first/last-frame loop similarity, and a
   sampled color palette.
4. Review or extend the prompt, then send it to Claude or Codex through the normal attachment path.

The original video never enters the draft, server attachment store, provider request, or chat
history. Only the derived contact sheet and specification are transmitted. Audio is not analyzed,
and the composer labels that limitation explicitly.

## Formats and bounds

- WebM, MP4, M4V, MOV, OGV/Ogg, and MKV are recognized by extension; any file with a `video/*`
  MIME type is offered to the browser decoder.
- Actual codec support follows the Chromium/WebView build on the device. A recognized container
  with an unavailable codec produces a visible decode error.
- Source limit: 64 MiB and 30 minutes.
- Decoded frame limit: 4K-class (8,847,360 pixels) to bound mobile GPU and memory pressure.
- Sampling limit: 12 chronological frames.
- Provider payload: one JPEG contact sheet under the existing 10 MiB image limit.
- MediaRecorder-style WebM files whose metadata initially reports an infinite duration are resolved
  by seeking the final media cluster before sampling.

## Falling and interactive effect recreation

The generated specification tells the provider to treat frames in chronological order and, when
asked for a Cafe Code atmosphere, to preserve the established effect/profile and lifecycle
contracts. Matrix-style output should use the existing WebGL2 instanced glyph path with Canvas2D
fallback; other effects should use the lightest existing renderer that preserves the reference.
Interactive output remains executable application code with pointer-transparent background
behavior rather than an embedded replay of the source video, unless the operator explicitly asks
for playback.

Cafe Code does not automatically execute provider-generated animation code. Normal project review,
permissions, tests, and build gates still apply.

## Verification

The unit suite covers recognition, filename safety, bounded timestamp generation, deterministic
motion/loop/palette summaries, prompt limits, and the recreation contract. A Chromium browser smoke
test records and decodes a real WebM, then verifies that a bounded JPEG contact sheet and visual
summary are produced. The full composer browser suite verifies that only the derived JPEG is stored
in the draft and the raw video is absent.
