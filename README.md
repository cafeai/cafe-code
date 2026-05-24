# Cafe Code

![Cafe Code desktop screenshot](./docs/images/cafe-code-desktop.png)

Made in Japan with love.

**Warning**: Large parts of the application are currently under development and have been completely rewritten. It may take some time for the system to become stable.

_Cafe Code is very small, barely does a thing at all. Chat goes in and chat comes out, soft and sweet, without a shout._

Cafe Code is a tiny desktop GUI for coding agents. It is a fork of [T3 Code](https://github.com/pingdotgg/t3code), with a basket of bug fixes, a little sweep-up, and some very opinionated trimming for people who want the agent chat and not much else.

It is meant to stay light, calm, and out of the way — not freeze, drag, or get all sleepy like so many other clients do.

T3 Code said it wanted to be minimal. Cafe Code went even smaller.

No terminal drawer. No pretend IDE. No giant dashboard wearing a useful-looking hat. If you want a console, use a real console. If you want to inspect code, open it in VS Code.

<p align="center">
  <img src="./docs/images/cafe-code-character.png" alt="Cafe Code character" width="360" />
</p>

## Why Fork?

Because the app should stay small, fast, and predictable.

Bug fixes are welcome. Performance fixes are welcome. Reliability fixes are
welcome. Security fixes are extra welcome.

Feature requests need to pass the tiny-window test: does this make Cafe Code
smaller, calmer, faster, easier to understand, lower CPU, lower memory, or less
annoying when something fails?

If yes, maybe.

If it turns Cafe Code into a pretend IDE, a pretend terminal, a release
dashboard, a project-management suite, or a museum of buttons, no.

## What Changed From T3 Code

This is the practical working list. It will probably get cleaned up later.

- Completely rewrote the lifecycle system to be more inline with Codex and Claude.
- Numerous bug fixes.
- Excessive debugging information.
- Rebranded the app around Cafe Code.
- Moved local app data into `~/.cafe-code`.
- Removed the in-app terminal drawer and terminal UI.
- Removed hosted web-app assumptions and focused the project on the Electron app.
- Disabled update checks until Cafe Code has its own release path.
- Added a queue/follow-up workflow for prompts sent while a provider is running.
- Added provider-aware queue actions: steer when supported, interrupt when that
  is the honest behavior.
- Added thread moving between project folders and working directories.
- Added "Move to Recycle Bin", "Recently Deleted", restore, permanent delete,
  and empty recycle bin flows.
- Added a default editor setting for VS Code, Antigravity, Finder, or system
  default.
- Made file-change rows and path pills open real paths instead of truncated
  display text.
- Added a localhost-only debug endpoint behind `--cafe-debug`.
- Reduced needless Git polling and checkpoint churn.
- Hardened hidden checkpoint handling, ignored-file capture, and old ref pruning.
- Fixed provider/session edge cases around reconnects, stale running state,
  resume metadata, and null checkpoint timestamps.
- Removed or hid features that do not belong in a minimal coding-agent shell.

## Run From npm

For now there are no desktop packages. No DMG, no updater, no notarized bundle,
no "drag this into Applications" ceremony.

Run Cafe Code directly from npm:

```bash
npx @cafeai/cafe-code
```

`npx` downloads the package if needed and starts Cafe Code immediately.

If you want a normal command on your machine:

```bash
npm install -g @cafeai/cafe-code
cafe-code
```

Cafe Code expects at least one provider to already be installed and
authenticated:

- Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
- Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`

OpenCode exists in the codebase, but Cafe Code is currently developed around
Codex and Claude first.

## Local Development

Run the app from a checkout:

```bash
bun install
bun start:desktop
```

Run the desktop package directly:

```bash
bun --cwd apps/desktop start
```

Debug mode:

```bash
bun --cwd apps/desktop start -- --cafe-debug
```

The app prints a localhost-only debug URL on startup.

Useful checks:

```bash
bun fmt
bun lint
bun typecheck
bun run test
```

Do not run `bun test`; this repo uses `bun run test`.

### Local Arch Package

Build a local pacman package from the Linux AppImage artifact:

```bash
bun install
bun run dist:arch:local
sudo pacman -U release/arch/cafe-code-*.pkg.tar.zst
```

To build and install in one step:

```bash
bun run dist:arch:local -- --install
```

This is intentionally local packaging only. It does not create AUR metadata or
publish anything.

## 日本語でちゅ

Cafe Code は、Codex とか Claude とお話するための、
ちいさめデスクトップアプリだわ。

T3 Code から fork して、
バグ直して、重いところ軽くして、
いらない機能はぽいぽいした。

ターミナルいらない。
でかいダッシュボードいらない。
ボタンだらけの謎コックピットもいらない。

コード見たいなら VS Code ひらこ。
コンソール使いたいなら、本物のコンソール使お。

Cafe Code は、チャットする。
作業を見る。
邪魔しない。
それだけ。えらい。

### npm から動かす

まだ DMG とか、インストーラーとか、アップデーターとかはないよ。
今は npm からそのまま起動するのがいちばん素直。

```bash
npx @cafeai/cafe-code
```

`npx` は、必要ならパッケージを取ってきて、そのまま Cafe Code を起動するよ。
「インストールだけ」じゃなくて、これで起動までいく。

Codex を使うなら先に `codex login`。
Claude を使うなら先に `claude auth login`。
そこは自分でログインしておいてね。

```bash
bun fmt
bun lint
bun typecheck
bun run test
```

`bun test` は使わないでね。
このリポジトリは `bun run test` の子なの。

## License

Cafe Code is AGPL-3.0-or-later.

The fork keeps the upstream attribution story intact; see the license and notice
files for details.
