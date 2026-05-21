# Adjudication Required — Burst 002 Design Phase

The two agents disagreed during the design reconciliation.

## Claude

- Verdict: agree
- Preferred focus: matrix-clustered-rebrand
- Document: `.selene/bursts/002/design/claude_reconciliation.md`

## Codex

- Verdict: agree
- Preferred focus: matrix-driven-full-sweep
- Document: `.selene/bursts/002/design/codex_reconciliation.md`

## Resolution

Run one of:

- `selene adjudicate <project-path> 2 --decision=auditor [--note="..."]`
- `selene adjudicate <project-path> 2 --decision=implementer [--note="..."]`
- `selene adjudicate <project-path> 2 --decision=custom --note="..."`

Then run `selene approve <project-path> 2` to proceed.
