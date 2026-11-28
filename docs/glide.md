# Computer use in Cafe Code

Cafe delegates macOS desktop observation and input to OpenAI's installed
computer-use runtime. The former Cafe JavaScript interpreter, Sky compatibility
facade, Swift automation driver, focus routing and input policies are removed.
Cafe retains the per-chat Computer use control, authenticated provider bridge,
permission store, Stop controls and status-only menu bar UI.

This is a local integration with installed proprietary program artifacts, not a
public Sky SDK or a redistribution of OpenAI binaries. Cafe does not install,
patch or copy OpenAI's runtime, import its packages into the provider daemon,
read its accounts, or clone credentials and sessions.

## Requirements and setup

The currently qualified package interfaces are `@oai/sky` **0.7.18**, `@oai/cua`
**0.2.6**, and `@oai/cua-repl` **0.1.3**. Discovery checks fixed ChatGPT/Codex
application locations under `/Applications` and `~/Applications`, their bundled
`cua_node` Node/REPL and Codex executables, and the installed **Codex Computer
Use.app** component. Missing, noncanonical, unsafe or unsupported installations
leave computer use unavailable. There is no fallback to Cafe's retired driver.
An OpenAI update can require a new qualification before its interface is admitted.

1. Install a compatible OpenAI desktop app and its Computer Use component using
   that application's normal setup.
2. In a macOS Cafe chat with Codex, Claude Agent or Grok, enable **Computer use** in the
   composer. New chats start off. Existing preferences and per-app grants remain
   in Cafe's permission store.
3. OpenAI's native component owns Accessibility and Screen Recording setup and
   its native previews. Cafe reports these permissions as unknown rather than
   claiming its own TCC status proves an OpenAI grant. Older remote Cafe backends
   retain their original permission dialog through the additive protocol field.
4. Ask the agent to use the computer. A tool catalogue can be present before
   enablement; it grants no execution authority.

Browser and audio services are not configured. Windows and Linux are not
qualified by this integration. The menu bar UI is Cafe's status and
Stop surface; its executable can only display that UI, never observe or operate
applications. No new foreground fallback or system display/power setting is added.

## Execution and ownership

The execution path is:

```text
provider's private copied MCP bridge
  → authenticated Cafe chat broker
  → exact owned OpenAI node_repl stdio child
  → OpenAI trusted Sky service
  → installed OpenAI native computer-use component
```

Each execution owner gets a fresh private support `CODEX_HOME`; it receives no
provider authentication, histories, sessions, user Node hooks or loader hooks.
The matching bundled Codex executable supplies the REPL's host operations.
Plugin discovery is disabled only in this temporary support home, because this
computer driver needs no marketplace clones or plugin synchronization. User
and provider configurations remain separate.

Cafe keeps at most four execution owners. Each Node child receives a 256 MiB V8
old-space limit and an 8 MiB semi-space limit; native qualification checks the
resulting total V8 heap limit is at most 320 MiB. OpenAI's worker launch hook
preserves its exact sandbox command and policy while applying those fixed
memory flags. An OpenAI owner can contain a kernel, trusted worker and native host
support processes; this is not an aggregate memory guarantee. There is one
shared cell lane, at most eight queued cells per owner and a bounded global
queue. A queued cancellation withdraws that job without stopping or waiting for
another chat's held execution. Queue time consumes the original 30-second
(default), 60-second (maximum) cell deadline.

The broker checks the exact current chat, provider binding, active primary turn,
Full access, enabled grant and generation around asynchronous admission. OpenAI's
individual native app approval requests are accepted only for that same live
execution, its exact native tool-call ID and its granted desktop/app scope.
A delayed request from an earlier cell cannot borrow a later cell's grant.
Approval contains no persistence
selection, saved rule or permission for a different form, audio request or URL.
Native organization/app policy still runs independently before those requests.
A tool response is not application-goal verification.

Off, Stop, deletion, archive, access downgrade and session replacement fence the
old owner before cleanup. Native request cancellation, the exact turn-ended
hook, stdio retirement and native child close precede replacement or support-home
removal. Only retained child objects are signalled; there is no process scan,
PID-only reaper, OpenAI application restart or termination of the shared native
service. Already-dispatched input can still have effects and is never replayed
automatically.

Native stderr is drained without entering provider logs. Text and PNG/JPEG/WebP
results stay inside the authenticated tool response, with the existing frame,
code, timeout, item, decoded-image and total-output bounds. Unsupported output
kinds are refused. Cafe does not parse prose into native completion receipts,
window identities or screenshot previews. Its **Working** status describes owned
runtime activity, not proof that an OS event was delivered or a capture completed.

## Model interface

The historical `cafe-glide` MCP name and both copied bridge entry names remain
for provider compatibility. `js` forwards the original program to OpenAI's real
persistent kernel; `js_reset` retires that owned runtime and its bindings.
OpenAI supplies global `cua` through `@oai/cua/tinyskyAlt`, and its native API is
available through a dynamic import:

```js
var apps = await cua.listApps();
var editor = await cua.getApp("an observed application bundle ID");
await editor.getAXStateAndScreenshot();
```

```js
var { sky } = await import("@oai/sky");
var state = await sky.get_app_state({ app: "an observed bundle ID" });
nodeRepl.write(state.text);
```

Use the documentation emitted by the installed runtime and derive element
indices from a fresh observation. Static imports are not supported. App handles
support the native observation, click, drag, scroll, text selection, AX value,
keyboard, paste and secondary-action methods exposed by OpenAI. Native window
selection follows OpenAI's macOS interface; Cafe's former explicit `windowId`,
`typeInto`, focus, launch/restore helpers and synthetic action receipts are not
retained as invented compatibility methods. `@cafecode/glide` and
`@cafecode/computer` no longer provide a second interpreter or automation API.

### Qualified text limitation

The installed native `type_text` path delivered ASCII but dropped accented and
emoji characters in the disposable AppKit fixture. The native `paste` path
preserved `OpenAI café 👩‍💻` and the application accepted its button action.
Prefer `paste(text, { format: "text" })` for that text, and verify the resulting
field. Cafe does not patch OpenAI's typing implementation. Clipboard handling
follows OpenAI's native paste behavior.

## Qualification

Ordinary unit tests use an inert native MCP peer. They cover unchanged program
forwarding, private environments, app approval scope and stale reads, native
partial errors, output bounds, queued cancellation, exact child close and
cleanup. No OpenAI installation or provider credentials are required.

The complete transport fixture exercises both copied entry names across local,
daemon, supervisor and desktop placement with real HTTP, broker, adapter and
inert native MCP processes:

```sh
nice -n 10 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/GlideSessionPipeline.e2e.test.ts
```

Real OpenAI/native AppKit qualification is explicit opt-in:

```sh
nice -n 10 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/OpenAiComputerMac.e2e.test.ts
```

It uses a fresh private test application with a nonactivating floating panel,
exact launch-owner retirement and native WindowServer readiness on the active
Space. The panel can appear alongside a fullscreen app without activating
itself or changing the selected Space. It checks an actual screenshot, the
actual heap ceiling, ASCII typing, Unicode paste, an application result and
that this exact test application is not frontmost at its input/result receipts.
It does not infer global
cursor preservation from an interactive desktop or add Cafe focus-routing
enforcement. Missing installed components or permissions fail this command;
they do not become a synthetic success. This is not exhaustive qualification of
menus, hosted dialogs, off-Space work, every application, other OS versions,
provider inference, package signing or a currently running Cafe owner's adoption.
The earlier off-Space fixture produced native `cgWindowNotFound` and
`timeoutReached` errors; off-Space operation remains unqualified and Cafe adds
no fallback driver for it.

The build compiles only `mac-glide-tray` for Cafe's native status UI and no longer
builds or stages the retired `mac-glide` automation executable or
`glide-worker.mjs`. Rebuilding never restarts Cafe or migrates a running provider
session. A running owner must take up the new code through its normal lifecycle
before its behavior can be claimed.
