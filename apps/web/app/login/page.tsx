import { selfEntryConfiguration } from "../self-entry-server";
import { SelfEntryForm } from "./self-entry-form";
import styles from "./self-entry-form.module.css";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>> }>) {
  const configuration = selfEntryConfiguration();
  const query = await searchParams;
  return (
    <>
      <h1>CRM 로그인</h1>
      <p className={`lead ${styles.intro}`}>비밀번호와 OTP로 본인 확인 후 업무 화면에 들어갑니다.</p>
      {configuration.ready ? <SelfEntryForm expired={query.state === "expired"} /> : (
        <section className="panel" role="status">
          <h2>로그인 설정 필요</h2>
          <p>관리자가 인증 연결을 설정하기 전에는 로그인할 수 없습니다.</p>
        </section>
      )}
    </>
  );
}
