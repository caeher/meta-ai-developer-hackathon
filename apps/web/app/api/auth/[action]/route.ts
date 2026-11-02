import { withAuthApi } from "../../../../server/auth/api";

type Context = { params: Promise<{ action: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { action } = await context.params;
  if (action !== "session") return Response.json({ error: "not_found" }, { status: 404 });
  return withAuthApi((handlers) => handlers.session(request));
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { action } = await context.params;
  return withAuthApi((handlers) => {
    switch (action) {
      case "register": return handlers.register(request);
      case "login": return handlers.login(request);
      case "logout": return handlers.logout(request);
      case "logout-all": return handlers.logoutAll(request);
      case "delete-account": return handlers.deleteAccount(request);
      case "forgot-password": return handlers.forgotPassword(request);
      case "verify-email": return handlers.verifyEmail(request);
      case "reset-password": return handlers.resetPassword(request);
      default: return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
    }
  });
}
