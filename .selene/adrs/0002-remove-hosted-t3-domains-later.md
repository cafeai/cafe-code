# ADR-0002: Remove hosted t3.codes domains in a later migration

- Status: Accepted
- Date: 2026-05-21

## Context

Cafe Code still references hosted `t3.codes` domains for the current router,
latest, Nightly, and pairing surfaces. Those domains are active external
routing contracts today, and this repository does not currently define or host
replacement Cafe-owned domains.

## Decision

Keep the current hosted `t3.codes` defaults until Cafe-owned domains are
selected, configured, deployed, and verified. This is temporary. All
`t3.codes` hosted defaults must be removed in a later domain migration once the
replacement domains are live.

The later migration must cover DNS ownership, TLS, deploy configuration,
router/latest/Nightly channel routing, pairing URLs, channel cookies/routes,
redirects from old URLs, and update-channel validation before removing the old
domain defaults.

## Consequences

- Current hosted `t3.codes` references are allowed only as temporary external
  routing defaults.
- New code should not introduce additional `t3.codes` surfaces.
- Documentation must continue to track this as required cleanup, not as a
  permanent Cafe Code domain strategy.
