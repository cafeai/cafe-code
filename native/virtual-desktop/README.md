# Cafe virtual desktop native component

`cafe-desktop-native` has worker, viewer, and one-shot request roles. The worker
owns a private headless Sway and session bus, acts as a child subreaper, and owns
capture and virtual input. The SDL3 viewer runs on the host Wayland or X11 display.
It imports negotiated single-plane DMA-BUF frames on compatible EGL drivers and
falls back to sealed shared-memory frames. Both use descriptor passing over a
private authenticated Unix socket. The request role performs PNG encoding outside
the worker input loop. No VNC or video codec is involved.

Build through `node scripts/build-virtual-desktop.ts` using the pinned Node. Build
dependencies: a C/C++20 compiler, CMake, pkg-config, wayland-scanner, and development
headers for Wayland, libpng, json-c, xkbcommon, X11/XTest, GBM, EGL, GLES2, Pango/Cairo (`libpango1.0-dev`), and GIO (`libglib2.0-dev`).
The script downloads and verifies SDL 3.4.14, then caches a minimal static build;
system SDL is not required. CI's apt dependency list is in `.github/workflows/ci.yml`.
Runtime dependencies include Sway, Xwayland, dbus-daemon, the host display/GPU
libraries, libpng, json-c, xkbcommon, and GIO. No particular terminal or screenshot CLI
is required. The helper is a Linux-only resource, unpacked outside Electron ASAR.

The private display is not a filesystem sandbox. Apps use the real HOME and
profiles. A host browser can intercept a launch because its profile is already
locked; Cafe reports that without cloning the profile or killing the host app.

The worker updates **only its private D-Bus activation environment** once Sway
publishes the display addresses. It never imports them into the host systemd
user manager. Before accepting app launches, a separate `session-services`
process claims `org.freedesktop.secrets` and bridges the standard Secret Service
API to the same user's inherited host session bus. Other services retain the
private bus. Host keyring unlock/consent dialogs remain on the host desktop.
Direct KWallet APIs and unrelated host services are not bridged.

Each private client has a separate host bus connection, preserving Secret Service
session and prompt ownership. Replies, errors, properties, and targeted signals
are relayed without logging, caching, or decrypting credential bodies. Private
client disconnects close their upstream connections. The bridge admits at most
64 clients and 256 in-flight calls, limits bodies to 1 MiB, rejects descriptors
and unrelated paths/interfaces, and bounds connection setup to 3 seconds and
calls to 30 seconds. An unavailable host service returns an error; it never
switches to plaintext storage or launches a second keyring against host files.
A private runtime `.service` entry reactivates the bridge after a crash. Existing
credential sessions are invalid after a bridge or host-service restart; apps must
open new sessions. These changes apply when a desktop worker is started.

The opt-in `VirtualDesktopServices.e2e.test.ts` uses isolated buses and a synthetic
keyring to check client ownership, prompt routing, activation environments,
disconnect cleanup, restart recovery, and rejection paths without real secrets.

Protocol v1 uses `SOCK_SEQPACKET`, `SO_PEERCRED`, private capability files and
`SCM_RIGHTS`. Limits: 64 KiB control packets, one descriptor per packet, 32 MiB
frames, 8 MiB PNGs, 16 peers, one outstanding viewer frame, and 256 queued human
inputs. Freshness is capture/transport based, not inferred from pixel changes.
Published buffers are never recycled under a consumer. EGL consumers finish
before releasing imported buffers. Native key state is released on cancellation
and human handoff; Xwayland Unicode uses a disposable, bounded XTest helper.

The guest defaults to 1280×800 at scale 1. Creation and session display settings accept 320–2048 pixels per dimension; viewer resizing only scales the presentation. Mode/scale/transform changes cancel input, invalidate captured buffers and advance the worker epoch. The viewer rejects old-epoch frames and waits for fresh pixels before accepting input. It supports
text/IME input and physical shortcuts. **Capture mouse** (or **Ctrl+Alt+M**)
enables relative pointer input while the human has control. Use this for Looking
Glass or other applications that capture/lock their mouse. **Ctrl+Alt+M** releases
the mouse without giving up human ownership; **Ctrl+Alt+Enter** releases it and
returns control. Focus loss, stale frames, control changes, and viewer exit also
release capture. This is separate from Looking Glass's own capture toggle.
Ordinary viewer input and model screenshot-coordinate actions remain absolute.
An older running worker cannot acquire this capability by reopening its viewer;
start a new desktop with the rebuilt helper. Continuous gaming-key input,
clipboard sync, audio transport, and controllers remain outside qualification.
The toolbar uses cached Pango/Cairo text in the host sans-serif font, with Cafe light/dark colors and interface scale. Only its **Take control** button gives the human input ownership; hovering, moving/focusing the window, and clicking guest content while watching never do. **Return to Codex** or Ctrl+Alt+Enter returns control. The active agent can explicitly reclaim it through the `take_control` MCP tool. Worker ownership epochs fence every queued viewer input, and ownership changes are pushed immediately without waiting for another frame. The agent must observe again after reclaiming control. Closing the viewer
leaves apps running; termination reaps only worker-owned descendants.

**Fit aspect ratio** shrinks the viewer's excess width or height around the
displayed desktop, including the scaled toolbar. It works while watching or
controlling, leaves ownership unchanged, and keeps ordinary resizing available.
It restores maximized/fullscreen windows before fitting; tiling window managers
may require a floating window to honor the resize. Integer window dimensions
can leave less than one logical pixel of unused space per edge. Repeated fits
do not progressively shrink the window.

Outside explicit mouse capture, while the human controls a live viewer, its host cursor is hidden only
inside the rendered desktop image, which already contains the guest cursor.
The host cursor remains visible over the toolbar and letterbox margins, and
returns on control handoff, pointer exit, unavailable frames, or viewer exit.
Visibility follows the scaled image bounds and updates even without mouse motion.

Private Sway shortcuts use **Alt**: **F** fullscreen, **W** tabs, **S** stacking,
**E** toggle horizontal/vertical layout, **H/V** choose the next split,
**arrow keys** focus, **Shift+arrows** move, **Shift+Space** toggle floating,
**Space** switch floating/tiling focus, **A** focus parent, **Shift+Q** close,
**1–9** switch workspaces, **Shift+1–9** move to a workspace, **minus** show a
scratchpad window, and **Shift+minus** hide one. These are guest shortcuts;
host-global shortcuts can still intercept keys. **Ctrl+Alt+Enter** returns human
control to the model. The MCP offers equivalent window/workspace operations.

The worker's `sway_command` request intentionally allows all Sway syntax,
including `exec` and `exit`. It checks control ownership/epoch and rejects input
overlap before using only its own compositor's authenticated-identity IPC peer.
An absolute 500 ms IPC deadline and 2 MiB response cap bound worker blocking;
results retain up to 128 actual command replies within 60 KiB and explicitly
report partial failure/truncation. Never retry after an uncertain response.
Structured scratchpad restore checks current hidden state to avoid the raw
`scratchpad show` toggle. Runtime directories are at most 56 bytes, preserving
50 bytes for application socket basenames; arbitrary longer filenames may still
exceed Linux's socket limit.

Protocol XML retains upstream copyright/license notices. Screencopy and virtual
pointer are pinned to wlr-protocols commit
`bf4fc79abc359eea5a0edec0ac6d4a2b2955f82a`; virtual keyboard comes from wlroots
`0.20.2`; linux-dmabuf comes from wayland-protocols `1.49` (bound at version 3).
These are official freedesktop protocol sources. Do not regenerate from a moving
branch. SDL's license and the XML license notices ship under
`apps/server/dist/cafe-desktop-licenses`.

See [qualification and reproduction](../../docs/virtual-desktop-compatibility.md)
for opt-in tests, the NVIDIA results, and hardware/long-run checks still needed.

Desktop cards request transient 480px PNG previews through authenticated owner HTTP reads. They refresh on opening the manager or explicitly refreshing, without background streaming or saving these frames in conversation history.

Model observations also support exact RGB comparisons before PNG encoding and
explicit native-resolution crops. New workers advertise observation guards and
batch key validation; crop coordinates are rejected after window/display/control
changes. Launcher diagnostics retain only the last 64 direct-child exit states.
See [desktop tool efficiency](../../docs/desktop-token-efficiency.md) for the MCP
sequence/observation API, cancellation behavior, and measurement procedure.
