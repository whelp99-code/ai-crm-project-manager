import { readAgentJob } from "../../../../agent-loopback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return context.params.then(params => readAgentJob(request, params.id));
}
