const publishableKeyPattern = /^pk_(test|live)_[A-Za-z0-9_+/=-]{20,}$/;
const secretKeyPattern = /^sk_(test|live)_[A-Za-z0-9_+/=-]{20,}$/;

export interface ClerkKeyConfiguration {
  publishableKey: string | undefined;
  secretKey: string | undefined;
}

export function hasClerkCredentials(configuration: ClerkKeyConfiguration): boolean {
  const publishableKey = configuration.publishableKey;
  const secretKey = configuration.secretKey;
  if (
    !publishableKey ||
    !secretKey ||
    publishableKey.toLowerCase().includes("placeholder") ||
    secretKey.toLowerCase().includes("placeholder") ||
    publishableKey.trim() !== publishableKey ||
    secretKey.trim() !== secretKey
  ) {
    return false;
  }

  const publishableMode = publishableKey.match(publishableKeyPattern)?.[1];
  const secretMode = secretKey.match(secretKeyPattern)?.[1];
  return publishableMode !== undefined && publishableMode === secretMode;
}

export function parseAuthorizedParties(raw: string | undefined, appOrigin: string | undefined): string[] {
  const configured = raw?.split(",").map((party) => party.trim()).filter(Boolean);
  const values = configured?.length ? configured : appOrigin ? [appOrigin] : [];
  const parties = new Set<string>();

  for (const value of values) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("CLERK_AUTHORIZED_PARTIES debe contener orígenes válidos.");
    }

    const isLocalHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (
      (parsed.protocol !== "https:" && !isLocalHttp) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("CLERK_AUTHORIZED_PARTIES debe contener solo orígenes HTTPS (HTTP solo en loopback).");
    }

    parties.add(parsed.origin);
  }

  if (parties.size === 0) {
    throw new Error("Configura APP_ORIGIN o CLERK_AUTHORIZED_PARTIES para habilitar autenticación.");
  }

  return [...parties];
}

export function isProtectedPath(pathname: string): boolean {
  if (
    pathname === "/" ||
    pathname === "/api/health" ||
    pathname === "/sign-in" ||
    pathname.startsWith("/sign-in/") ||
    pathname === "/sign-up" ||
    pathname.startsWith("/sign-up/")
  ) {
    return false;
  }
  return true;
}
