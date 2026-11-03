import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

export type TelemetryService = "web" | "worker" | "preview-gateway" | "sandbox-controller" | "publishing-origin" | "observability";
export type TelemetryLevel = "debug" | "info" | "warn" | "error";
export type TelemetryContext = Readonly<{ requestId?: string; runId?: string }>;
export type TelemetryFields = Readonly<Record<string, unknown>>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const services = new Set<TelemetryService>(["web", "worker", "preview-gateway", "sandbox-controller", "publishing-origin", "observability"]);
const levels: readonly TelemetryLevel[] = ["debug", "info", "warn", "error"];
const sensitiveKey = /authorization|cookie|session|grant|token|secret|password|prompt|content|body|header|environment|email|user.?id|credential|stack|message/i;
const contextStorage = new AsyncLocalStorage<TelemetryContext>();

export function newRequestId(): string {
  return randomUUID();
}

export function isOpaqueTelemetryId(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

export function withTelemetryContext<T>(context: TelemetryContext, callback: () => T): T {
  const safe: TelemetryContext = {
    ...(isOpaqueTelemetryId(context.requestId) ? { requestId: context.requestId } : {}),
    ...(isOpaqueTelemetryId(context.runId) ? { runId: context.runId } : {}),
  };
  return contextStorage.run(safe, callback);
}

export function currentTelemetryContext(): TelemetryContext {
  return contextStorage.getStore() ?? {};
}

function safeText(value: unknown, max = 80): string | undefined {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.:-]+$/.test(value) || value.length > max) return undefined;
  if (value.length > 24 && value.split(/[_.:-]/).some((part) => part.length > 24)) return undefined;
  return value;
}

function safeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

const logFieldRules: Readonly<Record<string, (value: unknown) => string | number | undefined>> = {
  outcome: (value) => safeText(value, 24),
  task: (value) => safeText(value, 24),
  operation: (value) => safeText(value, 32),
  statusCode: (value) => safeNumber(value),
  durationMs: (value) => safeNumber(value),
  count: (value) => safeNumber(value),
  bytes: (value) => safeNumber(value),
  tokens: (value) => safeNumber(value),
  alert: (value) => safeText(value, 40),
  state: (value) => safeText(value, 24),
  reason: (value) => safeText(value, 32),
  errorCode: (value) => safeText(value, 64),
};

export function redactTelemetryFields(fields: TelemetryFields = {}): Readonly<Record<string, string | number>> {
  const safe: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (sensitiveKey.test(key)) continue;
    const validate = logFieldRules[key];
    const normalized = validate?.(value);
    if (normalized !== undefined) safe[key] = normalized;
  }
  return safe;
}

export function createTelemetryLogger(service: TelemetryService, levelInput = process.env.LOG_LEVEL): {
  log(level: TelemetryLevel, event: string, fields?: TelemetryFields): void;
  debug(event: string, fields?: TelemetryFields): void;
  info(event: string, fields?: TelemetryFields): void;
  warn(event: string, fields?: TelemetryFields): void;
  error(event: string, fields?: TelemetryFields): void;
} {
  if (!services.has(service)) throw new Error("telemetry_service_invalid");
  const level = levels.includes(levelInput as TelemetryLevel) ? levelInput as TelemetryLevel : "info";
  const threshold = levels.indexOf(level);
  const exporterUrl = otlpLogsUrl(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const pendingOtlpLogs: Array<Record<string, unknown>> = [];
  let exporting = false;
  const enqueueOtlp = (record: Record<string, unknown>) => {
    if (!exporterUrl) return;
    if (pendingOtlpLogs.length >= 200) pendingOtlpLogs.shift();
    pendingOtlpLogs.push(record);
    if (exporting) return;
    exporting = true;
    queueMicrotask(() => { void flushOtlp(); });
  };
  const flushOtlp = async () => {
    while (pendingOtlpLogs.length) {
      const batch = pendingOtlpLogs.splice(0, 50);
      const records = batch.map((record) => ({
        timeUnixNano: String(BigInt(Date.parse(String(record.timestamp))) * 1_000_000n),
        severityNumber: record.level === "debug" ? 5 : record.level === "info" ? 9 : record.level === "warn" ? 13 : 17,
        severityText: String(record.level).toUpperCase(),
        body: { stringValue: JSON.stringify(record) },
        attributes: Object.entries(record).filter(([key]) => !["timestamp", "level", "service", "event"].includes(key)).map(([key, value]) => ({
          key,
          value: typeof value === "number" ? Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } : { stringValue: String(value) },
        })),
      }));
      try {
        await fetch(exporterUrl!, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] }, scopeLogs: [{ scope: { name: "meta-game" }, logRecords: records }] }] }),
          signal: AbortSignal.timeout(2_000),
        });
      } catch { /* OTLP is optional; delivery failures never affect product requests. */ }
    }
    exporting = false;
  };
  const write = (entryLevel: TelemetryLevel, event: string, fields: TelemetryFields = {}) => {
    if (levels.indexOf(entryLevel) < threshold) return;
    const eventName = safeText(event, 80);
    if (!eventName) return;
    const context = currentTelemetryContext();
    const record = {
      timestamp: new Date().toISOString(),
      level: entryLevel,
      service,
      event: eventName,
      ...(context.requestId ? { requestId: context.requestId } : {}),
      ...(context.runId ? { runId: context.runId } : {}),
      ...redactTelemetryFields(fields),
    };
    const line = JSON.stringify(record) + "\n";
    (entryLevel === "error" || entryLevel === "warn" ? process.stderr : process.stdout).write(line);
    enqueueOtlp(record);
  };
  return {
    log: write,
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

function otlpLogsUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    const path = parsed.pathname.replace(/\/+$/, "");
    parsed.pathname = path.endsWith("/v1/logs") ? path : path + "/v1/logs";
    return parsed.toString();
  } catch { return undefined; }
}

type MetricKind = "counter" | "gauge" | "histogram";
type MetricDefinition = Readonly<{ kind: MetricKind; labels: readonly string[]; buckets?: readonly number[] }>;
type MetricSeries = { labels: Readonly<Record<string, string>>; value: number; counts?: number[]; sum?: number; observations?: number };

const metricDefinitions: Readonly<Record<string, MetricDefinition>> = {
  http_requests_total: { kind: "counter", labels: ["method", "status_class"] },
  http_request_duration_seconds: { kind: "histogram", labels: ["method"], buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] },
  meta_requests_total: { kind: "counter", labels: ["task", "outcome"] },
  meta_request_duration_seconds: { kind: "histogram", labels: ["task", "outcome"], buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120] },
  meta_usage_tokens_total: { kind: "counter", labels: ["task"] },
  meta_usage_images_total: { kind: "counter", labels: ["task"] },
  meta_estimated_cost_usd_total: { kind: "counter", labels: ["task"] },
  queue_jobs: { kind: "gauge", labels: ["state"] },
  queue_stuck_jobs: { kind: "gauge", labels: [] },
  queue_oldest_waiting_seconds: { kind: "gauge", labels: [] },
  run_jobs_total: { kind: "counter", labels: ["outcome"] },
  run_duration_seconds: { kind: "histogram", labels: ["outcome"], buckets: [1, 5, 15, 30, 60, 120, 300, 600] },
  run_lock_events_total: { kind: "counter", labels: ["outcome"] },
  sse_connections: { kind: "gauge", labels: [] },
  sse_events_total: { kind: "counter", labels: ["category"] },
  sandbox_instances: { kind: "gauge", labels: ["state"] },
  sandbox_operations_total: { kind: "counter", labels: ["operation", "outcome"] },
  gateway_denials_total: { kind: "counter", labels: ["reason"] },
  cleanup_runs_total: { kind: "counter", labels: ["outcome"] },
  disk_used_ratio: { kind: "gauge", labels: ["mount"] },
};

const labelValues: Readonly<Record<string, ReadonlySet<string>>> = {
  method: new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "OTHER"]),
  status_class: new Set(["1xx", "2xx", "3xx", "4xx", "5xx"]),
  task: new Set(["plan", "code", "image", "smoke"]),
  outcome: new Set(["success", "error", "ambiguous", "succeeded", "failed", "cancelled", "skipped", "denied", "acquired", "busy", "renewed", "lost", "released", "expired", "retry"]),
  state: new Set(["waiting", "active", "delayed", "failed", "running", "starting", "suspended", "suspending", "provisioning", "ready", "stopping", "stopped", "creating", "deleting"]),
  operation: new Set(["create", "inspect", "stop", "delete", "read", "write", "list", "exec", "install", "verify", "cleanup", "start_server"]),
  reason: new Set(["missing_session", "invalid_grant", "owner_mismatch", "not_ready", "rate_limited", "invalid_request", "proxy_error", "unknown_host"]),
  category: new Set(["run", "plan", "step", "file", "verification", "preview", "other"]),
  mount: new Set(["root", "workspace", "backup"]),
};

function seriesKey(labels: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)));
}

function escapePrometheus(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

export class TelemetryMetrics {
  private readonly series = new Map<string, Map<string, MetricSeries>>();

  constructor(readonly service: TelemetryService) {
    if (!services.has(service)) throw new Error("telemetry_service_invalid");
  }

  increment(name: string, labels: Readonly<Record<string, string>> = {}, amount = 1): void {
    const definition = this.validate(name, "counter", labels, amount);
    const series = this.getSeries(name, labels, definition);
    series.value += amount;
  }

  set(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
    const definition = this.validate(name, "gauge", labels, value);
    this.getSeries(name, labels, definition).value = value;
  }

  observe(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
    const definition = this.validate(name, "histogram", labels, value);
    const series = this.getSeries(name, labels, definition);
    const buckets = definition.buckets ?? [];
    series.counts ??= buckets.map(() => 0);
    for (let index = 0; index < buckets.length; index += 1) {
      if (value <= buckets[index]!) series.counts[index] = (series.counts[index] ?? 0) + 1;
    }
    series.sum = (series.sum ?? 0) + value;
    series.observations = (series.observations ?? 0) + 1;
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, definition] of Object.entries(metricDefinitions)) {
      const values = this.series.get(name);
      if (!values?.size) continue;
      lines.push("# TYPE " + name + (definition.kind === "histogram" ? " histogram" : " " + definition.kind));
      for (const item of values.values()) {
        const labels = { service: this.service, ...item.labels };
        const labelText = (extra: Readonly<Record<string, string>> = {}) => {
          const complete = { ...labels, ...extra };
          const entries = Object.entries(complete);
          return entries.length ? "{" + entries.map(([key, value]) => key + '="' + escapePrometheus(value) + '"').join(",") + "}" : "";
        };
        if (definition.kind !== "histogram") {
          lines.push(name + labelText() + " " + item.value);
          continue;
        }
        const buckets = definition.buckets ?? [];
        for (let index = 0; index < buckets.length; index += 1) {
          lines.push(name + "_bucket" + labelText({ le: String(buckets[index]) }) + " " + (item.counts?.[index] ?? 0));
        }
        lines.push(name + "_bucket" + labelText({ le: "+Inf" }) + " " + (item.observations ?? 0));
        lines.push(name + "_sum" + labelText() + " " + (item.sum ?? 0));
        lines.push(name + "_count" + labelText() + " " + (item.observations ?? 0));
      }
    }
    return lines.join("\n") + (lines.length ? "\n" : "");
  }

  value(name: string, labels: Readonly<Record<string, string>> = {}): number {
    const definition = metricDefinitions[name];
    if (!definition || definition.kind === "histogram" || Object.keys(labels).length !== definition.labels.length) return 0;
    const named = this.series.get(name);
    const item = named?.get(seriesKey(labels));
    return item?.value ?? 0;
  }

  private validate(name: string, kind: MetricKind, labels: Readonly<Record<string, string>>, value: number): MetricDefinition {
    const definition = metricDefinitions[name];
    if (!definition || definition.kind !== kind || !Number.isFinite(value) || value < 0) throw new Error("telemetry_metric_invalid");
    const keys = Object.keys(labels).sort();
    if (keys.join(",") !== [...definition.labels].sort().join(",")) throw new Error("telemetry_metric_labels_invalid");
    for (const [key, label] of Object.entries(labels)) {
      if (!labelValues[key]?.has(label)) throw new Error("telemetry_metric_label_value_invalid");
    }
    return definition;
  }

  private getSeries(name: string, labels: Readonly<Record<string, string>>, definition: MetricDefinition): MetricSeries {
    let named = this.series.get(name);
    if (!named) { named = new Map(); this.series.set(name, named); }
    const complete = { ...labels };
    const key = seriesKey(complete);
    let item = named.get(key);
    if (!item) {
      item = { labels: complete, value: 0 };
      if (definition.kind === "histogram") item.counts = (definition.buckets ?? []).map(() => 0);
      named.set(key, item);
    }
    return item;
  }
}

export function createTelemetryServer(input: {
  service: TelemetryService;
  metrics: TelemetryMetrics;
  port: number;
  host?: string;
  ready?: () => Promise<boolean>;
}): Server {
  if (!Number.isInteger(input.port) || input.port < 0 || input.port > 65_535) throw new Error("observability_port_invalid");
  const server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    if (request.method !== "GET" || request.url?.includes("?") || request.url?.includes("#")) {
      response.writeHead(404).end();
      return;
    }
    if (request.url === "/livez") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ok\n");
      return;
    }
    if (request.url === "/readyz") {
      void Promise.resolve().then(() => input.ready?.() ?? true).then((ready) => {
        response.writeHead(ready ? 200 : 503, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ status: ready ? "ready" : "not_ready", service: input.service }));
      }).catch(() => {
        response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ status: "not_ready", service: input.service }));
      });
      return;
    }
    if (request.url === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" }).end(input.metrics.render());
      return;
    }
    response.writeHead(404).end();
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.listen(input.port, input.host ?? "0.0.0.0");
  return server;
}

export type OperationalSignals = Readonly<{
  oldestWaitingSeconds?: number;
  diskUsedRatio?: number;
  providerRequests?: number;
  providerErrors?: number;
  cleanupFailures?: number;
}>;

export function evaluateOperationalAlerts(signals: OperationalSignals): readonly string[] {
  const alerts: string[] = [];
  if ((signals.oldestWaitingSeconds ?? 0) >= 900) alerts.push("queue_stuck");
  if ((signals.diskUsedRatio ?? 0) >= 0.85) alerts.push("disk_pressure");
  const requests = signals.providerRequests ?? 0;
  const errors = signals.providerErrors ?? 0;
  if (requests >= 5 && errors / requests >= 0.2) alerts.push("provider_errors");
  if ((signals.cleanupFailures ?? 0) > 0) alerts.push("cleanup_failures");
  return alerts;
}

