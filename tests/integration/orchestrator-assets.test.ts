import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { asc, eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimRun,
  createDatabaseFromEnvironment,
  createRepositories,
  finishClaimedRun,
  identityFromAuthenticatedSession,
  runEvents,
  transitionClaimedRun,
  users,
} from "@meta-game/db";
import { createPrivateStorageFromEnvironment } from "@meta-game/storage";
import type { AgentRunEvent, MetaCodeEvent, MetaConversationItem, MetaPlan } from "@meta-game/contracts";
import { createGeneratedImageTool } from "../../apps/worker/src/assets/image-generator";
import { createEditSpriteTool } from "../../apps/worker/src/assets/edit-sprite";
import { createInspectAssetTool } from "../../apps/worker/src/assets/inspect-asset";
import { createCreateTilesetTool } from "../../apps/worker/src/assets/create-tileset";
import { createCreateTilemapTool } from "../../apps/worker/src/assets/create-tilemap";
import { createPackSpritesheetTool } from "../../apps/worker/src/assets/pack-spritesheet";
import { createDefineAnimationTool } from "../../apps/worker/src/assets/define-animation";
import { createAgentRunHandler, type AgentCheckpointStorage } from "../../apps/worker/src/agent/orchestrator";
import { createPostgresAgentRunStore } from "../../apps/worker/src/agent/store";

const integrationEnabled = process.env.PERSISTENCE_TEST_ENABLED === "1";
const model = "muse-spark-1.3-contributor";

async function runIssue37ComposePreview(files: ReadonlyMap<string, string | Uint8Array>): Promise<Record<string, unknown>> {
  const encodedFiles = JSON.stringify([...files].map(([path, value]) => [path, Buffer.from(value).toString("base64")]));
  const docker = process.platform === "win32" ? "docker.exe" : "docker";
  const result = spawnSync(docker, [
    "compose", "--file", "infra/compose.yml", "--env-file", "infra/env.example", "--profile", "security",
    "run", "--build", "--rm", "-T", "security-runner", "node", "--import", "tsx", "scripts/issue37-docker-preview-runner.ts",
  ], {
    cwd: process.cwd(),
    input: encodedFiles,
    encoding: "utf8",
    timeout: 240_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    const composeOutput = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    const reportedFailure = /ISSUE37_SANDBOX_FAILURE=([a-z0-9_]{1,80})/.exec(composeOutput)?.[1];
    const spawnError = result.error as NodeJS.ErrnoException | undefined;
    const spawnCode = typeof spawnError?.code === "string" ? spawnError.code.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 24) : undefined;
    const code = reportedFailure ?? (spawnCode ? `issue_37_compose_spawn_${spawnCode}` : `issue_37_compose_exit_${result.status ?? "unknown"}`);
    const diagnostic = /ISSUE37_SANDBOX_DIAGNOSTIC=([A-Za-z0-9 .,()/@:_-]{1,260})/.exec(composeOutput)?.[1];
    const reportPath = process.env.ISSUE_37_DOCKER_PREVIEW_REPORT;
    if (reportPath) await writeFile(reportPath, `${JSON.stringify({ failure: code }, null, 2)}\n`, { encoding: "utf8", flag: "w" });
    if (diagnostic) process.stderr.write(`Issue #37 sandbox diagnostic: ${diagnostic}\n`);
    if (!reportedFailure) {
      const errorLines = composeOutput.split(/\r?\n/).filter((line) => /error|failed|cannot|not found|no such|denied|timeout/i.test(line)).slice(-3);
      const safeDiagnostic = (spawnError?.code ?? errorLines.join(" | ") ?? "no_diagnostic")
        .replace(/([A-Za-z0-9_]*(?:KEY|PASSWORD|SECRET|TOKEN)[A-Za-z0-9_]*\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
        .replace(/https?:\/\/[^/@\s]+:[^/@\s]+@/gi, "http://[redacted]@")
        .replace(/[^A-Za-z0-9 .,()/@:_-]/g, "").slice(0, 260);
      process.stderr.write(`Issue #37 Compose diagnostic: ${safeDiagnostic || "no_diagnostic"}\n`);
    }
    throw Object.assign(new Error(diagnostic ? `${code}: ${diagnostic}` : code), { code });
  }
  const reportLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith("ISSUE37_DOCKER_PREVIEW_REPORT="));
  if (!reportLine) throw new Error("issue_37_compose_preview_report_missing");
  const report = JSON.parse(reportLine.slice("ISSUE37_DOCKER_PREVIEW_REPORT=".length)) as Record<string, unknown>;
  const reportPath = process.env.ISSUE_37_DOCKER_PREVIEW_REPORT;
  if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return report;
}

describe.skipIf(!integrationEnabled)("orquestador de assets con PostgreSQL, Silo y Meta simulado", () => {
  const userId = "user_assetOrchestrator" + randomUUID().replaceAll("-", "");
  const identity = identityFromAuthenticatedSession({ userId });
  let database: ReturnType<typeof createDatabaseFromEnvironment>;
  let repositories: ReturnType<typeof createRepositories>;
  let storage: ReturnType<typeof createPrivateStorageFromEnvironment>;
  const storedIds = new Set<string>();

  beforeAll(() => {
    database = createDatabaseFromEnvironment();
    repositories = createRepositories(database.db);
    storage = createPrivateStorageFromEnvironment(repositories.assets);
  });

  afterAll(async () => {
    if (storage) {
      for (const id of storedIds) await storage.delete(identity, id).catch(() => undefined);
      storage.close();
    }
    if (database) {
      await database.db.delete(users).where(inArray(users.userId, [userId]));
      await database.close();
    }
  });

  it("emits serial durable asset cards and feeds Silo outputs to Phaser preview", async () => {
    const project = await repositories.projects.create(identity, { name: "Issue 36 asset orchestration" });
    await database.db.update(users).set({ contributorConsentAt: new Date() }).where(eq(users.userId, userId));
    const message = await repositories.messages.create(identity, {
      projectId: project.id,
      requestId: `asset-message-${randomUUID()}`,
      role: "user",
      content: "Genera un sprite sheet, construye sus mapas y verifica la animación.",
    });
    const enqueued = await repositories.runs.enqueueRun(identity, {
      projectId: project.id,
      idempotencyKey: `asset-run-${randomUUID()}`,
      messageRequestId: message.requestId,
      contributorConsent: true,
      policy: { maxConcurrentJobs: 2, runMaxTokens: 20_000, dailyTokenLimit: 30_000, dailyImageLimit: 10 },
    });
    const claimed = await claimRun(database.db, {
      runId: enqueued.run.id,
      idempotencyKey: enqueued.run.idempotencyKey,
      generation: 0,
      leaseMs: 30_000,
    });
    if (!claimed) throw new Error("asset acceptance run was not claimed");
    const claim = claimed.claim;
    await transitionClaimedRun(database.db, claim, "running");

    const files = new Map<string, string | Uint8Array>();
    let dockerPreviewResult: Promise<Record<string, unknown>> | undefined;
    const missing = () => Object.assign(new Error("file_not_found"), { code: "file_not_found" });
    const sandbox = {
      async create() {
        return { sandboxId: "issue-36-asset-sandbox", state: "ready", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), devServer: { status: "stopped", port: null, leaseExpiresAt: null } };
      },
      async inspect() { throw Object.assign(new Error("not_found"), { code: "not_found" }); },
      async readFile(_projectId: string, path: string) {
        const value = files.get(path);
        if (typeof value === "string") return { path, content: value };
        if (path === "public/assets/generated/manifest.json") return { path, content: JSON.stringify({ schemaVersion: 1, assets: [] }) };
        if (path === ".meta-game-template.json") throw Object.assign(new Error("not_found"), { code: "not_found" });
        if (path === "package.json") return { path, content: '{"scripts":{"test":"vitest run","lint":"eslint .","build":"vite build"}}' };
        throw missing();
      },
      async readBinaryFile(_projectId: string, path: string) {
        const value = files.get(path);
        if (!(value instanceof Uint8Array)) throw missing();
        return value;
      },
      async writeFile(_projectId: string, path: string, content: string) {
        files.set(path, content);
        return { path, bytesWritten: Buffer.byteLength(content, "utf8") };
      },
      async writeBinaryFile(_projectId: string, path: string, bytes: Uint8Array) {
        files.set(path, Buffer.from(bytes));
        return { path, bytesWritten: bytes.byteLength };
      },
      async deleteFile(_projectId: string, path: string) { return { path, deleted: files.delete(path) }; },
      async listFiles(path = "") { return { path, files: [] }; },
      async installDependencies() { return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, truncated: false }; },
      async runCommand(_projectId: string, input: { args: string[] }) { return { stdout: `passed ${input.args.join(" ")}`, stderr: "", exitCode: 0, durationMs: 2, truncated: false }; },
      async startDevServer() { return { status: "ready", port: 4173, leaseExpiresAt: null }; },
      async readLogs() { return { status: "ready", port: 4173, leaseExpiresAt: null, stdout: "", stderr: "" }; },
      async verifyGameInteraction() {
        if (process.env.ISSUE_37_ASSET_ACCEPTANCE !== "1") return { status: "passed", checks: [], consoleErrors: [], blockedRequests: 0 };
        dockerPreviewResult ??= runIssue37ComposePreview(files);
        const report = await dockerPreviewResult;
        const reportSummary = JSON.stringify(report).slice(0, 480);
        return {
          status: "passed",
          checks: [{ name: "issue-37-docker-preview", status: "passed", summary: reportSummary }],
          consoleErrors: [],
          blockedRequests: 0,
        };
      },
    };
    const imagePixels = Buffer.alloc(32 * 32 * 4);
    const colors = [[35, 115, 230], [38, 220, 80], [190, 70, 225], [230, 190, 35]] as const;
    for (let y = 0; y < 32; y += 1) for (let x = 0; x < 32; x += 1) {
      const color = colors[Math.floor(y / 16) * 2 + Math.floor(x / 16)]!;
      const offset = (y * 32 + x) * 4;
      imagePixels.set([...color, 255], offset);
    }
    const mockedMeta = {
      async generateImage() {
        return {
          bytes: await sharp(imagePixels, { raw: { width: 32, height: 32, channels: 4 } }).png().toBuffer(),
          mimeType: "image/png" as const,
          width: 32,
          height: 32,
          model: "fixture-image-model",
          responseId: `fixture-image-${randomUUID()}`,
          requestId: `fixture-request-${randomUUID()}`,
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        };
      },
      async editImage() {
        const bytes = await sharp(imagePixels, { raw: { width: 32, height: 32, channels: 4 } }).extract({ left: 0, top: 0, width: 16, height: 16 }).png().toBuffer();
        return { bytes, mimeType: "image/png" as const, width: 16, height: 16, model: "fixture-image-model", responseId: `fixture-edit-${randomUUID()}`, requestId: `fixture-edit-request-${randomUUID()}`, usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } };
      },
    };
    const identityForClaim = async (candidate: typeof claim) => {
      if (candidate.projectId !== project.id) throw new Error("fixture_project_mismatch");
      return identity;
    };
    const generatedImage = createGeneratedImageTool({ meta: mockedMeta as never, storage, sandbox: sandbox as never, identity: identityForClaim, now: () => new Date("2026-11-03T12:00:00.000Z") });
    const spriteEditor = createEditSpriteTool({ meta: mockedMeta as never, storage, sandbox: sandbox as never, identity: identityForClaim, now: () => new Date("2026-11-03T12:00:00.000Z") });
    const inspector = createInspectAssetTool({ sandbox: sandbox as never, storage, identity: identityForClaim });
    const tilesetCreator = createCreateTilesetTool({ storage, sandbox: sandbox as never, identity: identityForClaim });
    const tilemapCreator = createCreateTilemapTool({ storage, sandbox: sandbox as never, identity: identityForClaim });
    const spritesheetPacker = createPackSpritesheetTool({ storage, sandbox: sandbox as never, identity: identityForClaim });
    const animationDefiner = createDefineAnimationTool({ storage, sandbox: sandbox as never, identity: identityForClaim });

    const plan: MetaPlan = {
      summary: "Crear y verificar assets Phaser con herramientas tipadas.",
      objective: "Persistir imagen, tileset, mapa, atlas y animación con ownership verificado.",
      steps: [{ id: "assets", title: "Crear assets", description: "Ejecutar las herramientas secuencialmente.", expectedFiles: ["public/assets/generated"], verifications: ["npm test", "npm run build"] }],
    };
    const calls = [
      { callId: "asset-generate-1", name: "generate_image", arguments: { assetType: "sprite", description: "Four original colored hero frames for a tiny Phaser demo", style: "crisp pixel art", view: "side", palette: ["#2373e6", "#26dc50", "#be46e1", "#e6be23"], transparentBackground: false, frameColumns: 2, frameRows: 2, tileable: false } },
      { callId: "asset-edit-1", name: "edit_sprite", arguments: { sourceAssetId: "from-generate_image", sourceFrameIndex: 0, requestedChange: "Refine the hero outline and keep the same colors.", preserve: { canvas: true, style: true, palette: true, characterIdentity: true } } },
      { callId: "asset-inspect-1", name: "inspect_asset", arguments: { assetId: "from-generate_image", kind: "image", checks: ["decode", "dimensions", "alpha", "frame-grid"] } },
      { callId: "asset-tileset-1", name: "create_tileset", arguments: { name: "acceptance_terrain", tileSize: 16, columns: 2, tiles: [0, 1, 2, 3].map((sourceFrameIndex) => ({ sourceAssetId: "from-generate_image", sourceFrameIndex, tileName: ["water", "ground", "wall", "decoration"][sourceFrameIndex]!, collides: sourceFrameIndex === 1 || sourceFrameIndex === 2, terrain: ["water", "ground", "wall", "decoration"][sourceFrameIndex]! })) } },
      { callId: "asset-tilemap-1", name: "create_tilemap", arguments: { name: "acceptance_level", tilesetAssetId: "from-create_tileset", width: process.env.ISSUE_37_ASSET_ACCEPTANCE === "1" ? 16 : 8, height: 6, collisionLayerNames: ["ground"], layers: [{ name: "background", cells: [{ x: 0, y: 0, tileName: "water" }, { x: 1, y: 0, tileName: "ground" }, { x: 2, y: 0, tileName: "wall" }, { x: 3, y: 0, tileName: "decoration" }] }, { name: "hidden", visible: false, cells: [] }, { name: "ground", cells: [...Array.from({ length: process.env.ISSUE_37_ASSET_ACCEPTANCE === "1" ? 14 : 7 }, (_, x) => ({ x, y: 4, tileName: "ground" })), ...(process.env.ISSUE_37_ASSET_ACCEPTANCE === "1" ? [{ x: 6, y: 3, tileName: "wall" }] : [])] }, { name: "props", cells: [{ x: process.env.ISSUE_37_ASSET_ACCEPTANCE === "1" ? 15 : 7, y: 4, tileName: "decoration" }] }] } },
      { callId: "asset-atlas-1", name: "pack_spritesheet", arguments: { name: "acceptance_hero", frames: [0, 1, 2, 3].map((sourceFrameIndex) => ({ sourceAssetId: "from-generate_image", sourceFrameIndex, frameName: process.env.ISSUE_37_ASSET_ACCEPTANCE === "1" ? ["idle_0", "run_0", "run_1", "run_2"][sourceFrameIndex]! : `run_${sourceFrameIndex}` })), paddingPixels: 2, extrudePixels: 1, maxTextureSize: 128 } },
      { callId: "asset-animation-1", name: "define_animation", arguments: { atlasAssetId: "from-pack_spritesheet", animations: [...(process.env.ISSUE_37_ASSET_ACCEPTANCE === "1" ? [{ key: "acceptance-idle", frameNames: ["idle_0"], frameRate: 1, repeat: -1 }] : []), { key: "acceptance-run", frameNames: ["run_0", "run_1", "run_2"], frameRate: 6, repeat: -1 }, { key: "acceptance-yoyo", frameNames: ["run_0", "run_1"], frameRate: 8, repeat: 1, yoyo: true, delayMs: 50, repeatDelayMs: 25 }] } },
    ] as const;
    let codeTurn = 0;
    const meta = {
      async plan() { return { plan, model, responseId: "fixture-plan-assets", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }; },
      async *streamCode(input: { context?: MetaConversationItem[] }) {
        const turn = codeTurn++;
        if (turn >= calls.length) {
          yield { type: "completed", responseId: "fixture-assets-final", model, replay: [...(input.context ?? []), { kind: "message", role: "assistant", text: "Los assets fueron creados, persistidos y verificados." }], usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } } satisfies MetaCodeEvent;
          return;
        }
        const definition = calls[turn]!;
        const priorToolResult = [...(input.context ?? [])].reverse().find((item) => item.kind === "tool_result");
        const prior = priorToolResult?.kind === "tool_result" ? JSON.parse(priorToolResult.output) as Record<string, unknown> : undefined;
        const args = JSON.parse(JSON.stringify(definition.arguments)) as Record<string, unknown>;
        if (definition.name === "edit_sprite" || definition.name === "inspect_asset" || definition.name === "create_tileset" || definition.name === "pack_spritesheet") {
          const generated = [...(input.context ?? [])].reverse().find((item) => item.kind === "tool_result" && item.callId === "asset-generate-1");
          if (generated?.kind !== "tool_result") throw new Error("fixture_generated_image_result_missing");
          const assetId = (JSON.parse(generated.output) as { assetId: string }).assetId;
          if (definition.name === "edit_sprite") args.sourceAssetId = assetId;
          if (definition.name === "inspect_asset") args.assetId = assetId;
          if (definition.name === "create_tileset") {
            const frames = args.tiles as Array<Record<string, unknown>> | undefined;
            frames?.forEach((frame) => { frame.sourceAssetId = assetId; });
          }
          if (definition.name === "pack_spritesheet") {
            const packFrames = args.frames as Array<Record<string, unknown>> | undefined;
            packFrames?.forEach((frame) => { frame.sourceAssetId = assetId; });
          }
        }
        if (definition.name === "create_tilemap") {
          if (!prior || typeof prior.tilesetAssetId !== "string") throw new Error("fixture_tileset_result_missing");
          args.tilesetAssetId = prior.tilesetAssetId;
        }
        if (definition.name === "define_animation") {
          if (!prior || typeof prior.atlasAssetId !== "string") throw new Error("fixture_atlas_result_missing");
          args.atlasAssetId = prior.atlasAssetId;
        }
        const call = { type: "tool_call", callId: definition.callId, name: definition.name, arguments: args } satisfies MetaCodeEvent;
        const replayCall: MetaConversationItem = { kind: "tool_call", callId: definition.callId, name: definition.name, arguments: args };
        yield call;
        yield { type: "completed", responseId: `fixture-assets-call-${turn}`, model, replay: [...(input.context ?? []), replayCall, { kind: "message", role: "assistant", text: `Ejecutar ${definition.name}.` }], usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } } satisfies MetaCodeEvent;
      },
    };
    const checkpointBodies = new Map<string, Uint8Array>();
    const checkpoints: AgentCheckpointStorage = {
      async write(checkpointIdentity, body) { checkpointBodies.set(checkpointIdentity.runId, body.slice()); return { sha256: createHash("sha256").update(body).digest("hex"), sizeBytes: body.byteLength }; },
      async read(checkpointIdentity) { const body = checkpointBodies.get(checkpointIdentity.runId); if (!body) throw new Error("checkpoint_missing"); return body; },
      async delete(checkpointIdentity) { checkpointBodies.delete(checkpointIdentity.runId); },
    };
    const skills = { async routeForRun(input: { runId: string }) { return { runId: input.runId, record: { schemaVersion: 1, runId: input.runId, skills: [], references: [] }, skills: [], references: [], advisoryNotice: "Contexto consultivo de aceptación." }; } };
    const handler = createAgentRunHandler({
      store: createPostgresAgentRunStore(database.db), meta: meta as never, sandbox: sandbox as never, checkpoints,
      skills: skills as never, imageGenerator: generatedImage as never, assetInspector: inspector as never,
      spriteEditor: spriteEditor as never,
      tilesetCreator: tilesetCreator as never, tilemapCreator: tilemapCreator as never,
      spritesheetPacker: spritesheetPacker as never, animationDefiner: animationDefiner as never,
      maxSteps: 20, maxTokens: 20_000, maxDurationMs: process.env.ISSUE_37_ASSET_ACCEPTANCE === "1" ? 240_000 : 60_000,
    });
    let result: Awaited<ReturnType<typeof handler>>;
    try {
      result = await handler({ id: enqueued.run.id, projectId: project.id, idempotencyKey: enqueued.run.idempotencyKey }, {
        signal: new AbortController().signal,
        claim,
        markVerifying: async () => transitionClaimedRun(database.db, claim, "verifying"),
      });
    } catch (error) {
      if (process.env.ISSUE_37_ASSET_ACCEPTANCE === "1") {
        const failedEvents = await database.db.select().from(runEvents).where(eq(runEvents.runId, enqueued.run.id)).orderBy(asc(runEvents.sequence)) as unknown as AgentRunEvent[];
        const checks = failedEvents.filter((event): event is Extract<AgentRunEvent, { type: "agent.verification" }> => event.type === "agent.verification")
          .map((event) => `${event.payload.check}=${event.payload.status}:${event.payload.summary.slice(0, 160)}`);
        throw new Error(`${error instanceof Error ? error.message : "run_failed"} [${checks.join(" | ")}]`);
      }
      throw error;
    }
    await finishClaimedRun(database.db, claim, { status: "succeeded", usage: result.usage });

    const events = await database.db.select().from(runEvents).where(eq(runEvents.runId, enqueued.run.id)).orderBy(asc(runEvents.sequence)) as unknown as AgentRunEvent[];
    const toolCompletions = events.filter((event) => event.type === "agent.tool_completed");
    const expectedAssetTools = ["generate_image", "edit_sprite", "inspect_asset", "create_tileset", "create_tilemap", "pack_spritesheet", "define_animation"];
    expect(toolCompletions.filter((event): event is Extract<AgentRunEvent, { type: "agent.tool_completed" }> => event.type === "agent.tool_completed" && expectedAssetTools.includes(event.payload.toolName))
      .map((event) => event.payload.toolName)).toEqual(expectedAssetTools);
    const cards = events.filter((event) => event.type === "agent.asset_result");
    expect(cards.map((event) => event.type === "agent.asset_result" ? [event.payload.card.toolName, event.payload.card.status] : [])).toEqual([
      ["generate_image", "succeeded"], ["edit_sprite", "succeeded"], ["inspect_asset", "succeeded"], ["create_tileset", "succeeded"],
      ["create_tilemap", "succeeded"], ["pack_spritesheet", "succeeded"], ["define_animation", "succeeded"],
    ]);
    expect(events.some((event) => event.type === "agent.completed")).toBe(true);
    if (process.env.ISSUE_37_ASSET_ACCEPTANCE === "1") {
      const browserVerificationIndex = events.findIndex((event) => event.type === "agent.verification" && event.payload.check === "browser issue-37-docker-preview" && event.payload.status === "passed");
      const previewReadyIndex = events.findIndex((event) => event.type === "agent.preview_ready");
      expect(browserVerificationIndex).toBeGreaterThanOrEqual(0);
      expect(previewReadyIndex).toBeGreaterThan(browserVerificationIndex);
    }

    const generatedCompletion = toolCompletions.find((event) => event.type === "agent.tool_completed" && event.payload.toolName === "generate_image");
    const editCompletion = toolCompletions.find((event) => event.type === "agent.tool_completed" && event.payload.toolName === "edit_sprite");
    const tilemapCompletion = toolCompletions.find((event) => event.type === "agent.tool_completed" && event.payload.toolName === "create_tilemap");
    const atlasCompletion = toolCompletions.find((event) => event.type === "agent.tool_completed" && event.payload.toolName === "pack_spritesheet");
    const animationCompletion = toolCompletions.find((event) => event.type === "agent.tool_completed" && event.payload.toolName === "define_animation");
    if (!generatedCompletion || !editCompletion || !tilemapCompletion || !atlasCompletion || !animationCompletion ||
        generatedCompletion.type !== "agent.tool_completed" || tilemapCompletion.type !== "agent.tool_completed" ||
        editCompletion.type !== "agent.tool_completed" || atlasCompletion.type !== "agent.tool_completed" || animationCompletion.type !== "agent.tool_completed") throw new Error("asset tool completion missing");
    const generated = JSON.parse(generatedCompletion.payload.result) as { assetId: string; contactSheetAssetId: string };
    const edited = JSON.parse(editCompletion.payload.result) as { assetId: string };
    const tilemapResult = JSON.parse(tilemapCompletion.payload.result) as { tilemapAssetId: string; tilesetAssetId: string };
    const spritesheetResult = JSON.parse(atlasCompletion.payload.result) as { atlasAssetId: string; textureAssetId: string };
    const animationResult = JSON.parse(animationCompletion.payload.result) as { animationManifestAssetId: string };
    const sourceImage = await storage.read(identity, generated.assetId);
    const contactSheet = await storage.read(identity, generated.contactSheetAssetId);
    const editedAsset = await storage.read(identity, edited.assetId);
    const editedContactSheetId = String((editedAsset.asset.metadata?.qa as { contactSheetAssetId?: string } | undefined)?.contactSheetAssetId);
    const editedContactSheet = await storage.read(identity, editedContactSheetId);
    const tilemap = await storage.read(identity, tilemapResult.tilemapAssetId);
    const tileset = await storage.read(identity, tilemapResult.tilesetAssetId);
    const tilesetMetadata = await storage.read(identity, String(tileset.asset.metadata?.metadataAssetId));
    const atlas = await storage.read(identity, spritesheetResult.atlasAssetId);
    const texture = await storage.read(identity, spritesheetResult.textureAssetId);
    const animation = await storage.read(identity, animationResult.animationManifestAssetId);
    for (const asset of [sourceImage, contactSheet, editedAsset, editedContactSheet, tilemap, tileset, tilesetMetadata, atlas, texture, animation]) storedIds.add(asset.asset.id);
    const issue36SpritesheetPath = process.env.ISSUE_36_SPRITESHEET_PREVIEW_ARTIFACT;
    if (issue36SpritesheetPath) {
      await writeFile(issue36SpritesheetPath, JSON.stringify({
        result: JSON.parse(atlasCompletion.payload.result),
        imageBase64: Buffer.from(texture.body).toString("base64"),
        atlasBase64: Buffer.from(atlas.body).toString("base64"),
        animationResult: JSON.parse(animationCompletion.payload.result),
        animationManifestBase64: Buffer.from(animation.body).toString("base64"),
      }), { encoding: "utf8", flag: "wx" });
    }
    const issue36TilemapPath = process.env.ISSUE_36_TILEMAP_PREVIEW_ARTIFACT;
    if (issue36TilemapPath) {
      await writeFile(issue36TilemapPath, JSON.stringify({
        tilemapBase64: Buffer.from(tilemap.body).toString("base64"),
        tilesetImageBase64: Buffer.from(tileset.body).toString("base64"),
        tilesetMetadataBase64: Buffer.from(tilesetMetadata.body).toString("base64"),
      }), { encoding: "utf8", flag: "wx" });
    }
  }, process.env.ISSUE_37_ASSET_ACCEPTANCE === "1" ? 240_000 : 5_000);
});
