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
- Install and authenticate the providers you want to use. A source build does
  not install the Windows release's managed provider bundle.

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

Built launches normally use `~/.cafe-code/userdata`; launches with a development
URL use `~/.cafe-code/dev` under the same Cafe home. A configured
`CAFE_CODE_HOME` changes that base. Use the exact same home and development-mode
selection when issuing an [external MCP credential](cafe-mcp.md#external-mcp-clients).

## Debug mode

After building:

```bash
corepack yarn start:desktop:debug
```

The direct equivalent is:

```bash
corepack yarn workspace @cafecode/desktop start --cafe-debug
```

The debug endpoint is localhost-only and its URL is printed when debug mode is
enabled. Ordinary startup does not enable it.

## Verification

Use the pinned runtime and Corepack Yarn. On macOS/Linux, start CPU-heavy
verification with `nice -n 10` so child workers inherit the lower priority.
For example:

```bash
nice -n 10 corepack yarn fmt
nice -n 10 corepack yarn lint
NODE_OPTIONS=--max-old-space-size=4096 nice -n 10 corepack yarn typecheck --concurrency=1
nice -n 10 corepack yarn test
nice -n 10 corepack yarn build:desktop --force
```

Keep the typecheck heap option scoped to that command, as in CI. Windows uses
the same Yarn tasks and existing bounded-worker policy without `nice`; set
`NODE_OPTIONS` only for its typecheck invocation. See the
[verification resource budget](../CONTRIBUTING.md#verification-resource-budget).

The forced desktop build is the final verification after tests. Live-provider
and native artifact checks are separate opt-in or CI commands; passing isolated
tests on one host does not qualify every provider or operating system.

See [dependency maintenance](dependency-updates.md) for pin updates and
[Linux packaging](linux-packaging.md) for local package targets.
