# Embedded browser security helpers

This foundation contains four pure functions in
`apps/desktop/src/browser/embeddedBrowserSecurity.ts`. It has no Electron imports,
network access, storage, or application integration. It does not enable an embedded
browser or grant an agent access to a page.

- `normalizeEmbeddedBrowserUrl` adds HTTPS to an address without a scheme and
  accepts only HTTP, HTTPS, or `about:blank`. URL credentials are rejected.
- `embeddedBrowserDisplayUrl` removes credentials, query data, and fragments from
  HTTP/HTTPS URLs. Paths remain visible; use an origin alone when paths must not
  enter model context or diagnostics.
- `redactEmbeddedBrowserText` replaces common synthetic-token shapes, labelled
  secrets, and likely one-time codes before clipping the output. This heuristic
  can omit ordinary numbers and cannot identify every secret. Callers must bound
  input text before this function; an output limit is not an input memory limit.
- `canTypeSensitiveValue` checks transport eligibility: HTTPS or loopback HTTP,
  without URL credentials. It does not verify a certificate, resolve DNS, or grant
  permission to enter a value. It is not a network-request or SSRF allowlist.

Future browser integration must separately enforce isolated sessions, exact
renderer ownership, explicit origin sharing, fresh snapshot targets, revocation,
and operator-only credential entry. These helpers cannot replace those controls.

The functions originate in Club Code's desktop browser. This extraction also
rejects unsupported display schemes, rejects credential-bearing sensitive-entry
URLs independently, and makes invalid text limits return no content. The tests
cover these boundaries without loading Electron or reading real credentials.
Recognized labelled secrets are removed in full, including values longer than
128 characters; the redactor does not leave a matching value's suffix visible.
