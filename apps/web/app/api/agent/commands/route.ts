import { submitAgentCommand } from "../../../agent-loopback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return submitAgentCommand(request);
}
