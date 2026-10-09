import type { Metadata } from "next";
import { MailCandidateReviewClient } from "./review-client";

export const metadata: Metadata = {
  title: "메일 후보 검토 | CRM",
  description: "Owner 세션으로 메일 후보의 거래처 연결, 버리기와 되돌리기를 검토합니다.",
};

export default function MailCandidateReviewPage() {
  return <MailCandidateReviewClient />;
}
