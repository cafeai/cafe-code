# Cafe Code

A minimal AI chat harness for coding agents.

Cafe Code is a tiny local UI for Codex and Claude. It is a fork of
[T3 Code](https://github.com/pingdotgg/t3code), trimmed down around one idea:
type a prompt, let the agent work, and keep the interface quiet, fast, and out
of your way.

No terminal drawer. No pretend IDE. No release dashboard. If you want a console,
use a real console. If you want to inspect code, open it in VS Code.

## Run From Bun For Now

The npm package exists, but it may lag behind current work until Cafe Code
stabilizes. For now, the freshest path is a Bun checkout from GitHub.

Mostly tested on macOS. Windows seems to work. Linux may need some tweaking.

Install [Bun](https://bun.sh/docs/installation) first if it is not already on
your machine, then run:

```bash
git clone https://github.com/cafeai/cafe-code.git
cd cafe-code
bun install
bun run build:desktop
bun run --cwd apps/desktop start
```

If you want Codex or Claude to install it for you, paste this:

```text
Install Cafe Code from source with Bun. Clone https://github.com/cafeai/cafe-code.git, install Bun if it is missing, run bun install, run bun run build:desktop, then start it with bun run --cwd apps/desktop start. Also verify Codex CLI is installed and logged in with codex login, and Claude Code is installed and logged in with claude auth login if I want Claude support.
```

## npm Path

```bash
npx @cafeai/cafe-code
```

`npx` downloads the package if needed and starts Cafe Code immediately, but it
may be out of date for now.

If you want a normal command on your machine:

```bash
npm install -g @cafeai/cafe-code
cafe-code
```

Cafe Code expects providers to already be installed and authenticated:

- Codex: install Codex CLI and run `codex login`
- Claude: install Claude Code and run `claude auth login`

## Notes

The npm package launches the Electron desktop app. Desktop installers are not
published yet.

For server-only use, run:

```bash
cafe-code-server
```

## License

AGPL-3.0-or-later.
