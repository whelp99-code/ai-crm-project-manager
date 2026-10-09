import { submitSelfEntry, verifySelfEntry } from "../../self-entry-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return submitSelfEntry(request);
}

export async function GET(request: Request): Promise<Response> {
  return verifySelfEntry(request.headers.get("cookie") ?? "");
}
