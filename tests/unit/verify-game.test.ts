import { describe, expect, it, vi } from "vitest";
import { createGameSpec } from "../../apps/worker/src/pipelines/generate-game";
import { verifyGame } from "../../apps/worker/src/pipelines/verify-game";

const spec = createGameSpec("Crea un juego de plataformas");
const passedBrowser = { status: "passed" as const, checks: [{ name: "keyboard interaction", status: "passed" as const, summary: "El estado cambió." }], consoleErrors: [], blockedRequests: 0 };

function input(overrides: Partial<Parameters<typeof verifyGame>[0]> = {}): Parameters<typeof verifyGame>[0] {
  return {
    spec,
    readManifest: async () => JSON.stringify({ scripts: { test: "vitest run", lint: "tsc --noEmit", build: "vite build" } }),
    runCommand: vi.fn(async () => ({ stdout: "ok", stderr: "", exitCode: 0, durationMs: 5, truncated: false })),
    startDevServer: vi.fn(async () => ({ status: "ready", port: 4173 })),
    verifyInteraction: vi.fn(async () => passedBrowser),
    readRuntimeSpec: async () => JSON.stringify({ genre: spec.genre }),
    listChangedGameplayFiles: async () => ["src/game/PlayScene.ts"],
    readLogs: vi.fn(async () => ({ stdout: "", stderr: "" })),
    onCheck: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("verificación completa del juego", () => {
  it("requiere lógica, lint, build, health y movimiento real en Chromium", async () => {
    const checks: string[] = [];
    const options = input({ onCheck: async (check) => { checks.push(check.check); } });
    await expect(verifyGame(options)).resolves.toMatchObject({ status: "passed", failures: [] });
    expect(options.runCommand).toHaveBeenNthCalledWith(1, ["test"]);
    expect(options.runCommand).toHaveBeenNthCalledWith(2, ["run", "lint"]);
    expect(options.runCommand).toHaveBeenNthCalledWith(3, ["run", "build"]);
    expect(options.verifyInteraction).toHaveBeenCalledOnce();
    expect(checks).toContain("browser keyboard interaction");
  });

  it("reintenta una vez la prueba de navegador si el Chromium aislado falla por infraestructura", async () => {
    let attempts = 0;
    const options = input({ verifyInteraction: vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("execution_timeout");
      return passedBrowser;
    }) });
    await expect(verifyGame(options)).resolves.toMatchObject({ status: "passed", failures: [] });
    expect(attempts).toBe(2);
  });

  it("no declara éxito por un health check 200 cuando el navegador no puede mover el juego", async () => {
    const options = input({ verifyInteraction: async () => ({
      status: "failed",
      checks: [{ name: "keyboard interaction", status: "failed", summary: "No produjo movimiento." }],
      consoleErrors: [],
      blockedRequests: 0,
    }) });
    await expect(verifyGame(options)).resolves.toMatchObject({ status: "failed" });
  });

  it("reúne logs acotados y redacta credenciales antes de enviarlos a reparación", async () => {
    const options = input({
      runCommand: async () => ({ stdout: "test failed", stderr: "", exitCode: 1, durationMs: 5, truncated: false }),
      readLogs: async () => ({ stdout: "ghp_" + "A".repeat(36), stderr: "" }),
    });
    const result = await verifyGame(options);
    expect(result.status).toBe("failed");
    expect(result.failures.join(" ")).not.toContain("ghp_");
    expect(result.failures.join(" ")).toContain("[REDACTED]");
  });

  it("falla si solo cambiaron el spec y los assets: el codigo de gameplay sigue siendo la plantilla intacta", async () => {
    const options = input({ listChangedGameplayFiles: async () => [] });
    const result = await verifyGame(options);
    expect(result.status).toBe("failed");
    expect(result.failures.join(" ")).toContain("plantilla");
  });

  it("falla si el project-spec runtime no coincide con el genero pedido (RPG servido como plataformas)", async () => {
    const options = input({
      spec: createGameSpec("Crea un RPG top-down corto con un mapa y un PNJ"),
      readRuntimeSpec: async () => JSON.stringify({ genre: "platformer" }),
    });
    const result = await verifyGame(options);
    expect(result.status).toBe("failed");
    expect(result.failures.join(" ")).toContain("project-spec");
  });

  it("rechaza manifiestos sin test, lint y build", async () => {
    const options = input({ readManifest: async () => JSON.stringify({ scripts: { build: "vite build" } }) });
    const result = await verifyGame(options);
    expect(result.status).toBe("failed");
    expect(result.failures.join(" ")).toContain("npm test");
    expect(result.failures.join(" ")).toContain("npm run lint");
  });
});
