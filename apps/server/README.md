# Cafe Code

A minimal AI chat harness for coding agents.

Cafe Code is a tiny local UI for Codex and Claude. It is a fork of
[T3 Code](https://github.com/pingdotgg/t3code), trimmed down around one idea:
type a prompt, let the agent work, and keep the interface quiet, fast, and out
of your way.

No terminal drawer. No pretend IDE. No release dashboard. If you want a console,
use a real console. If you want to inspect code, open it in VS Code.

## Run

```bash
npx @cafeai/cafe-code
```

`npx` downloads the package if needed and starts Cafe Code immediately.

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
