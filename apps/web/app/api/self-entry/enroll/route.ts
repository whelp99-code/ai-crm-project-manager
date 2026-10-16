import { enrollThroughCli } from "../../../self-entry-enroll-cli";
import { enrollmentAvailability, submitOperatorEnrollment } from "../../../self-entry-enroll";

export const dynamic = "force-dynamic";

function pageUrl(request: Request): URL {
  return new URL(request.url);
}

export async function GET(request: Request): Promise<Response> {
  const url = pageUrl(request);
  const availability = enrollmentAvailability(url, process.env.CWOS_V2_OPERATOR_AUTH_STATE_PATH);
  return Response.json(
    { open: availability === "open" },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  return submitOperatorEnrollment(request, {
    statePath: process.env.CWOS_V2_OPERATOR_AUTH_STATE_PATH,
    now: Date.now(),
    write: enrollThroughCli,
  });
}
