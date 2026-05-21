# Adjudication Required — Burst 001 Design Phase

The two agents disagreed during the design reconciliation.

## Claude

- Verdict: agree
- Preferred focus: source-derived-classification-matrix
- Document: `.selene/bursts/001/design/claude_reconciliation.md`

## Codex

- Verdict: agree
- Preferred focus: source-grounded-tiered-rename-classification
- Document: `.selene/bursts/001/design/codex_reconciliation.md`

## Resolution

Run one of:

- `selene adjudicate <project-path> 1 --decision=auditor [--note="..."]`
- `selene adjudicate <project-path> 1 --decision=implementer [--note="..."]`
- `selene adjudicate <project-path> 1 --decision=custom --note="..."`

Then run `selene approve <project-path> 1` to proceed.
