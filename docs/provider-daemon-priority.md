# Provider daemon scheduling

The dedicated provider daemon lowers its CPU scheduling priority before it starts
provider runtimes. Normally launched children inherit that priority. This reduces
CPU contention with interactive work. It does not cap memory, GPU use, network
use, or agent count.

The change applies to a new `provider-daemon` process with a valid bootstrap.
Electron, the backend, direct backend-hosted providers, the optional supervisor,
and existing external runtimes retain their current scheduling policy.
An OS failure produces a fixed warning and lets startup continue.
An already lower priority is preserved.

Windows documents below-normal inheritance in
[Scheduling Priorities](https://learn.microsoft.com/en-us/windows/win32/procthread/scheduling-priorities).
Child programs can still change their own scheduling policy.

Run the explicit local smoke from the repository root:

```sh
node scripts/provider-priority-smoke.ts
```

It checks two disposable Node processes and leaves the caller's priority alone.
The default unit suite uses injected operations and never changes process priority.
