import { createPublicKey, createPrivateKey, sign, verify, type KeyObject } from "node:crypto";
import { PreviewGrantClaimsSchema, type PreviewGrantClaims } from "@meta-game/contracts";

export type PreviewKeyRing = Readonly<{
  activeKeyId: string;
  privateKey: KeyObject;
  publicKeys: ReadonlyMap<string, KeyObject>;
}>;
export type PreviewVerifierKeyRing = Readonly<{ publicKeys: ReadonlyMap<string, KeyObject> }>;

export class PreviewTokenError extends Error {
  constructor() {
    super("preview_token_invalid");
    this.name = "PreviewTokenError";
  }
}

function decodeBase64Key(value: string): Buffer {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(value) || value.length > 16_384) throw new PreviewTokenError();
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length < 64 || bytes.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    throw new PreviewTokenError();
  }
  return bytes;
}

export function loadPreviewKeyRing(
  activeKeyId: string | undefined,
  privateKeyBase64: string | undefined,
  publicKeysJson: string | undefined,
): PreviewKeyRing | undefined {
  if (!activeKeyId || !privateKeyBase64 || !publicKeysJson || activeKeyId.startsWith("replace")) return undefined;
  try {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(activeKeyId)) return undefined;
    const privateKey = createPrivateKey({ key: decodeBase64Key(privateKeyBase64), format: "der", type: "pkcs8" });
    const privateBits = privateKey.asymmetricKeyDetails?.modulusLength ?? 0;
    if (privateKey.asymmetricKeyType !== "rsa" || privateBits < 2048 || privateBits > 4096) return undefined;
    const publicKeys = parsePublicKeys(publicKeysJson);
    if (!publicKeys) return undefined;
    if (!publicKeys.has(activeKeyId)) return undefined;
    const expected = createPublicKey(privateKey).export({ format: "der", type: "spki" });
    const active = publicKeys.get(activeKeyId)?.export({ format: "der", type: "spki" });
    if (!active || !expected.equals(active)) return undefined;
    return { activeKeyId, privateKey, publicKeys };
  } catch {
    return undefined;
  }
}

function parsePublicKeys(publicKeysJson: string): Map<string, KeyObject> | undefined {
  try {
    if (publicKeysJson.length > 100_000) return undefined;
    const rawKeys: unknown = JSON.parse(publicKeysJson);
    if (!rawKeys || typeof rawKeys !== "object" || Array.isArray(rawKeys)) return undefined;
    if (Object.keys(rawKeys).length > 16) return undefined;
    const publicKeys = new Map<string, KeyObject>();
    for (const [keyId, encoded] of Object.entries(rawKeys)) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || typeof encoded !== "string") return undefined;
      const publicKey = createPublicKey({ key: decodeBase64Key(encoded), format: "der", type: "spki" });
      const publicBits = publicKey.asymmetricKeyDetails?.modulusLength ?? 0;
      if (publicKey.asymmetricKeyType !== "rsa" || publicBits < 2048 || publicBits > 4096) return undefined;
      publicKeys.set(keyId, publicKey);
    }
    return publicKeys.size > 0 ? publicKeys : undefined;
  } catch { return undefined; }
}

export function loadPreviewVerifierKeyRing(publicKeysJson: string | undefined): PreviewVerifierKeyRing | undefined {
  if (!publicKeysJson || publicKeysJson.startsWith("replace")) return undefined;
  const publicKeys = parsePublicKeys(publicKeysJson);
  return publicKeys ? { publicKeys } : undefined;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function signPreviewGrant(claims: PreviewGrantClaims, keyRing: PreviewKeyRing): string {
  const parsed = PreviewGrantClaimsSchema.parse(claims);
  const header = encode({ alg: "RS256", typ: "JWT", kid: keyRing.activeKeyId });
  const payload = encode(parsed);
  const input = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(input), keyRing.privateKey).toString("base64url");
  return `${input}.${signature}`;
}

export function verifyPreviewGrant(
  token: string,
  keyRing: Pick<PreviewKeyRing, "publicKeys">,
  nowSeconds = Math.floor(Date.now() / 1000),
): PreviewGrantClaims {
  try {
    if (token.length > 8192) throw new PreviewTokenError();
    const parts = token.split(".");
    if (parts.length !== 3) throw new PreviewTokenError();
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (!encodedHeader || !encodedPayload || !encodedSignature) throw new PreviewTokenError();
    const header: unknown = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    if (!header || typeof header !== "object" || Array.isArray(header)) throw new PreviewTokenError();
    const values = header as Record<string, unknown>;
    if (values.alg !== "RS256" || values.typ !== "JWT" || typeof values.kid !== "string") throw new PreviewTokenError();
    const publicKey = keyRing.publicKeys.get(values.kid);
    if (!publicKey) throw new PreviewTokenError();
    const input = `${encodedHeader}.${encodedPayload}`;
    if (!verify("RSA-SHA256", Buffer.from(input), publicKey, Buffer.from(encodedSignature, "base64url"))) throw new PreviewTokenError();
    const claims = PreviewGrantClaimsSchema.parse(JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")));
    if (claims.exp <= nowSeconds || claims.iat > nowSeconds + 30 || claims.exp - claims.iat > 60) throw new PreviewTokenError();
    return claims;
  } catch {
    throw new PreviewTokenError();
  }
}
