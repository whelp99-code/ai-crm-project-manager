import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifySelfEntry } from "../self-entry-server";

export const dynamic = "force-dynamic";

export default async function SelfEntryPage() {
  const jar = await cookies();
  const result = await verifySelfEntry(jar.toString());
  if (result.status !== 200) {
    const data: unknown = await result.json();
    const expired = typeof data === "object" && data !== null && "error" in data
      && data.error === "OPERATOR_PROOF_EXPIRED";
    redirect(expired ? "/login?state=expired" : "/login");
  }
  return (
    <section className="panel" aria-labelledby="verified-title">
      <h1 id="verified-title">본인 확인 완료</h1>
      <p>기존 운영자 세션으로 보호된 화면에 진입했습니다.</p>
      <p className="meta">회사·업무 데이터와 운영 전환은 별도 승인 범위입니다. 이 화면에서 실행하지 않습니다.</p>
    </section>
  );
}
