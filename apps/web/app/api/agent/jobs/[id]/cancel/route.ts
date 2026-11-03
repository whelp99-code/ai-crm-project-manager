import { cancelAgentJob } from "../../../../../agent-loopback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return context.params.then(params => cancelAgentJob(request, params.id));
}
