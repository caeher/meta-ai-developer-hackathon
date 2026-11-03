/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import nextConfig from "../apps/web/next.config";
import { AuthForm } from "../apps/web/components/auth/AuthForm";

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sign-in no debe filtrar credenciales a la URL", () => {
  it("permite los origenes locales de desarrollo para que el cliente hidrate", () => {
    const origins = (nextConfig as { allowedDevOrigins?: string[] }).allowedDevOrigins ?? [];
    expect(origins).toContain("127.0.0.1");
    expect(origins).toContain("localhost");
    expect(origins).toContain("app.localhost");
  });

  it("el formulario nunca usa GET: sin JS la password no viaja en el query string", () => {
    render(createElement(Theme, null, createElement(AuthForm, { mode: "login" })));
    const form = document.querySelector("form");
    expect(form).not.toBeNull();
    expect(form!.method).toBe("post");
  });

  it("al enviar hace POST a /api/auth/login y no una navegacion GET", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(Theme, null, createElement(AuthForm, { mode: "login" })));
    fireEvent.change(screen.getByLabelText(/Correo/), { target: { value: "persona@example.test" } });
    fireEvent.change(screen.getByLabelText(/Contraseña/), { target: { value: "una-clave-secreta" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ email: "persona@example.test", password: "una-clave-secreta" });
    expect(window.location.search).toBe("");
  });
});
