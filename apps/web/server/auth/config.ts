import "server-only";

function validOrigin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error("AUTH_ALLOWED_ORIGINS debe contener orígenes válidos"); }
  const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if ((!localHttp && parsed.protocol !== "https:") || parsed.origin !== value || parsed.username || parsed.password) {
    throw new Error("AUTH_ALLOWED_ORIGINS solo acepta orígenes HTTPS (HTTP en loopback)");
  }
  return parsed.origin;
}

export function getAllowedOrigins(source: NodeJS.ProcessEnv = process.env): string[] {
  const configured = source.AUTH_ALLOWED_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean);
  const values = configured?.length
    ? configured
    : [source.APP_ORIGIN ?? source.NEXT_PUBLIC_APP_URL ?? (source.NODE_ENV === "production" ? "" : "http://localhost:3000")];
  const origins = [...new Set(values.filter(Boolean).map(validOrigin))];
  if (!origins.length) throw new Error("Configura APP_ORIGIN o AUTH_ALLOWED_ORIGINS para habilitar la autenticación");
  return origins;
}

export function getPrimaryAppOrigin(source: NodeJS.ProcessEnv = process.env): string {
  return getAllowedOrigins(source)[0]!;
}
