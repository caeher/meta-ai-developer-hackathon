import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalPublicationManifest, PublicationManifestSchema } from "@meta-game/contracts";
import { createPublicationArtifactStorage, type PublicationObjectClient } from "@meta-game/storage";

function digest(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

describe("serialización de manifiesto público", () => {
  it("calcula el hash sin depender del orden de claves de JSONB", () => {
    const first = PublicationManifestSchema.parse({
      schemaVersion: 1,
      files: [{ path: "index.html", contentType: "text/html; charset=utf-8", bytes: 1, sha256: "a".repeat(64), key: "published/" + slug + "/index.html" }],
      totalBytes: 1,
      indexSha256: "a".repeat(64),
    });
    const reordered = PublicationManifestSchema.parse({
      indexSha256: "a".repeat(64),
      totalBytes: 1,
      files: [{ key: "published/" + slug + "/index.html", sha256: "a".repeat(64), bytes: 1, contentType: "text/html; charset=utf-8", path: "index.html" }],
      schemaVersion: 1,
    });
    expect(canonicalPublicationManifest(reordered)).toBe(canonicalPublicationManifest(first));
  });
});

function makeClient() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string; sha256: string }>();
  const client: PublicationObjectClient = {
    async put(key, body, contentType, sha256) {
      if (objects.has(key)) throw new Error("already exists");
      objects.set(key, { bytes: Uint8Array.from(body), contentType, sha256 });
    },
    async head(key) {
      const item = objects.get(key);
      return item ? { sizeBytes: item.bytes.byteLength, sha256: item.sha256 } : {};
    },
    async get(key) {
      const item = objects.get(key);
      if (!item) throw new Error("missing");
      return Uint8Array.from(item.bytes);
    },
    async deletePrefix(prefix) {
      for (const key of objects.keys()) if (key.startsWith(`${prefix}/`)) objects.delete(key);
    },
  };
  return { objects, storage: createPublicationArtifactStorage(client) };
}

const slug = "a1b2c3d4e5f607182930";

describe("publicación de artefactos estáticos", () => {
  it("escribe una build inmutable, comprueba hashes y solo lee archivos del manifiesto", async () => {
    const harness = makeClient();
    const html = Buffer.from("<!doctype html><html><script type=module src='./assets/game.js'></script></html>");
    const js = Buffer.from("globalThis.gameReady = true;");
    const written = await harness.storage.write(slug, [
      { path: "index.html", contentType: "text/html; charset=utf-8", body: html },
      { path: "assets/game.js", contentType: "text/javascript; charset=utf-8", body: js },
    ]);
    expect(written.manifest.totalBytes).toBe(html.byteLength + js.byteLength);
    expect(written.manifest.indexSha256).toBe(digest(html));
    expect(written.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await harness.storage.read(slug, written.manifest.files.find((file) => file.path === "index.html")!)).toEqual(Uint8Array.from(html));
    await expect(harness.storage.read("b1b2c3d4e5f607182930", written.manifest.files[0]!)).rejects.toThrow();
    await harness.storage.delete(slug);
    expect(harness.objects.size).toBe(0);
  });

  it("rechaza rutas, fuentes, manifiestos incompletos y límites que podrían exponer archivos privados", async () => {
    const harness = makeClient();
    await expect(harness.storage.write(slug, [
      { path: "../index.html", contentType: "text/html; charset=utf-8", body: Buffer.from("<html></html>") },
    ])).rejects.toThrow();
    await expect(harness.storage.write(slug, [
      { path: "index.html", contentType: "text/html; charset=utf-8", body: Buffer.from("<html></html>") },
      { path: "src/game.ts.map", contentType: "application/json; charset=utf-8", body: Buffer.from("{}") },
    ])).rejects.toThrow();
    await expect(harness.storage.write(slug, [
      { path: "assets/private.env", contentType: "text/javascript; charset=utf-8", body: Buffer.from("x") },
    ])).rejects.toThrow();
  });

  it("no sustituye silenciosamente objetos inmutables distintos en un reintento", async () => {
    const harness = makeClient();
    const file = { path: "index.html", contentType: "text/html; charset=utf-8", body: Buffer.from("<html>one</html>") };
    await harness.storage.write(slug, [file]);
    await expect(harness.storage.write(slug, [{ ...file, body: Buffer.from("<html>two</html>") }])).rejects.toThrow("inmutable");
  });
});
