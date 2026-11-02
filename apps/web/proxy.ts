import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { getClerkConfiguration } from "./server/auth/config";
import { isProtectedPath } from "./server/auth/config-core";

const clerkConfiguration = getClerkConfiguration();

const handleClerk = clerkMiddleware(
  async (auth, request) => {
    if (!isProtectedPath(request.nextUrl.pathname)) return;

    if (request.nextUrl.pathname.startsWith("/api/")) {
      const session = await auth();
      if (!session.userId) {
        return Response.json(
          { error: "unauthenticated" },
          {
            status: 401,
            headers: {
              "cache-control": "private, no-store",
              "referrer-policy": "no-referrer",
              "x-content-type-options": "nosniff",
            },
          },
        );
      }
      return;
    }

    await auth.protect();
  },
  { authorizedParties: clerkConfiguration.authorizedParties },
);

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (!clerkConfiguration.configured) {
    if (isProtectedPath(request.nextUrl.pathname)) {
      if (request.nextUrl.pathname.startsWith("/api/")) {
        return Response.json(
          { error: "authentication_not_configured" },
          {
            status: 503,
            headers: {
              "cache-control": "private, no-store",
              "referrer-policy": "no-referrer",
              "x-content-type-options": "nosniff",
            },
          },
        );
      }
      return NextResponse.redirect(new URL("/sign-in?setup=required", request.url));
    }
    return NextResponse.next();
  }

  return handleClerk(request, event);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
