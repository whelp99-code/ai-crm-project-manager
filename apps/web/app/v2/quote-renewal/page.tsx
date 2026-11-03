import { DocumentDraftClient } from "./draft-client";
import { cookies } from "next/headers";
import { selfEntryRole } from "../../self-entry-server";

export default async function QuoteRenewalPage() {
  return <DocumentDraftClient role={await selfEntryRole((await cookies()).toString())} />;
}
