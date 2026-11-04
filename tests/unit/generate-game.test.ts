import { describe, expect, it, vi } from "vitest";
import { createGameSpec, captureGameCheckpoint, decodeGameCheckpoint, restoreGameCheckpoint } from "../../apps/worker/src/pipelines/generate-game";
import type { AgentSandbox } from "../../apps/worker/src/agent/tools";

describe("GameSpec y checkpoint de generación", () => {
  it.each([
    ["Crea un juego de plataformas", "platformer"],
    ["Crea un Boulder Dash con excavación, gemas y rocas que caen", "puzzle"],
    ["Crea un puzzle de lógica", "puzzle"],
    ["Crea un shooter espacial", "shooter"],
    ["Crea un RPG top-down", "rpg"],
  ] as const)("normaliza el género del prompt: %s", (prompt, genre) => {
    const spec = createGameSpec(prompt);
    expect(spec).toMatchObject({ genre, intent: "create", controls: { touch: true } });
  });

  it("conserva el género del proyecto al pedir una edición incremental", () => {
    const prior = createGameSpec("Crea un shooter espacial");
    expect(createGameSpec("Agrega un enemigo nuevo", prior)).toMatchObject({
      genre: "shooter",
      intent: "edit",
      changes: ["enemy"],
    });
  });

  it("valida los controles pedidos y descarta una especificación previa manipulada", () => {
    const prior = createGameSpec("Crea un RPG top-down");
    expect(createGameSpec("Cambia el movimiento a WASD y acción con E", prior).controls)
      .toEqual({ movement: "wasd", action: "e", touch: true });
    expect(createGameSpec("Crea un juego", { genre: "host", controls: {} }).genre).toBe("platformer");
  });

  it("captura archivos de texto y valida checksum y rutas antes de restaurar", async () => {
    let currentContent = "export const oldGame = true;";
    const sandbox = {
      listFiles: vi.fn(async (_projectId: string, path: string) => path === ""
        ? { path, files: [{ name: "src", type: "directory" as const, size: 0 }, { name: ".env.local", type: "file" as const, size: 28 }, { name: "sprite.png", type: "file" as const, size: 8 }] }
        : { path, files: [{ name: "main.ts", type: "file" as const, size: 19 }] }),
      readFile: vi.fn(async (_projectId: string, path: string) => ({ path, content: currentContent })),
      writeFile: vi.fn(async (_projectId: string, path: string, content: string) => {
        currentContent = content;
        return { path, bytesWritten: Buffer.byteLength(content, "utf8") };
      }),
    } as unknown as AgentSandbox;
    const snapshot = await captureGameCheckpoint(sandbox, "project", new AbortController().signal);
    const manifest = decodeGameCheckpoint(snapshot.body);
    expect(manifest.files.map(({ path }) => path)).toEqual(["src/main.ts"]);
    expect(sandbox.readFile).not.toHaveBeenCalledWith("project", ".env.local", expect.any(AbortSignal));
    currentContent = "export const brokenGame = false;";
    await restoreGameCheckpoint(sandbox, "project", manifest, new AbortController().signal);
    expect(currentContent).toBe("export const oldGame = true;");
    expect(sandbox.writeFile).toHaveBeenCalledOnce();
  });

  it("omite package-lock.json y SVG al capturar para no bloquear por falsos positivos", async () => {
    const contents: Record<string, string> = {
      "package-lock.json": "{\"lockfileVersion\":3,\"packages\":{\"\":{\"version\":\"1.2.3-456.789.0123\"}}}",
      "public/logo.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M10 20.5-3.25 40.75 50-60.125\"/></svg>",
      "src/main.ts": "export const game = true;",
    };
    const sandbox = {
      listFiles: vi.fn(async (_projectId: string, path: string) => path === ""
        ? { path, files: [{ name: "package-lock.json", type: "file" as const, size: 80 }, { name: "public", type: "directory" as const, size: 0 }, { name: "src", type: "directory" as const, size: 0 }] }
        : path === "public"
          ? { path, files: [{ name: "logo.svg", type: "file" as const, size: 90 }] }
          : { path, files: [{ name: "main.ts", type: "file" as const, size: 25 }] }),
      readFile: vi.fn(async (_projectId: string, path: string) => ({ path, content: contents[path] ?? "" })),
      writeFile: vi.fn(async () => ({ path: "", bytesWritten: 0 })),
    } as unknown as AgentSandbox;

    const snapshot = await captureGameCheckpoint(sandbox, "project", new AbortController().signal);
    const manifest = decodeGameCheckpoint(snapshot.body);

    expect(manifest.files.map(({ path }) => path)).toEqual(["src/main.ts"]);
  });
});
