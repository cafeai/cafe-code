# Source setup and development

Use a [desktop release](https://github.com/cafeai/cafe-code/releases/latest)
for an installation without a local build toolchain. Source checkouts can contain
changes newer than those releases.

## Prerequisites

- Install the exact standalone Node.js LTS version in [`.node-version`](../.node-version).
  The repository tracks LTS rather than the non-LTS Current release.
- Install Corepack and run `corepack enable`. The repository's `packageManager`
  field selects Yarn 4.17.1. Use Corepack Yarn for package operations and Node
  for JavaScript/TypeScript execution.
- Install Git and the native compiler tools needed by Electron's dependencies.
  On macOS, install Xcode Command Line Tools: the desktop build invokes
  `xcrun swiftc` for the bundled dictation helper, including when you do not use
  dictation. Linux needs its normal C/C++ build toolchain; building a Linux
  package also needs the libraries and utilities for its selected target.
  Windows native dependency builds need the supported Visual Studio C++ tools
  and Python required by node-gyp.
- Install the provider executables you want to use. A source build does not
  install the Windows release's managed provider bundle. Debug provider setup
  is separate from release accounts; an installed executable is not an account
  or permission to reuse its default authentication store.

## Build and run

```bash
git clone https://github.com/cafeai/cafe-code.git
cd cafe-code
corepack enable
corepack yarn install --immutable
corepack yarn build:desktop
corepack yarn workspace @cafecode/desktop start
```

`corepack yarn start:desktop` is the root convenience command for the same
built desktop. Neither start command builds the app. Run `build:desktop` again
after changing source; launching an existing desktop package directly also
requires built output.

Source launchers require successful Debug-profile build receipts for both the
desktop and server bundles. These bind their exact emitted JavaScript bytes,
including shared chunks; missing, legacy or inconsistent output refuses with a
`yarn build:desktop` rebuild instruction before launching an app or provider.
Watch builds publish each receipt only after their successful output settles.
These receipts also bind the local reduced dependency generation. Application
dependencies are copied from the production runtime workspace using the same
exclusions as desktop packaging. The application loader refuses to borrow a
missing package or file from the checkout's development dependencies, including
inside the PDF extraction child. Build tools/types remain installed for
compilation and tests. Default production bundles omit source maps, and the
launcher-owned Electron copy keeps only English, Japanese and Korean resources.
Desktop and backend build tasks execute freshly rather than restoring a cached
builder-private dependency pointer; their ordinary build dependencies can still
use Turbo caching. Old dependency generations remain available to held processes.
The desktop build depends on the backend build, which depends on the renderer
build. A forced desktop build therefore recompiles the renderer before copying
its assets into the backend and completing the desktop output.
See [desktop payload selection](desktop-releases-and-updates.md#desktop-payload-selection).
Diagnostic flags and ambient profile variables cannot make an old bundle safe;
there is no automatic rebuild or Production fallback. Packaged release behavior
is unchanged.

On Linux without `DISPLAY` or `WAYLAND_DISPLAY`, the source launcher starts the
built backend in headless server mode. Use its browser Web UI rather than
expecting an Electron window.

## Development watchers

```bash
corepack yarn dev:desktop
```

The runner prepares the development stack and starts its watchers. The default
backend is HTTP `13773`, HTTPS `13775`, with Vite at `5733`. A busy port or
`CAFE_CODE_DEV_INSTANCE` / `CAFE_CODE_PORT_OFFSET` can select another instance;
always use the printed URLs.

The backend watcher compiles with the same bundler configuration as the desktop
backend, then runs `dist/bin.mjs` against that reduced dependency generation.
It validates the successful build receipt and joins its exact previous child
before starting a replacement. `corepack yarn dev:server` uses the same watcher;
direct TypeScript server/provider launches refuse with a rebuild instruction.
Vite retains hot updates for renderer development. These commands keep the
normal Debug data profile.

All source desktop launches use a persistent **Debug data profile**, including
normal built `start:desktop`, explicit diagnostic starts and development
watchers. Their database is `~/.cafe-code/.debug/userdata/state.sqlite` on
macOS/Linux, or `%USERPROFILE%\.cafe-code\.debug\userdata\state.sqlite` on
Windows. Built and watched source runs share that Debug profile; the Vite URL
does not select another database. A leading-dot directory is supported on
Windows but is not automatically hidden there.

Installed packaged releases retain the standard Production database at
`~/.cafe-code/userdata/state.sqlite` (the equivalent home-root path on Windows).
Starting a release with diagnostic logging does not change its profile. Source
windows and their native app identity are labeled **Cafe Code (Debug)**. The
copied macOS source app/helpers use the `com.cafeai.cafecode.debug.runtime.*`
family, with a stable suffix derived from the canonical checkout path, and a
separate Debug runtime cache. The immutable native source host uses its new
version 2 namespace; the old host and held runtime copies remain untouched.
Installed release identities and Electron dependencies
are not modified. A new native identity can require separate OS consent; no
release consent, browser profile or credentials are copied.

`CAFE_CODE_HOME` remains the configured parent root. Debug appends `.debug`
exactly once before deriving its settings, secrets, caches, attachments,
workspaces and runtime state. Debug starts fresh and then persists normally;
neither Production nor the older `dev/` directory is imported or moved. There
is no automatic fallback to Production if Debug startup fails. Use the same
configured root and an explicit Debug profile when issuing an
[external MCP credential](cafe-mcp.md#external-mcp-clients).

The separate profile is not an OS sandbox. Explicitly selected project folders
are still shared files. Connecting the Debug desktop to an existing remote
server uses that server's own data, not a Debug copy. Provider executables can
also be shared; reusing the same online provider account shares its quota.
Do not run older source controllers from the same checkout concurrently: their
pre-profile cleanup logic cannot be changed by a new Debug instance.

### Explicit maintenance targets

Developer maintenance must not guess which profile you meant. The existing
activity-payload cleanup utility requires `--db` even for its default dry run:

```bash
nice -n 15 corepack yarn db:compact-activity-payloads --db "/absolute/path/to/selected/state.sqlite"
```

Choose the exact Production or Debug database deliberately; the command does
not derive a target from `CAFE_CODE_HOME`, diagnostic flags or a running app.
Omitting the target refuses before inspecting a database. Its existing
`--write`, `--vacuum` and minimum-payload options are unchanged; no automatic
maintenance, database copying or compression service is introduced by profile
separation. Do not use maintenance to import Production into Debug.

## Saved environments

Saved environments in Settings can be edited without a working connection. The
edit dialog updates the name, IP address or hostname, and port on this device;
it also contains the confirmed Delete action. Names stay local when reconnecting,
and address changes keep the same environment identity and saved credential.
Drag the row handles to reorder saved environments, or focus a handle and use
Space, the arrow keys, and Space again. The order persists on this device.

## Diagnostic logging

After building:

```bash
corepack yarn start:desktop:debug
```

The direct equivalent is:

```bash
corepack yarn workspace @cafecode/desktop start --cafe-debug
```

The debug endpoint is localhost-only and its URL is printed when diagnostics
are enabled. Ordinary source startup uses Debug data but does not enable that
endpoint. Storage profile and diagnostic logging are independent.

### Startup diagnostics

The desktop manager's `backend exited unexpectedly` line reports the child exit,
not its cause. Debug mode retains the backend output in `logs/server-child.log`
under the selected state directory. Inspect the matching startup attempt's error
before changing data or configuration.

`Web Push disabled; Cafe startup continues` means private push state could not be
safely initialized. Its fixed `phase` and `detail` explain whether secure reading,
decoding, or initial owner reconciliation failed. A directory security refusal
requires owner-controlled, unlinked ancestry without group/other write access;
Cafe does not weaken that requirement or change home-directory permissions.
Chat and backend startup remain available, but push operations fail explicitly.
No replacement keys, subscription reset, background retry or delivery is admitted.
Preserve the existing state for recovery; do not delete it to hide the warning.

### Notification preferences

On macOS, each checkout has its own source runtime bundle identifier and every
launch verifies and registers its exact signed copy with LaunchServices,
including when reusing a cached runtime. A shared Debug bundle identifier can
otherwise resolve to another checkout and open Electron's default window there;
refreshing that shared registration alone does not guarantee which copy macOS
prefers. Registration refreshes only the selected Debug app and never resets
LaunchServices or unregisters another app. The version 2 native host admits only
the bounded source-runtime identifier family and a matching valid code-signing
identity. The new native identity may require fresh OS consent on the next
normal launch; no existing host, grant or running app is replaced. Notifications
already posted by an older identity retain their original OS association.
A notification still routes
only to its original live renderer document and scoped chat.

Settings → Notifications has separate, opt-in controls for chat completion and
structured user-input requests. Each preference defaults to off and is saved in
client settings. Input notifications use a fixed localized message without
question contents; clicking one opens its chat. The desktop app suppresses
notifications for the currently focused chat and seeds its initial snapshot
without announcing existing prompts. Answered prompts retire delayed desktop
delivery. Browser Web Push stores both category preferences on the same private,
authenticated subscription; legacy subscriptions retain completion delivery
only. Disabling one category keeps the subscription while the other is enabled.
Both categories retain the existing scheduled-follow-up notification policy and
session revocation checks. Native OS delivery and closed-browser push delivery
remain separate manual host checks from synthetic notification fixtures.

## Verification

Use the pinned runtime and Corepack Yarn. On macOS/Linux, start CPU-heavy
verification with `nice -n 10` so child workers inherit the lower priority.
For example:

```bash
nice -n 10 corepack yarn fmt
nice -n 10 corepack yarn lint
NODE_OPTIONS=--max-old-space-size=4096 nice -n 10 corepack yarn typecheck
nice -n 10 corepack yarn test
nice -n 10 corepack yarn build:desktop --force
```

Keep the typecheck heap option scoped to that command, as in CI. Windows uses
the same Yarn tasks and existing bounded-worker policy without `nice`; set
`NODE_OPTIONS` only for its typecheck invocation. See the
[verification resource budget](../CONTRIBUTING.md#verification-resource-budget).
The canonical typecheck and complete-local coordinator default to three workspace
compilers; this does not increase Node/browser test workers or build concurrency.

The forced desktop build is the final verification after tests. Live-provider
and native artifact checks are separate opt-in or CI commands; passing isolated
tests on one host does not qualify every provider or operating system.

See [dependency maintenance](dependency-updates.md) for pin updates and
[Linux packaging](linux-packaging.md) for local package targets.
