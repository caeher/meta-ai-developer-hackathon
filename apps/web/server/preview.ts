import "server-only";
import { parsePreviewBaseDomain } from "@meta-game/preview";
import { getPrimaryAppOrigin } from "./auth/config";

export function getPreviewClientConfiguration(): { baseDomain?: string; protocol?: "http:" | "https:" } {
  if (process.env.PREVIEW_GATEWAY_ENABLED !== "true") return {};
  const baseDomain = parsePreviewBaseDomain(process.env.PREVIEW_BASE_DOMAIN);
  if (!baseDomain) return {};
  const appProtocol = new URL(getPrimaryAppOrigin()).protocol;
  const protocol = appProtocol === "http:" && baseDomain.endsWith(".localhost") ? "http:" : "https:";
  return { baseDomain, protocol };
}
