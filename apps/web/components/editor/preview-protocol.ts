const routePathLimit = 2048;
const previewUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const previewDomainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type PreviewRouteMessage = Readonly<{ type: "preview:route"; path: string }>;

export function getPreviewOrigin(projectId: string, baseDomain: string | undefined): string | undefined {
  if (!previewUuidPattern.test(projectId) || !baseDomain || baseDomain.length > 253) return undefined;
  const domain = baseDomain.toLowerCase();
  if (!previewDomainPattern.test(domain) || domain === "localhost") return undefined;
  return `https://${projectId.toLowerCase()}.${domain}`;
}

export function parsePreviewRoutePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > routePathLimit || !value.startsWith("/") ||
    value.startsWith("//") || value.includes("\\") || value.includes("#") || /[\u0000-\u0020\u007f]/.test(value) ||
    /%(?:25|2e|2f|5c)/i.test(value)) return undefined;
  try {
    const rawPath = value.split("?", 1)[0] ?? value;
    const decodedRawPath = decodeURIComponent(rawPath);
    if (decodedRawPath.includes("\\") || decodedRawPath.includes("//") || decodedRawPath.split("/").some((part) => part === "." || part === "..")) return undefined;
    const url = new URL(value, "https://preview.invalid");
    if (url.origin !== "https://preview.invalid" || url.username || url.password || url.pathname === "/__session" || url.pathname.startsWith("/__preview")) return undefined;
    const decodedPath = decodeURIComponent(url.pathname);
    if (decodedPath.includes("\\") || /[\u0000-\u001f\u007f]/.test(decodedPath) || decodedPath.split("/").some((part) => part === "." || part === "..")) return undefined;
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

export function parsePreviewRouteMessage(value: unknown): PreviewRouteMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "preview:route" || Object.keys(candidate).length !== 2) return undefined;
  const path = parsePreviewRoutePath(candidate.path);
  return path ? { type: "preview:route", path } : undefined;
}
