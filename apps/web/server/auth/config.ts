import "server-only";
import { hasClerkCredentials, parseAuthorizedParties } from "./config-core";

export function getClerkConfiguration() {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const secretKey = process.env.CLERK_SECRET_KEY;
  const configured = hasClerkCredentials({ publishableKey, secretKey });

  return {
    configured,
    authorizedParties: configured
      ? parseAuthorizedParties(
          process.env.CLERK_AUTHORIZED_PARTIES,
          process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL,
        )
      : [],
  };
}

export function isClerkConfigured(): boolean {
  return getClerkConfiguration().configured;
}
