# Electron-Only Hosted Web Removal

Status: Complete
Last updated: 2026-05-21T11:32:33Z
Plan file: .plans/22-electron-only-hosted-web-removal.md

## 0) Guiding Constraints

1. Preserve the Electron desktop application and the local React/Vite renderer it loads.
2. Remove hosted static web deployment, hosted pairing, Vercel configuration, and marketing-site runtime surfaces.
3. Keep direct desktop/server pairing behavior only where it is still useful to an Electron-launched backend.
4. Do not revert existing rebrand/licensing edits or unrelated dirty worktree changes.
5. Require `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` before completion.

## 1) Glossary

- Electron shell: The native desktop app in `apps/desktop`.
- Renderer: The React/Vite UI in `apps/web` that Electron loads from local build output.
- Hosted static web app: The optional Vercel-deployed browser app and its channel/domain routing.
- Direct pairing: Pairing directly against the local or exposed backend `/pair` endpoint.
- Marketing site: The Astro site under `apps/marketing`.

## 2) Scope

### 2.1 Goal

Make Cafe Code Electron-only by removing hosted web/Vercel and marketing app surfaces while keeping the Electron renderer and backend functional.

### 2.2 Non-Goals

- Do not rewrite the renderer in native UI.
- Do not remove the server backend used by Electron.
- Do not remove SSH/Tailscale/direct remote backend access unless it is only coupled to hosted static web pairing.
- Do not delete legacy compatibility data unrelated to hosted web removal.

### 2.3 Assumptions

- `apps/web` remains necessary because Electron uses it as the renderer.
- Hosted web channel selection is unnecessary when the renderer always runs under Electron.
- Direct pairing URLs are sufficient for any remaining external backend access.

## 3) Milestone Plan

### 3.1 Milestone 1: Inventory And Boundary

- Deliverables:
  - Map hosted/Vercel/marketing references.
  - Identify contract fields and UI branches used only by hosted static pairing.
- Dependencies:
  - Existing source tree and current rebrand state.
- Acceptance Criteria:
  - Hosted-only files, envs, docs, and workflow sections are identified.
  - Renderer/server/desktop build dependencies that must remain are identified.
- Test Plan:
  - Targeted `rg` searches over repository source excluding dependency/build directories.

### 3.2 Milestone 2: Remove Hosted Web And Marketing Runtime

- Deliverables:
  - Delete hosted Vercel config and marketing app package.
  - Remove hosted web deployment workflow jobs/scripts/envs.
  - Remove hosted pairing URL generation and hosted channel selection.
  - Simplify endpoint compatibility away from hosted app compatibility.
- Dependencies:
  - Milestone 1 inventory.
- Acceptance Criteria:
  - No active source references to Vercel hosted app deployment remain.
  - No active source references to `app.t3.codes`, `latest.app.t3.codes`, or `nightly.app.t3.codes` remain.
  - Pairing UI offers direct backend links only.
  - Desktop packaging still builds from the renderer.
- Test Plan:
  - Unit tests adjusted for direct-only pairing and endpoint compatibility.

### 3.3 Milestone 3: Documentation, Package Graph, And Verification

- Deliverables:
  - Update docs to describe Electron-only architecture.
  - Remove marketing workspace/scripts from package graph.
  - Run required repository checks.
- Dependencies:
  - Milestone 2 implementation.
- Acceptance Criteria:
  - Docs no longer describe hosted web/Vercel as an active product surface.
  - Workspace/package metadata no longer includes the removed marketing app.
  - Required checks pass.
- Test Plan:
  - `bun fmt`
  - `bun lint`
  - `bun typecheck`
  - `bun run test`

## 4) Verification Matrix

| Requirement | Code Location | Test Coverage | Status |
| --- | --- | --- | --- |
| Preserve Electron renderer build path | `apps/desktop/src/electron/ElectronProtocol.ts:96`; `apps/server/scripts/cli.ts:168`; `apps/desktop/turbo.jsonc` | `bun fmt`; `bun lint`; `bun typecheck`; `bun run test` | complete |
| Remove hosted web/Vercel deployment | `.github/workflows/release.yml:417`; deleted `apps/web/vercel.ts`; package metadata | Required checks plus targeted search | complete |
| Remove hosted pairing UI/logic | deleted `apps/web/src/hostedPairing.ts`; `apps/web/src/components/settings/pairingUrls.ts:3`; `apps/web/src/components/settings/ConnectionsSettings.tsx` | Unit tests | complete |
| Simplify endpoint compatibility | `packages/contracts/src/remoteAccess.ts:40`; `packages/shared/src/advertisedEndpoint.ts:45`; desktop endpoint providers | Unit tests | complete |
| Remove marketing app surface | deleted `apps/marketing`; root scripts/workspaces in `package.json:31` | Required checks plus targeted search | complete |
| Update docs for Electron-only behavior | `README.md`; `REMOTE.md:113`; `docs/release.md:31`; `.docs/architecture.md:3` | Targeted search | complete |

## 5) Completion Formula

`completion = (completed acceptance criteria / total acceptance criteria) * 100`

Current completion: `100%`

## 6) Current Checkpoint

- Current Stage Flag:
  ```text
  /ᐠ > ˕ <マ 🌸 さいごチェック!!
  ```
- Active Milestone: 3.3 Milestone 3: Documentation, Package Graph, And Verification
- Current Task: Verification complete.
- Next Action: Report results.
- Blockers: None.
- Resume Point: Complete; no remaining plan work.

## 7) Verification Checklist

- [x] Hosted-only files, envs, docs, and workflow sections inventoried.
- [x] Renderer/server/desktop dependencies to preserve inventoried.
- [x] Hosted Vercel config and deployment workflow removed.
- [x] Hosted pairing and hosted channel UI removed.
- [x] Endpoint compatibility no longer exposes hosted app compatibility.
- [x] Marketing app surface removed from workspace/scripts/docs.
- [x] Electron renderer build path preserved.
- [x] Documentation updated for Electron-only behavior.
- [x] Targeted stale hosted-domain/Vercel/marketing searches completed.
- [x] `bun fmt` passed.
- [x] `bun lint` passed.
- [x] `bun typecheck` passed.
- [x] `bun run test` passed.

## 8) Execution Log

- 2026-05-21T11:00:39Z: Plan initialized.
- 2026-05-21T11:21:00Z: Removed hosted pairing source, Vercel config/workflow, marketing app, hosted endpoint compatibility, and primary hosted docs references.
- 2026-05-21T11:32:33Z: Refreshed lockfile, ran targeted stale-reference searches, and completed required verification. `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` passed. Lint retained 9 pre-existing warnings and no errors.

## 9) Handoff Payload (Copy 1:1)

When handing off this plan to another window/agent, copy the full plan exactly with no summarization and preserve the exact Current Checkpoint fields.
