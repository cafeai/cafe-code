## Provider compatibility target

- Claude Code:
- Claude Agent SDK:
- Codex CLI:
- Codex app-server protocol ref:

## Official delta audit

- Release/changelog links:
- New protocol or SDK discriminants:
- New capabilities Cafe Code exposes in this PR:
- Provider-owned capabilities intentionally left provider-owned:
- Security, lifecycle, auth, credential, and privacy impact:

## Deterministic evidence

- [ ] `corepack yarn providers:conform smoke`
- [ ] `corepack yarn fmt:check`
- [ ] `corepack yarn lint`
- [ ] `corepack yarn typecheck`
- [ ] `corepack yarn test`
- [ ] `corepack yarn build:desktop`
- [ ] Installed CLI probes match the approved matrix
- [ ] Update/relaunch recovery was tested without secrets in argv or logs
- [ ] Floating standalone layouts remain manual unless an exact-version boundary is implemented
- [ ] Unsupported layouts are reported before shutdown, and the workflow refuses to stop the app when no provider is safely actionable
- [ ] Compatibility-pinned providers cannot use the live in-app updater or bypass the approved version

## Platform gates

- [ ] macOS CI
- [ ] Ubuntu CI
- [ ] Arch Linux CI
- [ ] Windows CI
- [ ] Native artifact gates remain green where applicable

Keep this PR focused. Do not combine unrelated Cafe Code customizations, and do not mark it
ready until every required check is green.
