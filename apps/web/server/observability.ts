import "server-only";
import { createTelemetryLogger, TelemetryMetrics } from "@meta-game/config";

export const webMetrics = new TelemetryMetrics("web");
export const webLogger = createTelemetryLogger("web");

let activeSseConnections = 0;
export function adjustSseConnections(change: 1 | -1): void {
  activeSseConnections = Math.max(0, activeSseConnections + change);
  webMetrics.set("sse_connections", activeSseConnections);
}

export function recordSseEvent(type: string): void {
  const category = type === "run.queued" || type === "run.status" || type.startsWith("run.") ? "run"
    : type === "plan.created" ? "plan"
      : type.startsWith("step.") ? "step"
        : type === "file.changed" || type === "asset.card" ? "file"
          : type === "verification.result" ? "verification"
            : type === "preview.ready" ? "preview" : "other";
  webMetrics.increment("sse_events_total", { category });
}
