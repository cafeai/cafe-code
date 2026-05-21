# cafe-code — Terminology Lock v1

This document is the canonical vocabulary for cafe-code. Every artifact
produced under this project must include a Terminology section pointing back here.

## Primitive terms

| Term                       | Definition                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| cafe-code                  | This fork of T3 Code, a Bun/TypeScript monorepo for a browser and desktop GUI around coding agents.                                              |
| T3 Code                    | The upstream application lineage. Use only for inherited behavior or upstream-compatible concepts.                                               |
| provider                   | A coding-agent backend exposed through the server, such as Codex, Claude, Cursor, or OpenCode.                                                   |
| provider session           | One server-managed runtime instance for a provider conversation or resumed provider thread.                                                      |
| Codex app-server           | The Codex JSON-RPC-over-stdio process wrapped by the server for Codex provider sessions.                                                         |
| WebSocket protocol         | The client/server RPC and push-event channel between `apps/web` and `apps/server`.                                                               |
| orchestration domain event | A durable server-side event representing session, turn, provider, projection, or lifecycle state.                                                |
| projection                 | A read-model view derived from persisted orchestration events for UI consumption.                                                                |
| environment                | A web UI workspace/runtime context that subscribes to shell and detail streams.                                                                  |
| contracts package          | `packages/contracts`; schema-only shared TypeScript contracts for protocol and model shapes.                                                     |
| shared package             | `packages/shared`; runtime utilities exported through explicit subpath exports.                                                                  |
| desktop app                | `apps/desktop`; the Tauri wrapper around the web/server experience.                                                                              |
| security-sensitive data    | Credentials, provider tokens, session tokens, API keys, local filesystem paths, and any persisted conversation content that may contain secrets. |

## Anti-confusion table

| Term          | This project's meaning                                     | NOT to be confused with                                                          |
| ------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| provider      | Local abstraction for a coding-agent backend               | Dependency injection provider, React context provider, or cloud vendor generally |
| session       | Provider or application runtime conversation state         | Browser cookie alone                                                             |
| orchestration | Event-driven provider/session coordination inside this app | The deprecated Selene daemon/orchestrator                                        |
| event         | Persisted or streamed application state transition         | Browser DOM event unless explicitly qualified                                    |
| contract      | Runtime/schema boundary shared between packages            | Legal agreement                                                                  |
| environment   | UI/runtime workspace context                               | Shell environment variables unless explicitly qualified                          |
| projection    | Derived read model                                         | Database table generally or visual projection                                    |

## Anti-bleed rule

Any artifact that uses a term outside this lock's scope must namespace-prefix it
explicitly (e.g., `External-foo`).

## Updates

This lock evolves only through new ADRs that explicitly amend it. Bursts may not
modify this file directly.
