import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTelemetryLogger,
  createTelemetryServer,
  evaluateOperationalAlerts,
  isOpaqueTelemetryId,
  newRequestId,
  redactTelemetryFields,
  TelemetryMetrics,
  withTelemetryContext,
} from "@meta-game/config";

describe("telemetría operativa", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emite JSON estructurado sin campos privados ni mensajes arbitrarios", () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createTelemetryLogger("worker", "info");
    const authorizationKey = ["author", "ization"].join("");
    const sessionKey = ["ses", "sion"].join("");

    withTelemetryContext({ requestId: "00000000-0000-4000-8000-000000000001", runId: "00000000-0000-4000-8000-000000000002" }, () => {
      logger.info("run.started", {
        task: "code",
        [authorizationKey]: "private credential fixture",
        [sessionKey]: "session fixture",
        prompt: "synthetic private prompt fixture",
        userId: "synthetic-owner-fixture",
        errorCode: "worker_started",
      });
    });

    const line = String(output.mock.calls[0]?.[0] ?? "");
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record).toMatchObject({ service: "worker", event: "run.started", task: "code" });
    expect(record.requestId).toBe("00000000-0000-4000-8000-000000000001");
    expect(record.runId).toBe("00000000-0000-4000-8000-000000000002");
    expect(line).not.toContain("private credential fixture");
    expect(line).not.toContain("synthetic private prompt fixture");
    expect(line).not.toContain("synthetic-owner-fixture");
    expect(line).not.toContain("session fixture");
  });

  it("rechaza identificadores que no sean UUID opacos y genera IDs nuevos", () => {
    const id = newRequestId();
    expect(isOpaqueTelemetryId(id)).toBe(true);
    expect(isOpaqueTelemetryId("owner@example.test")).toBe(false);
    expect(isOpaqueTelemetryId("synthetic-request-id")).toBe(false);
  });

  it("solo permite métricas con labels de cardinalidad acotada", () => {
    const metrics = new TelemetryMetrics("worker");
    metrics.increment("meta_requests_total", { task: "code", outcome: "success" });
    metrics.observe("meta_request_duration_seconds", 1.25, { task: "code", outcome: "success" });
    metrics.increment("run_lock_events_total", { outcome: "acquired" });
    metrics.set("queue_stuck_jobs", 2);

    const exposition = metrics.render();
    expect(exposition).toContain('meta_requests_total{service="worker",task="code",outcome="success"} 1');
    expect(exposition).toContain('meta_request_duration_seconds_bucket{service="worker",task="code",outcome="success",le="2"} 1');
    expect(exposition).toContain('queue_stuck_jobs{service="worker"} 2');
    expect(exposition).toContain('run_lock_events_total{service="worker",outcome="acquired"} 1');
    expect(() => metrics.increment("gateway_denials_total", { reason: "00000000-0000-4000-8000-000000000001" })).toThrow();
    expect(() => metrics.increment("unknown_metric", {})).toThrow();
  });

  it("detecta fixtures de cola atascada, presión de disco, errores de proveedor y limpieza", () => {
    expect(evaluateOperationalAlerts({ oldestWaitingSeconds: 1_000, diskUsedRatio: 0.9, providerRequests: 10, providerErrors: 3, cleanupFailures: 1 }))
      .toEqual(["queue_stuck", "disk_pressure", "provider_errors", "cleanup_failures"]);
    expect(evaluateOperationalAlerts({ oldestWaitingSeconds: 30, diskUsedRatio: 0.2, providerRequests: 4, providerErrors: 2, cleanupFailures: 0 }))
      .toEqual([]);
  });

  it("redacta claves sensibles y omite valores con forma de texto libre", () => {
    expect(redactTelemetryFields({ task: "image", prompt: "synthetic prompt", durationMs: 12, message: "private message" }))
      .toEqual({ task: "image", durationMs: 12 });
  });

  it("separa liveness de readiness y no devuelve detalles internos cuando falla una dependencia", async () => {
    const server = createTelemetryServer({
      service: "worker",
      metrics: new TelemetryMetrics("worker"),
      port: 0,
      host: "127.0.0.1",
      ready: async () => false,
    });
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    try {
      const live = await fetch("http://127.0.0.1:" + address.port + "/livez");
      const ready = await fetch("http://127.0.0.1:" + address.port + "/readyz");
      const body = await ready.json();
      expect(live.status).toBe(200);
      expect(ready.status).toBe(503);
      expect(body).toEqual({ status: "not_ready", service: "worker" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
