# Host system telemetry foundation

Status: bounded contracts and server-sampler slice.

## Truthful availability

This slice reports aggregate host CPU utilization after a second monotonic counter sample, logical
processor count, and process-effective memory where the runtime exposes a trustworthy available
memory counter. Unavailable and warming metrics carry `null` measurements; counter exceptions map
to fixed privacy-safe details rather than leaking host paths, commands, or exception text.

## Sampling boundary

CPU usage comes from aggregate counter deltas, never a fabricated instantaneous value. The first
sample warms a baseline. Reads inside the one-second minimum interval reuse the last CPU result,
topology or platform changes reset the baseline, invalid or stalled counters fail closed, and a
transient read failure preserves the last healthy baseline.

Memory uses the process-effective constraint when Node reports one. Constrained Linux and
unconstrained Windows are the runtime-backed paths in this slice. Other paths fail closed because
the runtime can fall back to raw free-page counters, which do not represent reusable memory.

The contracts distinguish available, warming, and unavailable states and require internally
consistent byte counters and percentages. Integrations beyond this bounded sampler remain separate
review units.
