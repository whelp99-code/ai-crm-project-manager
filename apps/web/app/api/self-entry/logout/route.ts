import { logoutSelfEntry } from "../../../self-entry-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  return logoutSelfEntry(request);
}
