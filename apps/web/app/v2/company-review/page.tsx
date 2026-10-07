import { headers } from "next/headers";
import { CompanyReviewClient } from "./review-client";
import { isLocalReviewAllowed } from "../../lib/local-review-guard";

export const dynamic = "force-dynamic";

export default async function LocalCompanyReviewPage() {
  const host = (await headers()).get("host") ?? "";
  let hostname = "";
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    hostname = "";
  }
  if (!isLocalReviewAllowed({
    optIn: process.env.CWOS_LOCAL_REVIEW,
    nodeEnv: process.env.NODE_ENV,
    hostname,
  })) {
    return (
      <section className="error" aria-labelledby="local-review-unavailable">
        <h1 id="local-review-unavailable">Local review is unavailable</h1>
        <p>This candidate review is enabled only by CWOS_LOCAL_REVIEW=1 outside production.</p>
      </section>
    );
  }

  return <CompanyReviewClient />;
}
