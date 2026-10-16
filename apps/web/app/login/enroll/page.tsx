import { headers } from "next/headers";
import { enrollmentAvailability } from "../../self-entry-enroll";
import { EnrollForm } from "../enroll-form";
import styles from "../self-entry-form.module.css";

export const dynamic = "force-dynamic";

function surfaceUrl(headerList: Headers): URL {
  const host = headerList.get("host") ?? "invalid.invalid";
  const proto = headerList.get("x-forwarded-proto") === "https" ? "https:" : "http:";
  return new URL(`${proto}//${host}/login/enroll`);
}

export default async function EnrollPage() {
  const availability = enrollmentAvailability(
    surfaceUrl(await headers()),
    process.env.CWOS_V2_OPERATOR_AUTH_STATE_PATH,
  );
  return (
    <>
      <h1>운영자 등록</h1>
      <p className={`lead ${styles.intro}`}>로컬 루프백 또는 기존 HTTPS 8446·8447에서 한 번만 등록합니다.</p>
      {availability === "open" ? <EnrollForm /> : (
        <section className="panel" role="status">
          <h2>{availability === "enrolled" ? "이미 등록되어 있습니다" : "이 주소에서는 등록할 수 없습니다"}</h2>
          <p>
            {availability === "enrolled"
              ? "다시 등록하려면 서비스를 멈춘 뒤 새 인증 파일로 바꾸고 서명 비밀을 교체하는 초기화 절차가 필요합니다."
              : availability === "unconfigured"
                ? "등록 경로가 설정되지 않았습니다."
                : "로컬 루프백 또는 HTTPS 8446·8447에서만 등록 화면이 열립니다."}
          </p>
        </section>
      )}
    </>
  );
}
