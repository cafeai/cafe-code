# Contributing

## Read This First

We are not actively accepting contributions right now.

You can still open an issue or PR, but please do so knowing there is a high chance we close it, defer it forever, or never look at it.

If that sounds annoying, that is because it is. This project is still early and we are trying to keep scope, quality, and direction under control.

PRs are automatically labeled with a `vouch:*` trust status and a `size:*` diff size based on changed lines.

If you are an external contributor, expect `vouch:unvouched` until we explicitly add you to [.github/VOUCHED.td](.github/VOUCHED.td).

## What We Are Most Likely To Accept

Small, focused bug fixes.

Small reliability fixes.

Small performance improvements.

Tightly scoped maintenance work that clearly improves the project without changing its direction.

## What We Are Least Likely To Accept

Large PRs.

Drive-by feature work.

Opinionated rewrites.

Anything that expands product scope without us asking for it first.

If you open a 1,000+ line PR full of new features, we will probably close it quickly and remember that you ignored the clearly written instructions.

## If You Still Want To Open A PR

Keep it small.

Explain exactly what changed.

Explain exactly why the change should exist.

Do not mix unrelated fixes together.

If the PR makes anything resembling a UI change, include clear before/after images.

If the change depends on motion, timing, transitions, or interaction details, include a short video.

If we have to guess what changed, we are much less likely to review it.

## Verification Resource Budget

Use the repository-pinned Node and Corepack Yarn versions described in
[Run From Source](README.md#run-from-source). All quality gates remain required.

CI and release verification set `NODE_OPTIONS=--max-old-space-size=4096` only
for their Typecheck step and run `corepack yarn typecheck`. The canonical script
caps Turbo at three concurrent tasks while retaining the entire package graph.
A cold server compile exceeds the approximately 2 GiB default V8 heap on hosted
macOS. Each compiler retains a 4 GiB heap ceiling; three ceilings can reach
12 GiB plus native/OS allocations, not a total memory guarantee on smaller runners.

Use that same environment setting and command when reproducing CI typechecks.
Do not append another `--concurrency` to the canonical script: Turbo rejects
duplicate options. For a smaller constrained-host run, use the complete local
coordinator with `corepack yarn verify:local --typecheck-concurrency=1` or invoke
`corepack yarn exec turbo run typecheck --concurrency=1` with the same scoped heap.
A warm TypeScript build-info cache can hide the cold compiler's memory demand,
so a warm local pass alone does not qualify a resource-budget change. Keep heap
options scoped to verification rather than tests, builds, or shipped processes.
Workflow regression tests enforce this boundary; fresh GitHub quality and native
artifact jobs provide the platform checks.

## Issues First

If you are thinking about a non-trivial change, open an issue first.

That still does not mean we will want the PR, but it gives you a chance to avoid wasting your time.

## Be Realistic

Opening a PR does not create an obligation on our side.

We may close it. We may ignore it. We may ask you to shrink it. We may reimplement the idea ourselves later.

If you are fine with that, proceed.
