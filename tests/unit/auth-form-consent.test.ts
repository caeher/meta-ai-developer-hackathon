/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { AuthForm } from "../../apps/web/components/auth/AuthForm";

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderForm(mode: "login" | "register") {
  return render(createElement(Theme, null, createElement(AuthForm, { mode })));
}

function fillRegister() {
  fireEvent.change(screen.getByLabelText(/Correo/), { target: { value: "persona@example.test" } });
  fireEvent.change(screen.getByLabelText(/^Contrase\xf1a/), { target: { value: "una-clave-muy-segura" } });
  fireEvent.change(screen.getByLabelText(/Confirmar/), { target: { value: "una-clave-muy-segura" } });
}

describe("consentimiento Contributor en el registro", () => {
  it("bloquea el envio sin marcar y no llama a fetch", () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 202, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    renderForm("register");
    fillRegister();
    const checkbox = screen.getByRole("checkbox", { name: /Confirmo que tengo 18/ });
    expect(checkbox).not.toBeNull();
    const submit = screen.getByRole("button", { name: "Enviar verificaci\xf3n" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("al marcar envia contributorConsent:true en el body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 202, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    renderForm("register");
    fillRegister();
    fireEvent.click(screen.getByRole("checkbox", { name: /Confirmo que tengo 18/ }));
    const submit = screen.getByRole("button", { name: "Enviar verificaci\xf3n" });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/register");
    expect(JSON.parse(String(init.body))).toEqual({
      email: "persona@example.test",
      password: "una-clave-muy-segura",
      contributorConsent: true,
    });
  });

  it("el inicio de sesion no muestra la casilla", () => {
    renderForm("login");
    expect(screen.queryByRole("checkbox", { name: /Confirmo que tengo 18/ })).toBeNull();
  });
});
