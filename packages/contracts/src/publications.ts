import { z } from "zod";

export const PUBLICATION_MAX_FILES = 1_024;
export const PUBLICATION_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const PUBLICATION_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export const PublicationFileSchema = z.object({
  path: z.string().min(1).max(512).regex(/^[A-Za-z0-9._/-]+$/).refine((value) =>
    !value.startsWith("/") && !value.includes("\\") && value.split("/").every((segment) =>
      segment !== "" && segment !== "." && segment !== ".." && !segment.startsWith(".")),
  "Ruta de publicación inválida"),
  contentType: z.enum([
    "text/html; charset=utf-8",
    "text/javascript; charset=utf-8",
    "text/css; charset=utf-8",
    "application/json; charset=utf-8",
    "image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "image/x-icon",
    "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "video/mp4", "video/webm",
    "font/woff", "font/woff2", "font/ttf", "font/otf", "application/wasm",
  ]),
  bytes: z.number().int().positive().max(PUBLICATION_MAX_FILE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  key: z.string().min(1).max(1_024),
}).strict();

export const PublicationManifestSchema = z.object({
  schemaVersion: z.literal(1),
  files: z.array(PublicationFileSchema).min(1).max(PUBLICATION_MAX_FILES),
  totalBytes: z.number().int().positive().max(PUBLICATION_MAX_TOTAL_BYTES),
  indexSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((manifest, context) => {
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const [index, file] of manifest.files.entries()) {
    if (paths.has(file.path)) context.addIssue({ code: "custom", path: ["files", index, "path"], message: "Las rutas publicadas deben ser únicas" });
    paths.add(file.path);
    if (/\.map$/i.test(file.path) || /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|secrets?[^/]*|credentials?[^/]*)$/i.test(file.path)) {
      context.addIssue({ code: "custom", path: ["files", index, "path"], message: "El artefacto contiene un archivo privado" });
    }
    totalBytes += file.bytes;
  }
  if (!paths.has("index.html")) context.addIssue({ code: "custom", path: ["files"], message: "El artefacto requiere index.html" });
  if (totalBytes !== manifest.totalBytes) context.addIssue({ code: "custom", path: ["totalBytes"], message: "El tamaño total no coincide" });
});

export type PublicationFile = z.infer<typeof PublicationFileSchema>;
export type PublicationManifest = z.infer<typeof PublicationManifestSchema>;

export function canonicalPublicationManifest(manifest: PublicationManifest): string {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    files: manifest.files.map((file) => ({
      path: file.path,
      contentType: file.contentType,
      bytes: file.bytes,
      sha256: file.sha256,
      key: file.key,
    })),
    totalBytes: manifest.totalBytes,
    indexSha256: manifest.indexSha256,
  });
}

const slugSchema = z.string().regex(/^[a-f0-9]{20}$/);

export function publicationArtifactKey(slug: string, path: string): string {
  return `published/${slugSchema.parse(slug)}/${PublicationFileSchema.shape.path.parse(path)}`;
}

export function publicationUrl(slug: string, configuredDomain: string): string {
  const parsedSlug = slugSchema.parse(slug);
  const domain = configuredDomain.trim().toLowerCase();
  if (domain.length > 253 || domain.includes(":") || domain.includes("/") || domain.includes("\\") ||
    domain.startsWith(".") || domain.endsWith(".") || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new TypeError("PUBLISH_BASE_DOMAIN debe ser un dominio DNS sin esquema ni ruta");
  }
  return `https://${parsedSlug}.${domain}`;
}
