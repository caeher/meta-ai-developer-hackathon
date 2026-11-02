export interface PreviewGrant {
  grant: string;
  grantExpiresAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function grantError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  const code = typeof payload?.error === "string" ? payload.error : "";
  if (code === "preview_not_configured") return "La preview privada no está habilitada en este entorno.";
  if (code === "unauthenticated") return "Vuelve a iniciar sesión para abrir la preview.";
  if (code === "not_found") return "El proyecto ya no está disponible.";
  if (code === "preview_unavailable") return "El sandbox no está listo o la sesión de preview fue revocada.";
  if (code === "rate_limited") return "Espera un momento antes de solicitar otra sesión de preview.";
  if (code === "origin_not_allowed") return "No se pudo verificar el origen de la solicitud.";
  return "No se pudo obtener una sesión privada de preview.";
}

export async function requestPreviewGrant(
  projectId: string,
  expectedPreviewOrigin: string,
  signal?: AbortSignal,
): Promise<PreviewGrant> {
  const response = await fetch(`/api/projects/${projectId}/preview-grant`, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal,
  });
  if (!response.ok) throw new Error(await grantError(response));
  const value: unknown = await response.json();
  const grantPattern = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}$/;
  if (!isRecord(value) || typeof value.grant !== "string" || value.grant.length > 8192 || !grantPattern.test(value.grant) ||
    typeof value.previewUrl !== "string" || typeof value.expiresAt !== "string") {
    throw new Error("El servidor devolvió una respuesta de preview inválida.");
  }
  let previewUrl: URL;
  try { previewUrl = new URL(value.previewUrl); }
  catch { throw new Error("El servidor devolvió un destino de preview inválido."); }
  if (previewUrl.origin !== expectedPreviewOrigin || previewUrl.pathname !== "/" || previewUrl.search || previewUrl.hash ||
    previewUrl.username || previewUrl.password) {
    throw new Error("El destino de preview no coincide con el proyecto.");
  }
  const grantExpiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(grantExpiresAt) || grantExpiresAt <= Date.now()) throw new Error("El grant de preview ya venció.");
  return { grant: value.grant, grantExpiresAt };
}
