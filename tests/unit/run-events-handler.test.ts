import { describe, expect, it, vi } from "vitest";
import { identityFromAuthenticatedSession } from "@meta-game/db";
import { createRunEventsHandler, parseLastEventId } from "../../apps/web/server/projects/run-events-handler";

const runId = "00000000-0000-4000-8000-000000000222";
const identity = identityFromAuthenticatedSession({ userId: "user_runStreamFixture0001" });
const hash = "a".repeat(64);
const timestamp = new Date("2026-11-02T10:00:00.000Z");

function stored(sequence: number, type: string, payload: unknown) {
  return { sequence, type, payload, createdAt: new Date(timestamp.getTime() + sequence) };
}

const events = [
  stored(1, "run.queued", { reservationId: "private-reservation", contributorConsent: true }),
  stored(2, "agent.plan", {
    plan: {
      summary: "Crear un prototipo de plataformas. https://preview.example.test/?grant=private",
      objective: "Moverse y saltar hasta la meta.",
      steps: [{ id: "scene", title: "Crear la escena", description: "Escena inicial.", expectedFiles: ["src/main.ts"], verifications: ["npm run build"] }],
    },
    model: "private-model-id",
    responseId: "private-response-id",
    usage: { tokens: 12, images: 0 },
  }),
  stored(3, "agent.tool_started", { callId: "write-call", toolName: "write_file", argsHash: hash }),
  stored(4, "agent.tool_completed", {
    callId: "write-call", toolName: "write_file", argsHash: hash,
    result: JSON.stringify({ path: "src/main.ts", bytesWritten: 42 }),
  }),
  stored(5, "agent.action", { callId: "write-call", toolName: "write_file", summary: "Escribir src/main.ts (42 bytes) https://preview.example.test/?grant=private" }),
  stored(6, "agent.verification", { check: "npm run build", status: "failed", exitCode: 1, summary: "Bearer abcdefghijklmnop123456: build error" }),
  stored(7, "agent.preview_ready", { state: "ready" }),
  stored(8, "run.succeeded", { usage: { tokens: 99, images: 0 } }),
];

function makeHandler(input: { owned?: boolean; rows?: typeof events } = {}) {
  const listEvents = vi.fn(async (_identity: typeof identity, _run: string, query: { afterSequence: number }) =>
    (input.rows ?? events).filter((event) => event.sequence > query.afterSequence));
  const get = vi.fn(async () => input.owned === false ? undefined : ({ id: runId, status: "succeeded" }));
  const handler = createRunEventsHandler({ identity, runs: { get, listEvents } as never });
  return { handler, listEvents, get };
}

function request(lastEventId?: string) {
  return new Request(`https://app.example.test/api/runs/${runId}/events`, {
    headers: { accept: "text/event-stream", ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }) },
  });
}

function parseFrames(body: string) {
  return body.split("\n\n").filter((frame) => frame.startsWith("id: ")).map((frame) => {
    const id = frame.match(/^id: (\d+)/m)?.[1];
    const event = frame.match(/^event: ([a-z.]+)/m)?.[1];
    const data = frame.match(/^data: (.+)$/m)?.[1];
    return { id: Number(id), event, data: JSON.parse(data ?? "null") as Record<string, unknown> };
  });
}

describe("SSE de runs", () => {
  it("acepta cursors monotónicos y rechaza valores malformados o fuera de rango", () => {
    expect(parseLastEventId(null)).toBe(0);
    expect(parseLastEventId("0")).toBe(0);
    expect(parseLastEventId("15")).toBe(15);
    for (const value of ["-1", "+1", "01", "1.2", "1x", "9".repeat(17)]) {
      expect(() => parseLastEventId(value)).toThrow(TypeError);
    }
  });

  it("reproduce eventos versionados, filtra payloads internos y marca la preview solo tras salud", async () => {
    const { handler } = makeHandler();
    const response = await handler(request(), { params: Promise.resolve({ runId }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.text();
    const frames = parseFrames(body);
    expect(frames.map(({ event }) => event)).toEqual([
      "run.queued", "plan.created", "step.started", "file.changed", "step.completed", "verification.result", "preview.ready", "run.finished",
    ]);
    expect(frames.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(frames.every(({ data }) => data.version === 1 && data.runId === runId)).toBe(true);
    expect(frames.find(({ event }) => event === "file.changed")?.data.payload).toEqual({ path: "src/main.ts", bytesWritten: 42 });
    expect(frames.find(({ event }) => event === "step.completed")?.data.payload).toMatchObject({ stepId: "write-call", status: "succeeded" });
    expect(frames.find(({ event }) => event === "preview.ready")?.data.payload).toEqual({ state: "ready" });
    expect(body).not.toContain("private-reservation");
    expect(body).not.toContain("private-model-id");
    expect(body).not.toContain("private-response-id");
    expect(body).not.toContain("abcdefghijklmnop123456");
    expect(body).not.toContain("build error");
    expect(body).not.toContain("https://preview.example.test");
    expect(body).not.toContain("grant=private");
    expect(frames.find(({ event }) => event === "plan.created")?.data.payload).toMatchObject({ summary: expect.not.stringContaining("https://") });
  });

  it("continúa desde Last-Event-ID antiguo sin duplicar los eventos anteriores", async () => {
    const { handler, listEvents } = makeHandler();
    const response = await handler(request("3"), { params: Promise.resolve({ runId }) });
    const frames = parseFrames(await response.text());
    expect(frames.map(({ id }) => id)).toEqual([4, 5, 6, 7, 8]);
    expect(listEvents).toHaveBeenCalledWith(identity, runId, { afterSequence: 3, limit: 50 });
  });

  it("rechaza cursor inválido antes de abrir el stream", async () => {
    const { handler, get } = makeHandler();
    const response = await handler(request("01"), { params: Promise.resolve({ runId }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(get).not.toHaveBeenCalled();
  });

  it("emite el path validado de una imagen sin filtrar procedencia privada ni hashes", async () => {
    const { handler } = makeHandler({ rows: [
      stored(1, "agent.tool_completed", {
        callId: "image-call",
        toolName: "generate_image",
        argsHash: hash,
        result: JSON.stringify({
          assetId: "00000000-0000-4000-8000-000000000201",
          contactSheetAssetId: "00000000-0000-4000-8000-000000000202",
          path: "assets/generated/00000000-0000-4000-8000-000000000201.png",
          bytesWritten: 128,
          sha256: "b".repeat(64),
          model: "private-model-id",
          prompt: "secret private prompt",
        }),
      }),
      stored(2, "run.succeeded", { summary: "Generated asset" }),
    ] });

    const response = await handler(request(), { params: Promise.resolve({ runId }) });
    const body = await response.text();
    const frames = parseFrames(body);
    expect(frames[0]?.data.payload).toEqual({ path: "assets/generated/00000000-0000-4000-8000-000000000201.png", bytesWritten: 128 });
    expect(body).not.toContain("private-model-id");
    expect(body).not.toContain("secret private prompt");
    expect(body).not.toContain("b".repeat(64));
    expect(body).not.toContain("00000000-0000-4000-8000-000000000202");
  });

  it("reconstruye tarjetas de assets y errores desde eventos durables con campos allowlisted", async () => {
    const successfulCard = {
      callId: "atlas-call",
      toolName: "pack_spritesheet",
      status: "succeeded",
      title: "Spritesheet empaquetado",
      summary: "4 frames en atlas Phaser.",
      assetType: "spritesheet",
      assets: [{ assetId: "00000000-0000-4000-8000-000000000221", role: "texture", sha256: "c".repeat(64), previewable: true }],
      previewAssetId: "00000000-0000-4000-8000-000000000221",
      frameCount: 4,
      verificationStatus: "passed",
      verificationSummary: "Rectángulos y checksum validados.",
    } as const;
    const failedCard = {
      callId: "tilemap-call",
      toolName: "create_tilemap",
      status: "failed",
      title: "Crear tilemap",
      summary: "La herramienta no pudo completar este asset.",
      assetType: "tilemap",
      assets: [],
      verificationStatus: "failed",
      verificationSummary: "Revisa el código de error antes de volver a intentarlo.",
      errorCode: "tilemap_tileset_missing",
    } as const;
    const { handler } = makeHandler({ rows: [
      stored(1, "agent.tool_started", { callId: "atlas-call", toolName: "pack_spritesheet", argsHash: hash }),
      stored(2, "agent.asset_result", { card: successfulCard }),
      stored(3, "agent.tool_failed", { callId: "tilemap-call", toolName: "create_tilemap", argsHash: hash, errorCode: "tilemap_tileset_missing", assetCard: failedCard }),
      stored(4, "run.failed", { errorCode: "tilemap_tileset_missing" }),
    ] });
    const response = await handler(request(), { params: Promise.resolve({ runId }) });
    const body = await response.text();
    const frames = parseFrames(body);
    expect(frames.map(({ event }) => event)).toEqual(["step.started", "asset.card", "asset.card", "run.failed"]);
    expect(frames[1]?.data.payload).toMatchObject(successfulCard);
    expect(frames[2]?.data.payload).toMatchObject({ callId: "tilemap-call", status: "failed", errorCode: "tilemap_tileset_missing" });
    expect(body).not.toContain("argsHash");
    expect(body).not.toContain("private-model-id");
    expect(body).not.toContain("grant=");
  });

  it("oculta runs ajenos con 404 uniforme", async () => {
    const { handler, listEvents } = makeHandler({ owned: false });
    const response = await handler(request(), { params: Promise.resolve({ runId }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(listEvents).not.toHaveBeenCalled();
  });

  it("proyecta estado fallido/cancelado y oculta rutas de credenciales", async () => {
    const { handler } = makeHandler({ rows: [
      stored(1, "agent.tool_completed", {
        callId: "secret-file", toolName: "write_file", argsHash: hash,
        result: JSON.stringify({ path: ".env.local", bytesWritten: 22 }),
      }),
      stored(2, "run.failed", { errorCode: "verification_failed" }),
    ] });
    const response = await handler(request(), { params: Promise.resolve({ runId }) });
    const frames = parseFrames(await response.text());
    expect(frames.map(({ event }) => event)).toEqual(["run.cursor", "run.failed"]);
    expect(frames[1]?.data.payload).toEqual({ errorCode: "verification_failed" });
    expect(JSON.stringify(frames)).not.toContain(".env.local");
  });

  it("cierra sin contenido si auth revoca la sesión durante el stream", async () => {
    const { listEvents } = makeHandler();
    const response = await createRunEventsHandler({
      identity,
      runs: { get: async () => ({ id: runId, status: "running" }), listEvents } as never,
      validateSession: async () => { throw new Error("session revoked"); },
    })(request(), { params: Promise.resolve({ runId }) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(listEvents).not.toHaveBeenCalled();
  });

  it("mantiene el buffer acotado si el navegador deja de leer", async () => {
    const { handler, listEvents } = makeHandler({ rows: events.slice(0, 6) });
    const response = await handler(request(), { params: Promise.resolve({ runId }) });
    const reader = response.body!.getReader();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(listEvents).toHaveBeenCalledTimes(1);
    await reader.cancel();
  });

  it("proyecta el plan en issues y el estado de cada sub-agente", async () => {
    const rows = [
      stored(1, "run.queued", {}),
      stored(2, "agent.issue_plan", { planId: "plan-c1", title: "Demo", issues: [{ id: "01-core", title: "Core", path: "docs/issues/01-core.md", status: "pending", dependsOn: [] }] }),
      stored(3, "agent.subagent_started", { issueId: "01-core", title: "Core" }),
      stored(4, "agent.subagent_completed", { issueId: "01-core", title: "Core", status: "succeeded", summary: "Escena creada" }),
      stored(5, "run.succeeded", {}),
    ];
    const { handler } = makeHandler({ rows: rows as never });
    const response = await handler(request(), { params: Promise.resolve({ runId }) });
    const frames = parseFrames(await response.text());
    expect(frames.map((f) => f.event)).toEqual(["run.queued", "issue.plan", "subagent.updated", "subagent.updated", "run.finished"]);
    expect(frames[1]?.data.payload).toMatchObject({ planId: "plan-c1", issues: [{ id: "01-core", status: "pending" }] });
    expect(frames[2]?.data.payload).toMatchObject({ issueId: "01-core", status: "running" });
    expect(frames[3]?.data.payload).toMatchObject({ issueId: "01-core", status: "succeeded", summary: "Escena creada" });
  });
});

describe("proyeccion del flujo agentico", () => {
  it("proyecta agent.phase y tool calls con fase/issue sin filtrar args", async () => {
    const rows = [
      stored(1, "run.queued", {}),
      stored(2, "agent.phase", { phase: "inventory", status: "completed", summary: "Inventario comparado" }),
      stored(3, "agent.phase", { phase: "sprites", status: "started", summary: "Creando sprites" }),
      stored(4, "agent.tool_started", { callId: "sub-01-hero-c1", toolName: "pack_spritesheet", argsHash: hash, phase: "sprites", issueId: "01-hero" }),
      stored(5, "agent.action", { callId: "sub-01-hero-c1", toolName: "pack_spritesheet", summary: "Empaquetar 4 frames", phase: "sprites", issueId: "01-hero" }),
      stored(6, "run.succeeded", {}),
    ];
    const { handler } = makeHandler({ rows: rows as never });
    const response = await handler(request(), { params: Promise.resolve({ runId }) });
    const frames = parseFrames(await response.text());
    expect(frames.map((f) => f.event)).toEqual(["run.queued", "phase.updated", "phase.updated", "step.started", "step.completed", "run.finished"]);
    expect(frames[1]?.data.payload).toMatchObject({ phase: "inventory", status: "completed" });
    expect(frames[3]?.data.payload).toMatchObject({ toolName: "pack_spritesheet", phase: "sprites", issueId: "01-hero" });
    expect(frames[4]?.data.payload).toMatchObject({ status: "succeeded", toolName: "pack_spritesheet", phase: "sprites" });
    expect(JSON.stringify(frames)).not.toContain("argsHash");
  });
});
