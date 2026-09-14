# Virtual desktop compatibility probes

Recorded 2026-09-08 against Codex CLI 0.153.4 and Cafe's matching generated protocol. The Linux/Codex feature is implemented. This document separates current native/MCP qualification from the historical dynamic-tool experiments and the hardware/long-run checks still outstanding.

## Implemented native/MCP results

Host: Linux x64, NVIDIA RTX 4090, KDE Wayland. Private sessions: Sway 1.12 / wlroots 0.20.2 with GLES2, Wayland 1.26, private Xwayland. The statically built viewer uses SDL 3.4.14. Both Wayland and X11 viewer backends were run against private test displays; this is not a claim that every host desktop/driver combination was tested.

| Check                            | Measured result                                                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent native capture       | Correct 1280×800 lossless PNG and metadata without a viewer                                                                                    |
| Wayland viewer on NVIDIA         | Negotiated DMA-BUF import; actual presented red/green pixel values verified                                                                    |
| X11 viewer on NVIDIA             | Correct uncompressed shared-memory fallback; DMA-BUF not claimed on this path                                                                  |
| Native Wayland and Xwayland apps | Unicode `café 日本語`, pointer clicks, and key delivery verified                                                                               |
| Human control                    | Takeover, return, viewer disconnect, and cancellation of long Xwayland Unicode input verified                                                  |
| Worker ownership                 | Real create/rename/adopt/terminate, app survival after manager close, stale-PID rejection, explicit-stop fallback verified                     |
| Feature revocation               | Old capabilities rejected; apps remain alive; re-enable requires a fresh binding                                                               |
| Codex vision                     | Reads a fresh random code visible only in an actual desktop screenshot, plus red/green shapes                                                  |
| Codex input                      | MCP clicks and text appear in the native fixture; no desktop approval prompt                                                                   |
| Existing conversation            | Same native thread resumes with desktop tools, preserves a prior random conversation marker, then resumes without desktop tools                |
| Native packaging                 | AppImage helper executes; packaged resources, safe storage, SQLite, PTY, backend/provider health, renderer connection, and shutdown smoke pass |
| Short soak                       | 60 seconds of viewer activity with bounded RSS and descriptor growth                                                                           |

The live Codex probe uses a private temporary home and a regular, non-symlinked auth copy with mode 0600. It does not change the user's provider configuration. It removes private state after process shutdown and logs only fixed stage/capability results. Synthetic app output is used only to verify actual input.

### Packaged conversation correction (2026-09-08)

A real conversation in the AppImage exposed a missing dependency in the copied Desktop Control bridge: the multi-entry build had extracted its shared transport into a sibling chunk, which was present for earlier probes inside `dist` but absent from the private session directory. Codex consequently closed the initialization handshake with `ERR_MODULE_NOT_FOUND`. Both MCP entrypoints now build independently with code splitting disabled. The regression test fails on the previous artifacts and passes when copying either corrected entrypoint alone, including entries extracted from the AppImage and launched through that AppImage.

The corrected AppImage was also exercised through its actual UI and provider daemon with separate test settings and privately copied Codex authentication: enable Desktop Control, create a desktop, attach it to a new GPT-6-Astra conversation, and request a terminal running `btop`. Codex completed `observe`, `launch`, and `observe` calls, reported the visible CPU heading, and completed the turn. This verifies the packaged conversation handoff in addition to the earlier native/viewer probes; it does not extend the hardware or long-run qualification below.

The GPU test caught an SDL GLES2 issue: SDL initializes a borrowed texture and clears its imported EGL image binding. Rebinding the image after SDL texture creation fixed black presentation. Import success alone was insufficient; the test now checks actual presented pixels. The shared-memory path separately normalizes BGR/RGB and three/four-byte capture formats.

Codex's default MCP approval mode `auto` still prompted on destructive annotations despite thread approval policy `never`. Session-local `default_tools_approval_mode="approve"` implements the requested unrestricted desktop access. `required=true` avoids optional MCP startup/catalog races. Both settings are restricted to the session's Desktop Control definition; no general provider policies are changed.

### Saved observation history (2026-09-08)

The packaged app was tested with the default retention of 50 changed to 2 through MCP settings. A real Codex conversation made three observations around launching `btop`. Each completed MCP item retained its own validated observation reference; only the newest two PNGs remained available. Clicking the oldest tool call showed expiration, while the latest preview matched the stored PNG's SHA-256 and 1280×800 dimensions. After a full app/backend shutdown and restart, reopening the conversation displayed the same image and hash. Changing retention to 0 through the packaged UI retired the saved observations and removed their private PNG files.

Deterministic tests also cover the default 50-image limit across conversations, numeric validation, private-file integrity, interrupted-write recovery, hard-deletion/publication races, retryable cleanup, owner/thread authorization, reference redaction, and timeline correlation. Browser tests cover lazy preview loading, cancellation, expired/disabled/failed/legacy results, and the settings control. To repeat the manual packaged check, set retention to 2, request three `observe` calls, inspect the oldest/latest calls, restart and select the same conversation, then set retention to 0.

### Window management and compact paths (2026-09-08)

The opt-in lifecycle test with `CAFE_CODE_DESKTOP_WINDOW_E2E=1` runs two real Alacritty windows through the manager/tool boundary. It verifies tabbed visibility and focus, fullscreen/restore, floating pixel resize/position/center, sticky state, scratchpad hide and repeat-safe restore, workspace move/switch/rename, container split/swap, relative focus, subtree queries, and Sway partial-command failures. Both application IPC sockets exist in the compact runtime directory. Raw `exec` creates a fixture file; raw `exit` ends its owned worker and revokes the binding after normal status refresh. Native Wayland/X11 tests also cover command denial during human control, stale observation epochs, disabled access, oversized commands and a foreign compositor socket. These checks use real local processes but do not make additional model calls.

Canonical UUID encoding, all supported UID lengths, unsafe path/name rejection, byte/result bounds, argument injection and partial-result MCP error reporting have deterministic tests. A real Linux Unix socket binds with a 56-byte directory plus a 50-byte basename (107 pathname bytes). The lifecycle probe adopts a compact-path worker across manager restart and exercises explicit-Quit fallback cleanup. The old long-path demo format is intentionally retired without migration.

### Reproduce the implemented path

Use the repository-pinned Node and Corepack Yarn. First build the backend/native helper. The native tests require installed Sway, Xwayland, D-Bus, a usable render device and the development prerequisites listed in the native README. They create private test applications and do not use the user's browser or game profiles.

```sh
corepack yarn workspace @cafeai/cafe-code build:bundle
CAFE_CODE_VIRTUAL_DESKTOP_E2E=1 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/VirtualDesktopNative.e2e.test.ts integration/VirtualDesktopLifecycle.e2e.test.ts
CAFE_CODE_VIRTUAL_DESKTOP_E2E=1 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/VirtualDesktopFallback.e2e.test.ts
CAFE_CODE_VIRTUAL_DESKTOP_E2E=1 CAFE_CODE_DESKTOP_WINDOW_E2E=1 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/VirtualDesktopLifecycle.e2e.test.ts
CAFE_CODE_VIRTUAL_DESKTOP_E2E=1 CAFE_CODE_CODEX_DESKTOP_E2E=1 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/VirtualDesktopNative.e2e.test.ts
corepack yarn workspace @cafecode/web test:browser src/components/virtualDesktop/VirtualDesktops.browser.tsx src/components/settings/McpSettings.browser.tsx
```

`CAFE_CODE_DESKTOP_EXPECT_DMABUF=1` requires the Wayland viewer to negotiate DMA-BUF on qualified hardware. `CAFE_CODE_TEST_RENDER_DEVICE` selects the render node (default `/dev/dri/renderD128`). `CAFE_CODE_DESKTOP_TEST_HELPER` can select the helper unpacked from an AppImage. `CODEX_BIN` and `CAFE_CODE_DESKTOP_TEST_MODEL` select the installed provider/model. The Codex command makes bounded real inference requests through the current account; it stays off the default test path.

For long native resource qualification, add `CAFE_CODE_DESKTOP_SOAK_SECONDS=57600` for 16 hours (maximum 86400). This samples native viewer memory and descriptors once per second; a mixed provider/reconnect soak still needs its own workload. Do not enable real model calls continuously just to keep a resource soak running.

The packaged artifact smoke invokes Cafe's explicit `killall`. Run it on a dedicated test machine or in a PID namespace with its own `/proc`; a temporary HOME alone does not scope that command. The local smoke used a private Sway display and isolated PID namespace, while retaining the existing host session bus for the unlocked keyring. An entirely private test bus initially failed the existing safe-storage self-test because no keyring was available; all packaging/backend checks passed with that session service available.

The native worker now updates private service activation with Sway's display addresses and bridges `org.freedesktop.secrets` to the host keyring. `VirtualDesktopServices.e2e.test.ts` qualifies this using a synthetic keyring and isolated host/private buses: distinct client sessions, secret-body forwarding, cross-client rejection, properties/introspection, prompt signal routing, disconnect cleanup, bridge reactivation, and host-service outage/recovery. It also rejects unrelated interfaces/paths, oversized messages, and file descriptors. This does not qualify every keyring implementation or direct KWallet APIs. Host credential prompts remain on the host display; new desktop workers receive the setup.

On 2026-09-09, the bridge was also applied to the existing Axiom virtual desktop against the user's already-unlocked GNOME keyring. After relaunching Axiom to discard its old service connection, it loaded its existing signed-in account, model selector, and local conversation list without the credential-store error. No inference request was sent. Host unlock/consent UI remains unqualified by that check.

```sh
CAFE_CODE_VIRTUAL_DESKTOP_E2E=1 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/VirtualDesktopServices.e2e.test.ts
```

### Remaining release qualification

The 2026-09-10 regression checks forced the first GLES2 startup to fail after private session-service files were created, then verified real pixman rendering, a 1280×800 PNG capture, private directory permissions and exact-worker termination. The fallback recreates the entire attempt directory after verified exit. Native Wayland/X11 viewer checks also verified matching mouse releases over the toolbar and letterbox without losing focus or changing control. Deterministic authority/manager tests cover delayed and lost cancellation acknowledgements, preventing the previous turn's cleanup from cancelling a new owner. These checks do not qualify additional GPU hardware or a machine with no render device.

- Representative Intel/AMD Mesa, cross-GPU modifiers/import, device loss, and clean-machine distribution dependencies.
- A 16+ hour mixed provider/viewer/reconnect workload; only the short soak has run.
- Broad real-profile apps, host high-DPI/fullscreen transitions, profile-lock diagnostics, and measured latency/fps under load.
- Continuous gaming-key input, controllers and end-to-end VM/game input remain unqualified. Relative pointer capture has the bounded native fixture coverage below; the viewer otherwise supports text/IME and physical shortcuts.

The private display shares normal user access and real profiles; a host browser can intercept a launch through its existing singleton/profile lock. Cafe reports missing private windows rather than cloning profiles or killing host apps.

## Historical dynamic-tool results

The [opt-in probe](../packages/effect-codex-app-server/test/examples/codex-desktop-tools-probe.ts) uses Cafe's existing typed app-server client, its finite protocol reader, and an isolated temporary Codex home. It copies a regular, non-symlinked authentication file privately, makes bounded real model requests, reports capability booleans rather than model output, and removes the temporary home after the processes stop. No global Codex configuration is changed.

| Check                                                                                        | Observed result                                                                                               |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Register a function at `thread/start` and execute it                                         | Passed.                                                                                                       |
| Return text and have the model use it                                                        | Passed.                                                                                                       |
| Return `inputImage` in a dynamic-tool result                                                 | App-server accepts and reports the image, but Astra and Sol did not visually interpret it in the tested runs. |
| Use a namespaced dynamic image tool                                                          | Same image visibility problem on Astra.                                                                       |
| Attach the identical PNG directly to a user input                                            | Astra correctly identified the colors/shapes, isolating the problem to tool-result image delivery.            |
| Keep the dynamic callback and submit the image through `turn/steer` for the same active turn | Passed on Astra, including a repeat through Cafe's typed client.                                              |
| Restart app-server and resume a thread with previously registered tools                      | Passed.                                                                                                       |
| Supply a replacement tool catalog on resume                                                  | Ignored; the replacement tool was unavailable.                                                                |
| Add tools on resume to a real conversation originally created without them                   | Ignored; the added tool was unavailable.                                                                      |
| Disable `code_mode_host` as a compatibility experiment                                       | The text tool was unavailable; this is not a supported workaround.                                            |

The CLI's experimental schema export includes `dynamicTools` on `ThreadStartParams`, but not `ThreadResumeParams` or `ThreadForkParams`. Unknown fields can be ignored without a JSON-RPC error, so a successful resume response alone does not prove registration succeeded. The negative tests ask the model to call the new tool and check for an actual callback.

The image workaround remains a direct Codex integration, but changes the planned screenshot-delivery mechanism. It needs production tests for active-turn identity, cancellation, user-steer ordering, observation message identity, history recovery, and image redaction before being used in Cafe. A successful fixture-image test does not qualify those lifecycle behaviors.

There is no verified supported path here for adding dynamic tools to an already-created native Codex conversation. The user has since explicitly chosen a separate Desktop Control MCP instead. No new-conversation approval is pending. Preserve these measurements as historical evidence; qualify MCP session injection/resume and model image visibility independently.

## Reproduction

Use the repository-pinned Node and Corepack/Yarn toolchain after installing locked dependencies. Each invocation below starts real provider processes and uses the current account for small inference requests. They are deliberately excluded from the default test suite.

```sh
CAFE_RUN_CODEX_DESKTOP_PROBE=1 corepack yarn workspace effect-codex-app-server exec node test/examples/codex-desktop-tools-probe.ts
CAFE_RUN_CODEX_DESKTOP_PROBE=1 CAFE_PROBE_NAMESPACE=1 corepack yarn workspace effect-codex-app-server exec node test/examples/codex-desktop-tools-probe.ts
CAFE_RUN_CODEX_DESKTOP_PROBE=1 CAFE_PROBE_IMAGE_VIA_STEER=1 corepack yarn workspace effect-codex-app-server exec node test/examples/codex-desktop-tools-probe.ts
```

Optional `CODEX_BIN` and `CAFE_PROBE_MODEL` select the exact binary/model under test; they do not update Cafe's settings. The default model is Astra. `CAFE_PROBE_DISABLE_CODE_MODE_HOST=1` reproduces the unsuccessful feature-flag experiment in the isolated child only.

Exit zero means the text/image/resume path under test worked. It does **not** mean catalog replacement or attachment to an existing conversation worked: inspect the separate `replace` and `add-to-existing-thread` outcomes. The original image-delivery path currently exits nonzero; the image-steer experiment passes its narrower gate. Errors contain only a fixed stage/classification, never raw provider messages or credentials.

## Sway prerequisite check

A disposable private headless session started successfully on this machine using Sway 1.12, wlroots 0.20.2, the NVIDIA render device, and the GLES renderer. The session advertised:

- Linux DMA-BUF, wlroots export-DMA-BUF, and wlroots screencopy.
- Image-copy capture and output/toplevel capture sources.
- Virtual keyboard and virtual pointer support.
- A private Wayland output.

The prerequisite probe used its own runtime directory/configuration and was cleaned up. Advertisement alone did not establish import/input behavior; the implemented native checks above now verify actual pixels and actions. Cross-driver qualification remains open.

## Codex per-run MCP configuration

The installed Codex 0.153.4 was checked using `mcp get/list` in a temporary home, without user auth or model requests:

| Configuration case                                                                                                             | Result                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| A valid `cafe-desktop` definition with `enabled=false`, overridden with `-c mcp_servers.cafe-desktop.enabled=true`             | Enabled for that invocation; later invocation remained disabled.                                        |
| A full `mcp_servers.cafe-desktop={command=...,args=[...],env={...},enabled=true}` TOML inline table supplied only through `-c` | Recognized for that invocation; absent from later invocations and the global config.                    |
| Cafe management installed as `cafe-code` during either case                                                                    | Its registration remained enabled and unchanged.                                                        |
| A lone `enabled=false` override with no transport definition                                                                   | Rejected as invalid transport. Supply a valid complete definition when suppressing an inherited server. |

A further isolated check injected a full stdio table over an inherited HTTP `cafe-desktop` definition. Codex retained the old `url` and rejected the mixed transport during bootstrap. CLI overrides merge tables; runtime injection must preflight a same-name entry and reject incompatible/unmanaged definitions rather than assume replacement removes old fields.

The repeatable [opt-in configuration test](../apps/server/integration/CodexMcpConfiguration.e2e.test.ts) covers the positive cases and file preservation, including arguments containing spaces/quotes. Run it with the pinned Node/Corepack toolchain:

```sh
CAFE_CODE_CODEX_MCP_CONFIG_E2E=1 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/CodexMcpConfiguration.e2e.test.ts
```

`CODEX_BIN` selects the exact installed binary. The production adapter already creates one app-server process per root Cafe conversation. These checks establish launch-configuration behavior only; they do not establish app-server discovery, runtime reload/resume, model image visibility, or child-agent isolation. `-c` is a process-start override, not a live toggle. See the [separate-server integration plan](virtual-desktops-integration-plan.md#7-separate-mcp-servers-and-codex-session-integration).

## Current implementation state

Settings → MCP, its server toggle, default-user provider installers, a bounded local stdio/HTTP bridge, private credential refresh, and their tests are implemented. Codex 0.153.4, Claude Code 2.1.263, and Grok recognized generated registrations in isolated temporary homes without credentials or model requests. OpenCode follows Cafe's pinned SDK contract; no installed OpenCode binary was available for a native check.

The separate `cafe-desktop` endpoint/credential, per-session launch wiring, combined Desktop Control MCP switch, composer picker, manager/runtime, native viewer, and desktop tools are implemented. The live native/MCP and packaged-conversation checks above establish the measured support; general Cafe CLI configuration tests alone do not establish desktop behavior.

## Desktop UI and explicit ownership

The viewer's **Capture mouse** button (or **Ctrl+Alt+M**) forwards relative
displacement for captured applications such as Looking Glass. Absolute input
previously produced cumulative movement when the guest application held its
cursor fixed; the native reproduction turned two equal rightward movements into
10 and 20 pixels, then moved right again when the pointer moved left. Relative
input preserves displacement, including direction changes and queued motion.
Captured clicks do not reposition the pointer. The opt-in native fixture
exercises captured Wayland and Xwayland clients through both viewer backends,
the capture button, explicit release, focus loss and ownership handoff. Numeric
checks cover bounded displacement and coalescing across control epochs. This reproduces the protocol failure
without interacting with the user's VM; it does not qualify a full Looking Glass
or gaming workload. New workers advertise support; older active workers need
replacement before capture is available.

The native viewer's **Fit aspect ratio** button shrinks excess width or height,
accounting for the scaled toolbar and leaving input ownership unchanged. The
native fixture verifies wide/tall floating windows, image pixels at all four
corners, stable repeated fits, and leaving fullscreen on Wayland and X11 with
100%/130% toolbar scaling. Window managers can refuse programmatic resizing of
tiled windows; fitting does not override the host's tiling policy.

Host-cursor visibility is verified through actual outer-desktop pixels with a synthetic guest cursor hidden: watching keeps the host cursor, human image hover hides it, toolbar/letterbox hover restores it, and agent reclaim restores it without mouse motion. The native test runs those checks on Wayland and X11 with 100% and 130% toolbar scaling. The implementation also restores the cursor on pointer exit, unavailable frames, and viewer exit.

The native fixture now covers explicit human takeover and agent reclaim on Wayland and X11, including light/dark viewer chrome and 130% interface scaling. Hover, guest clicks and passive input cannot take ownership; `take_control` changes the worker epoch and requires another agent observation. The optional `CAFE_CODE_DESKTOP_QA_DIR` writes screenshots of the synthetic test desktop for visual inspection, never the user host desktop. Preview HTTP authorization, bounded captures, stale-incarnation rejection, inline screenshot lifecycle and Goal-matched composer typography have separate deterministic tests. This does not extend the hardware or long-duration qualifications above.

## Temporary sessions and display configuration

The 2026-09-10 checks verified name/resolution creation dialogs in the manager and composer, presets/custom dimensions with an aspect-ratio lock, independent persisted defaults, and session-only UI/MCP display changes. Dimensions remain bounded to 320–2048 pixels per axis at scale 1; larger/4K output is not supported by this implementation.

The native lifecycle test created a 1600×1200 session, changed it through the MCP to 1080×1920, changed it through raw Sway to 1920×1080, and verified fresh captures, drag endpoints beyond the original 1280×800 bounds, and rejection of pre-resize input. It also verified explicit End removal, stale PID/previous-boot cleanup without signalling an unrelated live process, and adoption of surviving workers. Unit tests cover retained cleanup failures and confirmed-exit ordering. Saved observations remain independent of desktop entries.

Wayland and X11 viewer tests verified actual presented pixels after landscape and portrait mode changes, separate viewer fitting, preserved human ownership, and rejection of model resize while the human has control. The forced software-fallback test also verified a live 720×1280 pixman capture. These tests use private native fixtures without live providers or credentials; they do not add Intel/AMD hardware qualification or app-session restoration.
