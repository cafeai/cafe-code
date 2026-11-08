# Cafe Code

A calm desktop home for your coding agents. Work with Codex, Claude, OpenCode,
Grok Build, and Axiom in one place, with project and standalone chats, tabs,
split panes, and a clear view of what your agents are doing.

Made in Japan with love. [日本語](README.ja.md)

![Cafe Code desktop with example projects, chat tabs, and split panes](./docs/images/cafe-code-desktop.png)

_Current source UI with synthetic projects and conversations. Provider features
depend on the selected runtime; source builds can include changes newer than the
latest release._

## Download and install

Get the latest desktop build from [GitHub Releases](https://github.com/cafeai/cafe-code/releases/latest).

| Platform             | Download      | Installation                                       |
| -------------------- | ------------- | -------------------------------------------------- |
| macOS, Apple Silicon | arm64 DMG     | Open the DMG and drag Cafe Code into Applications. |
| macOS, Intel         | x64 DMG       | Open the DMG and drag Cafe Code into Applications. |
| Windows, x64         | EXE installer | Run the installer for your user account.           |
| Linux, x64           | AppImage      | Make the AppImage executable and run it.           |

macOS release apps are Developer ID signed and notarized. Windows and Linux
artifacts are unsigned; Windows may display a publisher or SmartScreen warning.
Each release includes `SHA256SUMS.txt`. Other Linux formats and architectures
are available only through local builds, not the published release set.

Linux x64 users can also use the [user installer](docs/linux-packaging.md#install-or-update-with-cafe-code-up)
to download and verify the latest stable AppImage, add a desktop entry, and
install a `cafe-code` launcher. Run `cafe-code up` for subsequent updates.
It installs under your home directory without `sudo`, Node or a source build.

Packaged apps check for updates, but downloading and installing require your
action. Windows and supported AppImage builds offer in-app installation.
macOS releases through **0.2.0** require a manual DMG upgrade; current source
adds in-app updates for signed packages that opt in. Source checkouts use Git
branch update diagnostics instead of the packaged updater. See
[desktop releases and updates](docs/desktop-releases-and-updates.md).

Cafe Code is still in active development. CI includes macOS, Windows, and Linux
quality jobs and native artifact checks; provider and OS-specific behavior has
its own qualification limits. Check the release notes for the build you install.

The legacy registry package is behind the desktop releases. Use a release
download or a source checkout for a current installation.

## Set up a provider

Choose an account and model in the composer or **Settings → Providers**.
Cafe uses your provider accounts and their native permissions. Authenticate the
providers you want to use; you do not need to set up every provider.

| Provider   | Setup                                                                                                                     | Cafe support and notes                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Codex      | Install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.                                       | Native app-server integration, skills, advertised service tiers, code review, and subagent history.                                      |
| Claude     | Install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`.                                | Native Agent SDK integration, delivery/task controls, selected-message forks, and slash commands.                                        |
| OpenCode   | Install [OpenCode](https://opencode.ai/docs/) and configure an upstream provider, or connect an existing OpenCode server. | Local runtimes and configured server connections; remote servers have different file-access limits.                                      |
| Grok Build | Install [Grok Build](https://docs.x.ai/build/overview) and run `grok login`.                                              | Early Access ACP integration. See [setup and limits](docs/grok-build.md).                                                                |
| Axiom      | Install native AxiomCLI or the Axiom app, then use **Log In** in Cafe when required.                                      | Native ACP integration, account-bound history, and reply/attestation verification. See [setup and verification](docs/axiom-provider.md). |

The Windows installer can prepare a reviewed offline **Node/Codex/Claude runtime
bundle**, without changing your system PATH. Those bundled providers still need
authentication. Other installation paths use separately installed provider tools.
See [Windows managed providers](docs/desktop-releases-and-updates.md#windows-managed-providers).

## What you can do

- **Arrange your workspace.** Use [Desk tabs and split panes](docs/desk-tabs.md)
  alongside the saved Projects catalog. Open a [standalone chat](docs/standalone-chats.md)
  without a repository, or duplicate an idle Codex/Claude conversation with its
  resumable history. Duplicates share workspace files.
- **Keep work moving.** Queue prompts, edit unsent messages, and steer when the
  provider supports it. Inspect plans, tool activity, and
  [subagent history](docs/subagent-activity.md). Provider-specific controls keep
  their native account and permission boundaries.
- **Schedule a follow-up.** Create one-time or recurring work in Codex, Claude,
  and Grok chats through **Tasks → Scheduled**, or review a proposal from an
  agent. Agent proposals require approval; execution needs the owning backend
  online and the computer awake. [Scheduling guide](docs/scheduled-followups.md)
- **Share files and read rich output.** Attach images and other files, view
  [inline assistant images](docs/inline-images.md) with zoom and pan, render
  [Mermaid diagrams](docs/mermaid-diagrams.md) and [math](docs/markdown-math.md),
  and copy or save diagrams and tables as PNG.
- **Explore interactive output.** Full-access Codex and Claude sessions can
  publish [live visualizations](docs/agent-visualizations.md). Supported external
  MCP Apps use the same viewing surface. These execute privileged browser code;
  the guide explains the access requirements and limits.
- **Dictate a draft.** Use composer dictation, or optional
  [global dictation on macOS](docs/global-dictation.md) with an editable review
  before inserting text. Dictation uses a separately configured OpenAI API key
  and API credits.
- **Understand recorded usage.** Inspect token counts, cost quality, and time
  spent generating in [Usage and Atrium](docs/usage-statistics.md). Standard
  provider costs are API-rate estimates, not subscription invoices; Axiom uses
  its native settled cost receipts when available.
- **Connect from elsewhere.** Use the browser Web UI or save another Cafe server
  through pairing in Connections. Cafe does not create SSH or Tailscale tunnels.
  [Remote servers and LAN setup](docs/remote-environments.md)
- **Choose your language and tools.** English, Japanese, and Korean are available
  in **Settings → Appearance → Language**. Open local projects in an installed
  editor, file manager, or external terminal.

## Run from source

Install the exact Node.js LTS version in [`.node-version`](.node-version),
Corepack, and your platform's native build tools. Cafe tracks the newest LTS
line and pins Yarn through Corepack. macOS source builds require the Xcode
Command Line Tools, including Swift.

```bash
git clone https://github.com/cafeai/cafe-code.git
cd cafe-code
corepack enable
corepack yarn install --immutable
corepack yarn build:desktop
corepack yarn workspace @cafecode/desktop start
```

The start command launches existing build output. Rebuild after source changes,
or use the development workflow below. See [source setup and native prerequisites](docs/source-development.md).

## Local development

After installing dependencies and native prerequisites, start the desktop app
with development watchers:

```bash
corepack yarn dev:desktop
```

Desktop and backend development use the same reduced application dependencies
as desktop packaging, so missing shipping dependencies fail locally too. The
backend watcher runs the bundled server; build tools and types remain available
to the toolchain. See [source development](docs/source-development.md).

For a built checkout, enable the localhost-only debug endpoint with:

```bash
corepack yarn start:desktop:debug
```

Debug mode prints its URL at startup. Development defaults use separate ports
and state from a built desktop launch; use the URLs printed by the runner.

Required verification uses the pinned Node and Yarn. On macOS/Linux, start
CPU-heavy checks with `nice -n 10` and retain the existing worker/memory limits.
The forced desktop build runs last, after tests:

```bash
corepack yarn fmt
corepack yarn lint
corepack yarn typecheck
corepack yarn test
corepack yarn build:desktop --force
```

For complete bounded local qualification, including all required browser groups
and the forced build last, use `corepack yarn verify:local`. See
[local verification](docs/test-performance.md) for low-priority commands,
timings and warm-cache limitations; it needs no hosted test runners.

See [source development](docs/source-development.md) for the scoped CI
typecheck memory setting, [dependency maintenance](docs/dependency-updates.md)
for the Node/Yarn update policy, and [Contributing](CONTRIBUTING.md) for project
scope and contribution expectations.

## Guides

| Topic                | Documentation                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace            | [Desk and tabs](docs/desk-tabs.md) · [Standalone chats](docs/standalone-chats.md)                                                                                                                                                          |
| Prompts and activity | [Attachments and editable queues](docs/file-attachments.md) · [Steering](docs/steering-delivery.md) · [Live activity](docs/live-chat-activity.md)                                                                                          |
| Provider controls    | [Codex models and skills](docs/codex-model-and-skill-picker.md) · [Native review](docs/codex-native-review.md) · [Claude task controls](docs/claude-task-controls.md) · [Claude conversation actions](docs/claude-conversation-actions.md) |
| Rich output          | [Images](docs/inline-images.md) · [Diagrams and PNG export](docs/mermaid-diagrams.md) · [Math](docs/markdown-math.md) · [Visualizations and MCP Apps](docs/agent-visualizations.md)                                                        |
| Automation           | [Scheduled follow-ups](docs/scheduled-followups.md) · [Cafe management MCP and external-client setup](docs/cafe-mcp.md)                                                                                                                    |
| Connections          | [Remote servers, LAN, HTTPS, and firewall ports](docs/remote-environments.md) · [Connection recovery](docs/decisions/persistent-websocket-recovery.md)                                                                                     |
| Desktop              | [Releases and updates](docs/desktop-releases-and-updates.md) · [Local Linux packaging and AUR maintenance](docs/linux-packaging.md) · [Source development](docs/source-development.md)                                                     |
| Preferences          | [Usage statistics](docs/usage-statistics.md) · [Global dictation](docs/global-dictation.md) · [Interface languages](docs/internationalization.md)                                                                                          |
| Data profiles        | [Separate Debug and Production data](docs/data-profiles.md) · [Startup profile decision](docs/decisions/debug-data-profiles.md)                                                                                                            |

## Why Cafe Code?

Cafe Code began as a fork of [T3 Code](https://github.com/pingdotgg/t3code).
Its focus is a quiet, responsive home for coding-agent conversations: native
provider behavior, durable work, useful diagnostics, and controls that stay out
of the way. There is no embedded terminal or code editor. Use your own editor
and console alongside Cafe.

Bug fixes, performance, reliability, and security matter most. New features
should make everyday work clearer and calmer. See [Contributing](CONTRIBUTING.md)
before proposing a change.

<p align="center">
  <img src="./docs/images/cafe-code-character.png" alt="Cafe Code character" width="240" />
</p>

## License

Cafe Code is [AGPL-3.0-or-later](LICENSE). Upstream attribution is preserved in
[NOTICE.md](NOTICE.md).
