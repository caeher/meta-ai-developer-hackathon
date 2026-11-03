/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import type { ReactNode } from "react";
import { EditorProgressSchema } from "@meta-game/contracts";
import { EditorShell } from "../apps/web/components/editor/EditorShell";
import { appendPromptText, MAX_PROMPT_LENGTH } from "../apps/web/components/editor/prompt";

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

describe("contratos del editor", () => {
  it("acepta estados de ejecución, pasos, archivos y verificación", () => {
    const parsed = EditorProgressSchema.parse({
      status: "verifying",
      plan: ["Crear una escena inicial"],
      steps: [{ id: "scene", title: "Crear la escena", status: "succeeded" }],
      changedFiles: ["src/main.ts"],
      verification: { status: "running", summary: "Comprobando el proyecto." },
    });

    expect(parsed.steps[0]?.status).toBe("succeeded");
    expect(EditorProgressSchema.safeParse({ ...parsed, status: "invented" }).success).toBe(false);
  });

  it("añade opciones al borrador sin superar el máximo del mensaje", () => {
    expect(appendPromptText("Mi idea", "Género: puzzle.")).toBe("Mi idea\nGénero: puzzle.");
    expect(appendPromptText("", "Pixel art.")).toBe("Pixel art.");
    expect(appendPromptText("a".repeat(MAX_PROMPT_LENGTH), "extra")).toHaveLength(MAX_PROMPT_LENGTH);
  });
});

describe("editor interactivo", () => {
  const projectId = "9fe9e0e0-0b85-4eb8-bd69-7f16c7569f28";

  function renderEditor() {
    return render(
      createElement(EditorShell, {
        projectId,
        projectName: "Aventura de prueba",
        initialMessages: [],
        initialCursor: null,
      }),
      { wrapper: ({ children }) => createElement(Theme, { appearance: "dark", accentColor: "blue", grayColor: "slate", hasBackground: false }, children) },
    );
  }

  it("inserta preferencias editables y mantiene vacía la preview", async () => {
    renderEditor();

    await waitFor(() => expect((screen.getByRole("button", { name: "Opciones rápidas" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Opciones rápidas" }));
    expect(screen.getByRole("button", { name: "Insertar: Plataformas 2D" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Insertar: Shooter 2D" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Insertar: Puzzle" })).not.toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Insertar: RPG top-down" }));

    expect((screen.getByLabelText("Describe tu juego") as HTMLTextAreaElement).value).toBe("Género: RPG top-down.");
    expect(screen.getByRole("heading", { name: "Arte y controles" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Insertar: Sprites" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Insertar: Fondos" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Insertar: Niveles" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Insertar: Enemigos" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Insertar: Música" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Insertar: Gamepad" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const preview = screen.getByRole("region", { name: "Vista previa privada del juego" });
    expect(preview.querySelector("iframe")).toBeNull();
    expect(preview.querySelector('a[target="_blank"]')).toBeNull();
    expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Share" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Volver en la vista previa" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Avanzar en la vista previa" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Recargar vista previa" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Abrir vista previa en otra pestaña" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: "Versión de la vista previa" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("guarda el prompt y encola una ejecución idempotente sin casilla de consentimiento", async () => {
    const message = {
      id: "2f82ba61-ea6b-44bc-b5ec-e4126bbb2d00",
      projectId,
      role: "user",
      content: "Género: plataformas 2D.",
      requestId: "00000000-0000-4000-8000-000000000001",
      sequence: 1,
      createdAt: new Date().toISOString(),
    };
    const runId = "00000000-0000-4000-8000-000000000002";
    const run = {
      id: runId,
      projectId,
      status: "queued",
      errorCode: null,
      cancelRequested: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const finished = {
      version: 1,
      runId,
      sequence: 1,
      createdAt: new Date().toISOString(),
      type: "run.finished",
      payload: { summary: "El prototipo quedó verificado." },
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `/api/projects/${projectId}/runs` && !init?.method) return Response.json({ run: null, enabled: true });
      if (url === `/api/projects/${projectId}/messages`) return Response.json(message, { status: 201 });
      if (url === `/api/projects/${projectId}/runs` && init?.method === "POST") return Response.json({ run, duplicate: false }, { status: 202 });
      if (url === `/api/runs/${runId}/events`) {
        return new Response(`id: 1\nevent: run.finished\ndata: ${JSON.stringify(finished)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    renderEditor();

    fireEvent.change(screen.getByLabelText("Describe tu juego"), { target: { value: "Género: plataformas 2D." } });
    await screen.findByRole("button", { name: "Enviar al agente" });
    const submit = screen.getByRole("button", { name: "Enviar al agente" }) as HTMLButtonElement;
    expect(screen.queryByRole("checkbox", { name: /Confirmo que tengo 18/ })).toBeNull();
    expect(screen.getByText(/No incluir datos personales/)).not.toBeNull();
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    await waitFor(() => expect(screen.getByText("Género: plataformas 2D.")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/messages`, expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ requestId: "00000000-0000-4000-8000-000000000001", content: "Género: plataformas 2D." }),
    }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/runs`, expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "00000000-0000-4000-8000-000000000001", messageRequestId: message.requestId }),
    })));
    expect(await screen.findByText("El prototipo quedó verificado.")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Mensaje guardado y ejecución en cola.");
  });

  it("persiste el cambio de nombre con el endpoint de ownership del proyecto", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === `/api/projects/${projectId}/runs`) return Response.json({ run: null, enabled: true });
      return Response.json({
        id: projectId,
        name: "Nueva aventura",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "Editar nombre de Aventura de prueba" }));
    fireEvent.change(await screen.findByLabelText("Nombre del proyecto"), { target: { value: "Nueva aventura" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar nombre" }));

    expect(await screen.findByRole("heading", { name: "Nueva aventura" })).not.toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledWith(`/api/projects/${projectId}`, expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ name: "Nueva aventura" }),
    }));
  });

  it("chat agentico: muestra pestanas Issues/Agentes/Actividad y el flujo por fases", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/runs")) return Response.json({ run: null, enabled: true });
      throw new Error("unexpected");
    });
    render(
      createElement(EditorShell, {
        projectId, projectName: "Aventura agentica", initialMessages: [], initialCursor: null,
        progress: {
          status: "running", plan: [], steps: [], changedFiles: [],
          issues: [{ id: "01-hero", title: "Heroe", path: "docs/issues/sprites/01-hero.md", kind: "sprites", status: "running", dependsOn: [] }],
          subagents: [{ issueId: "01-hero", title: "Heroe", status: "running", kind: "sprites", phase: "sprites", summary: "Creando atlas" }],
          phases: [{ phase: "inventory", status: "completed", summary: "Comparado" }, { phase: "sprites", status: "running", summary: "Atlas en curso" }],
          toolCalls: [{ callId: "c1", toolName: "pack_spritesheet", title: "Empaquetar atlas", status: "running", phase: "sprites", issueId: "01-hero" }],
          assetCards: [], verification: { status: "pending" },
        },
      }),
      { wrapper: ({ children }) => createElement(Theme, { appearance: "dark", accentColor: "blue", grayColor: "slate", hasBackground: false }, children) },
    );
    expect(screen.getByRole("tab", { name: /^Issues/ })).not.toBeNull();
    expect(screen.getByRole("tab", { name: /^Agentes/ })).not.toBeNull();
    expect(screen.getByRole("tab", { name: /^Actividad/ })).not.toBeNull();
    // Timeline visible dentro del chat: fases + tool call + sub-agente
    expect(screen.getByText("Flujo agentico")).not.toBeNull();
    expect(screen.getByText(/pack_spritesheet/)).not.toBeNull();
    expect(await screen.findByText(/Empaquetar atlas/)).not.toBeNull();
    expect(screen.getByText(/Creando atlas/)).not.toBeNull();
  });
});
