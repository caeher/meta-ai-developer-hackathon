import { withPreviewGrantHandler } from "../../../../../server/preview/api";

type PreviewGrantRouteContext = { params: Promise<{ projectId: string }> };

export const runtime = "nodejs";

export function POST(request: Request, context: PreviewGrantRouteContext): Promise<Response> {
  return withPreviewGrantHandler((handlers) => handlers.POST(request, context));
}

export function DELETE(request: Request, context: PreviewGrantRouteContext): Promise<Response> {
  return withPreviewGrantHandler((handlers) => handlers.DELETE(request, context));
}
