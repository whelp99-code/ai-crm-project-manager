import { publicEnrollmentDenied } from "../../../self-entry-enroll";

export const dynamic = "force-dynamic";

/** The public app is reached through tailscale serve. It never enrolls, whatever Host says. */
export function GET(_request: Request): Response {
  return publicEnrollmentDenied();
}

export function POST(_request: Request): Response {
  return publicEnrollmentDenied();
}
