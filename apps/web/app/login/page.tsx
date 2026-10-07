import { selfEntryConfiguration } from "../self-entry-server";
import { SelfEntryForm } from "./self-entry-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>> }>) {
  const configuration = selfEntryConfiguration();
  const query = await searchParams;
  return (
    <>
      <h1>본인 확인</h1>
      <p className="lead">재민님이 직접 비밀번호와 인증 코드를 입력하는 화면입니다.</p>
      {configuration.ready ? <SelfEntryForm expired={query.state === "expired"} /> : (
        <section className="panel" role="status">
          <h2>설정 필요</h2>
          <p>운영 연결이 확인되지 않아 로그인을 차단했습니다. 비밀번호나 인증 코드를 입력하지 마세요.</p>
          <p className="meta">OWNER_DECISION_REQUIRED</p>
          <ul className="list">{configuration.missing.map(key => <li key={key}><code>{key}</code></li>)}</ul>
        </section>
      )}
    </>
  );
}
