# Generated visualization chat typography

Decision status: Accepted and implemented within the user's local repair authority; isolated macOS native font and integrated static/default/browser/export tests qualified. Hosted native-platform and installed OS/manual qualification remain separate.
Created: 2026-10-13 12:35:01 JST (UTC+0900)
Last updated: 2026-10-13 13:40:12 JST (UTC+0900)
Decision authority: The user explicitly requests the same font as the main chat for charts and visualizations. Implementation details are coordinator decisions within that request, not authority for installation, publication or a broader sandbox policy.
Supersedes: Only generated documents' previous system-font default. Other execution, visibility, resource, privacy and external-App decisions remain unchanged.

## Context and alternatives

The main chat loads the normal and italic optical-size/weight variable DM Sans faces from the already pinned `@fontsource-variable/dm-sans` 5.3.0 package. Merely naming that family in an isolated document does not load it. Source can also explicitly style SVG axes with monospace or another family. Generated pages currently retain `font-src 'none'`, and maximum source plus an inline font payload would exceed the independent native install envelope.

Choose fixed bundled binary fonts, not CDN/system installation or an author-selected font URL. Four unmodified Latin/Latin-ext WOFF2 files total 211,104 bytes, with a 281,476-byte base64 encoding. A small typography module remains separate from the payload, so ordinary renderer imports need not retain that payload. Copy the exact installed pinned bytes into a reviewed shared data module through the normal file-edit boundary; preserve individual SHA-256 commitments and the complete SIL Open Font License. A parity regression binds them to the existing main-chat dependency. No new dependency, lockfile change, asset-loader setup or installation is required.

Exact private native font routes are a viable alternative but would widen the request/CSP font boundary. Instead, qualify `FontFace` construction from fixed bounded `ArrayBuffer` bytes in the isolated preload under the unchanged CSP. If actual Electron refuses that strategy, preserve the failure and revisit the design explicitly; do not silently fall back to network permission or claim a declared family proves loaded glyphs.

The [CSS Font Loading specification](https://drafts.csswg.org/css-font-loading-3/#fontface-interface) distinguishes fixed binary `BufferSource` construction from URL-based loading. That is API evidence for the chosen input form, not evidence of Electron CSP acceptance, isolated-world font-set sharing or stylesheet persistence across document replacement; actual native checks must establish those separately.

## Decision and ordering

- Only generated viewers and their previews decode/load the four fixed faces. External MCP Apps do neither and retain their original lifecycle/policy.
- Native revocation must cancel an exact still-pending generated bootstrap even when uncertain process separation requires quarantine rather than forceful retirement. This terminal private cancellation is distinct from ordinary visibility/presentation hiding; a late font result cannot renew authority. Final source-commit ordering is separately reviewed and tested rather than inferred from successful late-ACK refusal.
- After the four faces load, the isolated bootstrap requests one source commit through its private native channel. Main reobserves the current exact frame/process and still-pending installation before granting that one commit. Keep the inert pulse and terminal cancellation active while waiting, inside the original absolute startup budget. Duplicate, foreign, revoked or uncertain readiness grants no parsing. The authorization point is that native commit, not an impossible claim of instantaneous cross-process JavaScript cessation after a later revocation. Source/ACK/action/retirement policy remains independently fenced.
- That commit also rechecks the trusted Host record's preparing membership, quarantine state, exact owner and absolute expiry through a cleared lifecycle callback. A delayed timer is cleanup, never permission to exceed the original startup budget. Generated success acknowledgement requires that exact one-shot commit; Apps keep their synchronous installation path.
- The payload has fixed descriptors, bounded canonical base64/decoded lengths, WOFF2 magic and digest qualification; no received selector, URL, path, CSS or font bytes may enter this loader. Use browser primitives, not Node/Buffer or a widened sandbox `require`.
- Keep the inert bootstrap heartbeat during asynchronous font readiness, within the existing absolute startup budget. Then clear that pulse, replace the document, add the already loaded faces to its font set before parsing private source, restore the existing relay/lifecycle and acknowledge installation only after font admission and the unchanged frame barrier. Source cannot execute while font admission is unresolved. Failure refuses installation; it must not report successful typography fallback.
- Main installs one fixed generated-only, user-origin family policy. Ordinary HTML, SVG text and controls use the exact chat sans family/fallback stack; semantic `pre`, `code`, `kbd`, `samp` and their descendants retain monospace. Preserve authored font sizes, weight/style, geometry and chart data. User-origin priority may override author `font-family: … !important` without accepting arbitrary stylesheet input. Actual document replacement/policy persistence must be qualified.
- Canonical generation guidance names the same family and requires canvas authors to await font readiness and use the resolved computed font when measuring/drawing text. CSS cannot safely override arbitrary Canvas2D/WebGL glyph drawing; do not intercept those APIs or rewrite immutable stored source.
- Explicit generated portable HTML includes the same fixed font faces, family policy and full license as a derived document. Reserve their actual UTF-8 bytes, plus any fluid helper, before asset expansion within the existing 16 MiB export bound. It carries no native API or Cafe capability. Original private source/commitments/posters remain immutable; executable exports remain outside Cafe's sandbox.

## Security, compatibility and resource consequences

There is no font fetch, provider/profile read, runtime installation, dynamic font route or `font-src` expansion. Four fixed faces and fixed payload storage are finite per-source overhead, separately accounted from the existing admitted-input and GL envelopes; they are not a RAM/GPU quota. Native retirement releases the document/font set with the existing exact owner. No growing font cache, visible-state reload or new timer/deadline is introduced.

The exact chat fallback chain remains authoritative for glyphs absent from DM Sans, including Japanese/Korean. Font equality is not identical platform glyph rasterization. Semantic raw diagnostic/code views remain monospace. External Apps, generic HTML attachments, Mermaid, existing image export authority and source inspection permissions are unchanged.

## Evidence gate

Require fixed-byte/license/hash/parity and malformed-decoder regressions, generated-versus-App isolation, original startup/watchdog/retirement tests and actual Electron-loaded normal/italic Latin/extended faces after document replacement. Qualify actual DOM/SVG/control computed families including an author-important axis, preserved semantic code, full-width/narrow natural layout and no root overflow. Capture only after loaded-font admission, and retain failures before diagnosis. Browser fixtures are separate from native loading proof. Full required repository tests and the last forced desktop build remain mandatory after source settles; hosted/native-platform/manual limits remain distinct. This accepted decision itself is not a verification result.

At 2026-10-13 13:23:24 JST (UTC+0900), the separate explicit font replay passed on the existing Electron42.10.0/bundled Node24.18.1/ABI146, local macOS arm64: six checks passed with two other native modes deliberately unselected. Actual loaded normal/italic Latin/extended faces were present before source parsing and survived replacement with the fixed user-origin policy. Authored metrics, semantic code, generated preview, App exclusion, full/narrow natural fit (264/336px), font-ready captures and exact retirement passed. The emitted preload retained the complete fixed OFL literal and excluded the unused portable CSS appendix. Fixed-byte parity/decoder tests11 and portable-export tests8 passed separately. This is isolated font evidence, not final whole-repository, Windows/Linux, parent-compositor, installed IME or release qualification; the original failed incomplete App fixture and its correction remain preserved in private evidence.

At 2026-10-13 13:40:12 JST (UTC+0900), the corrected frozen implementation also
passed all ten typecheck/default workspaces, full browser tests (2,091), exact
bar and comprehensive native replays, and the copied MCP bridge tests (four).
The default suite passed 8,967 tests with 12 existing skips and one expected
failure. Font-loaded browser cases cover 240/320/780/1600px layouts, strict
same-child computed-family equality, undistorted SVG glyphs and semantic code.
These passes retain unchanged startup, sandbox, action and retirement policy.
Final packaging must be recorded through the mandatory forced desktop build
last, bound to unchanged software; no live adoption or hosted/native-platform
result is inferred from these local tests.
