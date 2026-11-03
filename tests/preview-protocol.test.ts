import { describe, expect, it } from "vitest";
import { getPreviewOrigin, parsePreviewRouteMessage, parsePreviewRoutePath } from "../apps/web/components/editor/preview-protocol";

const projectId = "9fe9e0e0-0b85-4eb8-bd69-7f16c7569f28";

describe("protocolo de navegación de preview", () => {
  it("deriva únicamente el origen HTTPS del proyecto y un dominio validado", () => {
    expect(getPreviewOrigin(projectId, "preview.example.test")).toBe(`https://${projectId}.preview.example.test`);
    expect(getPreviewOrigin("../../attacker", "preview.example.test")).toBeUndefined();
    expect(getPreviewOrigin(projectId, "preview.example.test/path")).toBeUndefined();
    expect(getPreviewOrigin(projectId, "localhost")).toBeUndefined();
    expect(getPreviewOrigin(projectId, "preview.localhost")).toBe(`https://${projectId}.preview.localhost`);
  });

  it("acepta rutas locales y rechaza destinos o rutas fuera del origen de preview", () => {
    expect(parsePreviewRoutePath("/level/2?checkpoint=3")).toBe("/level/2?checkpoint=3");
    for (const path of ["https://attacker.example/", "//attacker.example/", "/../app", "/%2e%2e/app", "/__session", "/__preview/file", "/x\\..\\y", "/x#token", "/bad\npath"]) {
      expect(parsePreviewRoutePath(path), path).toBeUndefined();
    }
  });

  it("acepta solo mensajes route con esquema exacto y ruta válida", () => {
    expect(parsePreviewRouteMessage({ type: "preview:route", path: "/level/2" })).toEqual({ type: "preview:route", path: "/level/2" });
    expect(parsePreviewRouteMessage({ type: "preview:route", path: "https://attacker.example/" })).toBeUndefined();
    expect(parsePreviewRouteMessage({ type: "preview:route", path: "/", url: "https://attacker.example/" })).toBeUndefined();
    expect(parsePreviewRouteMessage({ type: "preview:navigate-app", path: "/projects" })).toBeUndefined();
    expect(parsePreviewRouteMessage(null)).toBeUndefined();
  });
});
