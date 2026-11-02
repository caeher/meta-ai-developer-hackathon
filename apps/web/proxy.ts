import { NextResponse, type NextRequest } from "next/server";

const publicPaths = new Set(["/", "/sign-in", "/sign-up", "/forgot-password", "/reset-password", "/verify-email"]);

function isProtectedPath(pathname: string): boolean {
  return !publicPaths.has(pathname) &&
    !pathname.startsWith("/api/auth/") &&
    pathname !== "/api/health";
}

export default function proxy(request: NextRequest) {
  if (process.env.NODE_ENV === "development" && request.nextUrl.pathname === "/design-system") {
    return NextResponse.next();
  }
  if (!isProtectedPath(request.nextUrl.pathname) || request.cookies.has("forja_session")) {
    return NextResponse.next();
  }
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return Response.json(
      { error: "unauthenticated" },
      { status: 401, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } },
    );
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
