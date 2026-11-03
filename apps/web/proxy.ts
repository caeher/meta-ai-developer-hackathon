import { NextResponse, type NextRequest } from "next/server";

// proxy is UX-only: presence of forja_session never authenticates.
// Real auth happens in requirePageUser (pages) and session/ownership checks (APIs).
const publicPaths = new Set(["/", "/sign-in", "/sign-up", "/forgot-password", "/reset-password", "/verify-email"]);

function isProtectedPath(pathname: string): boolean {
  return !publicPaths.has(pathname) &&
    !pathname.startsWith("/api/auth/") &&
    !pathname.startsWith("/api/health") &&
    pathname !== "/api/metrics";
}

export default function proxy(request: NextRequest) {
  const requestId = crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);
  if (process.env.NODE_ENV === "development" && request.nextUrl.pathname === "/design-system") {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("x-request-id", requestId);
    return response;
  }
  if (!isProtectedPath(request.nextUrl.pathname) || request.cookies.has("forja_session")) {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("x-request-id", requestId);
    return response;
  }
  if (request.nextUrl.pathname.startsWith("/api/")) {
    const response = Response.json(
      { error: "unauthenticated" },
      { status: 401, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } },
    );
    response.headers.set("x-request-id", requestId);
    return response;
  }
  const destination = new URL("/sign-in", request.url);
  if (request.nextUrl.pathname !== "/") destination.searchParams.set("returnTo", request.nextUrl.pathname);
  return NextResponse.redirect(destination);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
