import type { Metadata } from "next";
import { MailCandidateReviewClient } from "./review-client";
import { cookies } from "next/headers";
import { selfEntryRole } from "../../self-entry-server";

export const metadata: Metadata = {
  title: "메일 후보 검토 | CRM",
  description: "Owner 세션으로 메일 후보의 거래처 연결, 버리기와 되돌리기를 검토합니다.",
};

export default async function MailCandidateReviewPage() {
  return <MailCandidateReviewClient role={await selfEntryRole((await cookies()).toString())} />;
}
