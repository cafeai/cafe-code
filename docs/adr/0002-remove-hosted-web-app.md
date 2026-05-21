# ADR 0002: Remove Hosted Web App Surface

## Status

Accepted.

## Context

Cafe Code is now Electron-only. The React/Vite package remains because it is the
desktop renderer, but the hosted static web app, Vercel deployment path, hosted
pairing links, and inherited hosted domains are no longer product surfaces.

## Decision

Remove the hosted web app surface instead of migrating it to new Cafe Code-owned
domains.

The release workflow must publish desktop artifacts and the CLI package only.
Pairing links must point directly at the backend `/pair` endpoint. The renderer
may still be served locally by the Electron-launched backend for desktop use, but
it must not depend on hosted channel routing.

## Removal Criteria

- Vercel deployment configuration and release jobs are removed.
- Hosted static app routing and hosted channel selection are removed.
- Hosted pairing URL generation and parsing are removed.
- Inherited hosted domains are removed from runtime defaults, release automation,
  docs, tests, and deployment configuration.
- `apps/web` remains as the Electron renderer and is still packaged into the
  desktop/server build path.
