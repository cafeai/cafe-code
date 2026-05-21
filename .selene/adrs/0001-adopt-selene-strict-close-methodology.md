# ADR-0001: Adopt Selene strict-close methodology

- Status: Accepted
- Date: 2026-05-21

## Context

This project uses Selene for cross-LLM research bursts. The methodology includes append-only ADRs, hashed invariants over Python/Rust/JavaScript/TypeScript AST signatures, SHA-256 manifests for canonical files, executable strict-close classifications, and a mandatory hard-non-claims block on every artifact. See README.md for the loop.
