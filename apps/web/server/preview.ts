import "server-only";
import { parsePreviewBaseDomain } from "@meta-game/preview";

export function getPreviewClientConfiguration(): { baseDomain?: string } {
  if (process.env.PREVIEW_GATEWAY_ENABLED !== "true") return {};
  const baseDomain = parsePreviewBaseDomain(process.env.PREVIEW_BASE_DOMAIN);
  return baseDomain ? { baseDomain } : {};
}
