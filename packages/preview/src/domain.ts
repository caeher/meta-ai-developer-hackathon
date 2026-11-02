const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parsePreviewBaseDomain(value: string | undefined): string | undefined {
  if (!value || value.length > 253 || value !== value.trim()) return undefined;
  const domain = value.toLowerCase();
  if (!domainPattern.test(domain) || domain.endsWith(".localhost") || domain === "localhost") return undefined;
  return domain;
}

export function previewProjectHostname(projectId: string, baseDomain: string): string | undefined {
  if (!uuidPattern.test(projectId) || !domainPattern.test(baseDomain)) return undefined;
  return `${projectId.toLowerCase()}.${baseDomain.toLowerCase()}`;
}
