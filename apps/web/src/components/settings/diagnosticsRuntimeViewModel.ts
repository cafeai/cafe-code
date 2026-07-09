import type {
  ServerRuntimeLayerDiagnosticsError,
  ServerRuntimeLayerDiagnosticsResult,
  ServerRuntimeLayerProcess,
  ServerRuntimeLayerStatus,
  ServerRuntimeLayerSummary,
} from "@cafecode/contracts";

export function formatRuntimeLayerRole(role: string): string {
  return role
    .split("-")
    .map((part) => (part.length === 0 ? part : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`))
    .join(" ");
}

export function runtimeLayerStatusTone(
  status: ServerRuntimeLayerStatus,
): "default" | "warning" | "danger" {
  switch (status) {
    case "online":
      return "default";
    case "degraded":
    case "unknown":
      return "warning";
    case "offline":
      return "danger";
  }
}

export function runtimeLayerStatusClasses(status: ServerRuntimeLayerStatus): string {
  switch (status) {
    case "online":
      return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300";
    case "degraded":
      return "bg-amber-500/10 text-amber-600 dark:text-amber-300";
    case "offline":
      return "bg-destructive/10 text-destructive";
    case "unknown":
      return "bg-muted text-muted-foreground";
  }
}

export function summarizeRuntimeMemory(
  processes: ReadonlyArray<ServerRuntimeLayerProcess>,
): number {
  return processes.reduce((total, process) => total + process.rssBytes, 0);
}

export function summarizeRuntimeCpu(processes: ReadonlyArray<ServerRuntimeLayerProcess>): number {
  return processes.reduce((total, process) => total + process.cpuPercent, 0);
}

export function sortRuntimeLayers(
  layers: ReadonlyArray<ServerRuntimeLayerSummary>,
): ReadonlyArray<ServerRuntimeLayerSummary> {
  const order = new Map(
    ["desktop", "backend", "orchestrator", "provider-daemon", "provider-supervisor"].map(
      (role, index) => [role, index] as const,
    ),
  );
  return layers.toSorted(
    (left, right) =>
      (order.get(left.role) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.role) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function visibleRuntimeErrors(
  data: ServerRuntimeLayerDiagnosticsResult | null,
  clientError: string | null,
): ReadonlyArray<ServerRuntimeLayerDiagnosticsError> {
  const errors: ServerRuntimeLayerDiagnosticsError[] = [];
  if (clientError) {
    errors.push({ source: "client", message: clientError });
  }
  if (data?.errors) {
    errors.push(...data.errors);
  }
  const providerRuntimeIngestion = data?.orchestrator?.providerRuntimeIngestion;
  if (providerRuntimeIngestion && providerRuntimeIngestion.status !== "online") {
    errors.push({
      source: "provider-runtime-ingestion",
      message: `Provider daemon is ${providerRuntimeIngestion.lag} runtime events ahead of backend ingestion. Provider output may still be running while chat projection catches up.`,
    });
  }
  return errors;
}
