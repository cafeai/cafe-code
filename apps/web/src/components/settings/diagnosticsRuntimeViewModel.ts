import { uiText } from "@cafecode/shared/i18n";
import type {
  ServerRuntimeLayerDiagnosticsError,
  ServerRuntimeLayerDiagnosticsResult,
  ServerRuntimeLayerProcess,
  ServerRuntimeLayerStatus,
  ServerRuntimeLayerSummary,
} from "@cafecode/contracts";

/** Sentence-case label for a runtime layer or diagnostic source id ("provider-daemon" → "Provider daemon"). */
export function formatRuntimeLayerRole(role: string): string {
  switch (role) {
    case "desktop":
      return uiText("Desktop");
    case "backend":
      return uiText("Backend");
    case "orchestrator":
      return uiText("Orchestrator");
    case "provider-daemon":
      return uiText("Provider daemon");
    case "provider-supervisor":
      return uiText("Provider supervisor");
    case "client":
      return uiText("Client");
    case "provider-runtime-ingestion":
      return uiText("Provider runtime ingestion");
  }
  const words = role.split("-").join(" ");
  return words.length === 0 ? words : `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}

/** Display label for a runtime layer status; `not-configured` reads as a neutral state. */
export function formatRuntimeLayerStatus(status: ServerRuntimeLayerStatus): string {
  switch (status) {
    case "online":
      return uiText("Online");
    case "degraded":
      return uiText("Degraded");
    case "offline":
      return uiText("Offline");
    case "unknown":
      return uiText("Unknown");
    case "not-configured":
      return uiText("Not configured");
  }
}

export function runtimeLayerStatusTone(
  status: ServerRuntimeLayerStatus,
): "default" | "warning" | "danger" {
  switch (status) {
    case "online":
    case "not-configured":
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
      return "bg-success/10 text-success-foreground";
    case "degraded":
      return "bg-warning/10 text-warning-foreground";
    case "offline":
      return "bg-destructive/10 text-destructive-foreground";
    case "unknown":
      return "bg-muted text-muted-foreground";
    case "not-configured":
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
      message: uiText(
        "Backend ingestion is {count, plural, one {{displayCount} provider daemon event} other {{displayCount} provider daemon events}} behind; chats may lag provider output.",
        {
          count: providerRuntimeIngestion.lag,
          // Preserve the existing ungrouped diagnostic count. The separate
          // numeric value controls plural grammar, not its display spelling.
          displayCount: String(providerRuntimeIngestion.lag),
        },
      ),
    });
  }
  return errors;
}
