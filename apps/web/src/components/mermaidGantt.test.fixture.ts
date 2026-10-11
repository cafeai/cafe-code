// One inert fixture keeps the authored dependency schedule identical across
// Markdown handoff, the real sandbox renderer, viewer controls and PNG export.
// These are presentation inputs only, never a plan to execute or provider work.
export const GANTT_SCHEDULE = `gantt
    title Illustrative parallel engineering schedule
    dateFormat YYYY-MM-DD
    axisFormat %b %d

    section Complete transfer
    Source and lifecycle closure      :src, 2026-10-12, 4d
    Native and functional joins        :nat, 2026-10-12, 5d
    Independent full verifier          :ver, after src, 3d
    Numerical functions and parameters :par, 2026-10-12, 4d
    Registered terminal backend        :back, after par, 4d
    Complete transfer integration      :join, after ver back nat, 2d

    section Original targets
    Whole performance and compaction   :opt, after join, 7d
    Security reasoning and regressions :sec, after join, 7d

    section General system
    General operation integration      :gen, after back, 7d
    General conformance                :conf, after gen, 5d
    Final evidence and replay          :ev, after conf opt sec, 2d`;

// Exact calendar dates independently qualify multi-predecessor joins: `join`
// starts after the latest of ver/back/nat, and `ev` after conf/opt/sec. Keep
// dates as finite tuples so browser checks use the host's real local calendar
// (including DST), just as the pinned Mermaid engine does for date-only input.
export const GANTT_TASK_DATES = [
  { id: "src", label: "Source and lifecycle closure", start: [2026, 10, 12], end: [2026, 10, 16] },
  { id: "nat", label: "Native and functional joins", start: [2026, 10, 12], end: [2026, 10, 17] },
  { id: "ver", label: "Independent full verifier", start: [2026, 10, 16], end: [2026, 10, 19] },
  {
    id: "par",
    label: "Numerical functions and parameters",
    start: [2026, 10, 12],
    end: [2026, 10, 16],
  },
  { id: "back", label: "Registered terminal backend", start: [2026, 10, 16], end: [2026, 10, 20] },
  {
    id: "join",
    label: "Complete transfer integration",
    start: [2026, 10, 20],
    end: [2026, 10, 22],
  },
  {
    id: "opt",
    label: "Whole performance and compaction",
    start: [2026, 10, 22],
    end: [2026, 10, 29],
  },
  {
    id: "sec",
    label: "Security reasoning and regressions",
    start: [2026, 10, 22],
    end: [2026, 10, 29],
  },
  { id: "gen", label: "General operation integration", start: [2026, 10, 20], end: [2026, 10, 27] },
  { id: "conf", label: "General conformance", start: [2026, 10, 27], end: [2026, 11, 1] },
  { id: "ev", label: "Final evidence and replay", start: [2026, 11, 1], end: [2026, 11, 3] },
] as const;
