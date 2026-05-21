# Codex Idle Token Drain Investigation And Fix

Status: Complete
Last updated: 2026-05-21T11:57:29Z
Plan file: .plans/23-codex-idle-token-drain.md

## 0) Guiding Constraints

1. Fix or conclusively rule out the local source of upstream T3 Code issue #2720: Codex plan credits being consumed while the app is idle.
2. Do not use Selene for this task.
3. Keep searches targeted to this repository and relevant upstream issue/PR pages.
4. Prefer preventing background network/API activity over preserving eager provider metadata refresh.
5. Preserve user-initiated provider refresh and actual turn execution.
6. Require `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` before completion if code changes are made.

## 1) Upstream Evidence

- Issue: https://github.com/pingdotgg/t3code/issues/2720
- Status at inspection: Open, filed 2026-05-15.
- Reported behavior: Codex Pro credits drain while the app is idle/minimized, with activity stopping when T3 Code processes are killed.
- Reported recurring activity: `model/list`, `account/rateLimits/read`, and expensive `responses_websocket`/`sse::responses` bursts.
- Reported strongest suspects:
  - `probeCodexAppServerProvider` spawns `codex app-server` during provider status refresh.
  - `makeManagedServerProvider` runs an unconditional refresh loop every provider `refreshInterval`.
  - `CodexDriver` sets the snapshot interval to 5 minutes.
  - `ProviderSessionReaper` skips stale sessions whenever `activeTurnId != null`.

## 2) Local Initial Findings

1. `apps/server/src/provider/Drivers/CodexDriver.ts` sets `SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5)` and passes it to `makeManagedServerProvider`.
2. `apps/server/src/provider/makeManagedServerProvider.ts` forks an unconditional `Effect.forever(Effect.sleep(...).flatMap(refreshSnapshot))` loop.
3. `apps/server/src/provider/Layers/CodexProvider.ts` probes via `codex app-server`, then sends `initialize`, `account/read`, `skills/list`, and `model/list`.
4. `apps/server/src/provider/Layers/ProviderSessionReaper.ts` currently refuses to reap a stale persisted session if the projection has any non-null `activeTurnId`.

## 3) Scope

### 3.1 Goal

Eliminate idle background Codex API activity caused by Cafe Code-managed provider maintenance, and add tests that fail if the automatic Codex snapshot loop is reintroduced.

### 3.2 Non-Goals

- Do not redesign the provider registry.
- Do not remove user-triggered provider refresh.
- Do not remove actual Codex session/turn execution paths.
- Do not depend on live Codex credentials or hit Codex/OpenAI services in tests.
- Do not implement the broader upstream background/power policy PR unless the narrow fix is insufficient.

### 3.3 Working Hypotheses

1. The confirmed local bug is the Codex driver opting into the generic 5-minute managed provider refresh loop even though its health check is not local-only.
2. The likely minimal fix is to let providers opt out of automatic periodic refresh and have Codex opt out.
3. A secondary hardening fix may be needed in `ProviderSessionReaper` so abandoned sessions with stale active-turn state cannot live forever.
4. If neither code path can explain local behavior, report that no source was found and document exactly what was ruled out.

## 4) Milestone Plan

### 4.1 Milestone 1: Trace Idle-Capable Background Work

- Deliverables:
  - Map every automatic path that can call Codex provider refresh or spawn `codex app-server`.
  - Distinguish automatic background refresh from user-initiated refresh and turn execution.
- Acceptance Criteria:
  - All identified automatic Codex status refresh paths have file/line references.
  - The plan states whether each path is idle-capable.
- Test Plan:
  - Targeted `rg` over provider registry, Codex provider/driver, WebSocket config refresh, and session reaper files.

### 4.2 Milestone 2: Stop Automatic Codex App-Server Probing While Idle

- Deliverables:
  - Add a provider-managed way to disable automatic periodic refresh.
  - Configure Codex to disable that automatic periodic refresh.
  - Preserve manual/explicit refresh.
- Acceptance Criteria:
  - Codex no longer schedules a 5-minute background provider status loop.
  - Other providers keep existing refresh behavior unless deliberately changed.
  - Manual provider refresh still calls the provider check.
- Test Plan:
  - Unit test `makeManagedServerProvider` opt-out behavior.
  - Unit test or code-level assertion that `CodexDriver` opts out.

### 4.3 Milestone 3: Harden Stale Session Reaping If Needed

- Deliverables:
  - Inspect whether the local projection already clears `activeTurnId` on all terminal Codex events.
  - If a stale active-turn session can survive forever, add bounded stale-session reaping behavior with tests.
- Acceptance Criteria:
  - A valid active turn is not reaped prematurely.
  - A stale persisted session is not immortal solely because the read model has a stale `activeTurnId`.
- Test Plan:
  - Add or update `ProviderSessionReaper` tests only if code changes are necessary.

### 4.4 Milestone 4: Verification And Report

- Deliverables:
  - Required repo checks.
  - Short report stating the found source or that no source was found.
  - Link upstream issue source used for investigation.
- Acceptance Criteria:
  - `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` pass after any code change.
  - Stale-reference checks confirm no automatic Codex refresh interval remains.

## 5) Verification Matrix

| Requirement | Code Location | Test Coverage | Status |
| --- | --- | --- | --- |
| Identify automatic Codex app-server probe path | `apps/server/src/provider/Drivers/CodexDriver.ts`; `apps/server/src/provider/makeManagedServerProvider.ts`; `apps/server/src/provider/Layers/CodexProvider.ts` | Targeted source inspection | complete |
| Disable Codex periodic idle refresh | `apps/server/src/provider/Drivers/CodexDriver.ts`; `apps/server/src/provider/makeManagedServerProvider.ts` | `makeManagedServerProvider.test.ts` | complete |
| Preserve manual provider refresh | `apps/server/src/provider/makeManagedServerProvider.ts` | `makeManagedServerProvider.test.ts` | complete |
| Evaluate stale active-turn reaper risk | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`; `apps/server/src/provider/Layers/ProviderSessionReaper.ts` | `ProviderRuntimeIngestion.test.ts` | complete |
| Required verification | repo root | `bun fmt`; `bun lint`; `bun typecheck`; `bun run test` | complete |

## 6) Completion Formula

`completion = (completed acceptance criteria / total acceptance criteria) * 100`

Current completion: `100%`

## 7) Current Checkpoint

- Current Stage Flag:
  ```text
  /ᐠ > ˕ <マ 🌸 かんせい！!
  ```
- Active Milestone: 4.4 Milestone 4: Verification And Report
- Current Task: Complete.
- Next Action: None.
- Blockers: None.
- Resume Point: Plan complete at 100%.

## 8) Verification Checklist

- [x] Upstream issue #2720 inspected.
- [x] Related Claude idle-token bug #2191 inspected for prior pattern.
- [x] Automatic Codex provider refresh call graph documented.
- [x] Codex periodic idle refresh disabled or ruled out as source.
- [x] Manual provider refresh preserved.
- [x] Stale active-turn session reaper risk evaluated.
- [x] Tests added or updated for changed behavior.
- [x] `bun fmt` passed.
- [x] `bun lint` passed.
- [x] `bun typecheck` passed.
- [x] `bun run test` passed.

## 9) Execution Log

- 2026-05-21T11:40:00Z: Plan initialized from upstream issue #2720 and local source inspection.
- 2026-05-21T11:45:00Z: Disabled Codex periodic provider refresh by adding a `refreshInterval: null` opt-out and configuring `CodexDriver` to use it. Added lifecycle handling for `turn.aborted` so aborted Codex turns clear `activeTurnId`. Targeted tests for both changes passed, and package typecheck passed.
- 2026-05-21T11:56:42Z: Final verification passed. `bun fmt` completed successfully. `bun lint` completed with 9 existing warnings and 0 errors. `bun typecheck` passed. `bun run test` passed with 13 successful tasks; the server package reported 123 passed test files, 1 skipped file, 1025 passed tests, and 4 skipped tests. `git diff --check` passed with no whitespace errors. Targeted source search confirmed Codex uses `PERIODIC_SNAPSHOT_REFRESH_INTERVAL: null`, while non-Codex providers retain their existing periodic refresh intervals.

## 10) Handoff Payload (Copy 1:1)

When handing off this plan to another window/agent, copy the full plan exactly with no summarization and preserve the exact Current Checkpoint fields.
