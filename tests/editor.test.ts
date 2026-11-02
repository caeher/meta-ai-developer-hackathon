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
    expect((screen.getByRole("combobox", { name: "Versión del proyecto. Solo Latest está disponible." }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("guarda el prompt en el endpoint privado sin iniciar una ejecución", async () => {
    const message = {
      id: "2f82ba61-ea6b-44bc-b5ec-e4126bbb2d00",
      projectId,
      role: "user",
      content: "Género: plataformas 2D.",
      requestId: "00000000-0000-4000-8000-000000000001",
      sequence: 1,
      createdAt: new Date().toISOString(),
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(message, { status: 201 }));
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    renderEditor();

    fireEvent.change(screen.getByLabelText("Describe tu juego"), { target: { value: "Género: plataformas 2D." } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar mensaje" }));

    await waitFor(() => expect(screen.getByText("Género: plataformas 2D.")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`/api/projects/${projectId}/messages`, expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ requestId: "00000000-0000-4000-8000-000000000001", content: "Género: plataformas 2D." }),
    }));
    expect((await screen.findByRole("status")).textContent).toContain("El agente todavía no ejecuta generación.");
  });

  it("persiste el cambio de nombre con el endpoint de ownership del proyecto", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      id: projectId,
      name: "Nueva aventura",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
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
});
