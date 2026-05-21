# Workspace layout

- `/apps/server`: Node.js WebSocket server. Wraps Codex app-server and serves the built renderer assets to Electron.
- `/apps/web`: React + Vite renderer. Session control, conversation, and provider event rendering. Connects to the server via WebSocket.
- `/apps/desktop`: Electron shell. Spawns a desktop-scoped `cafe-code` backend process and loads the renderer.
- `/packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types.
- `/packages/shared`: Shared runtime utilities consumed by both server and renderer. Uses explicit subpath exports (e.g. `@cafecode/shared/git`, `@cafecode/shared/DrainableWorker`) — no barrel index.
