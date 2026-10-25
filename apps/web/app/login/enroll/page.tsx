import styles from "../self-entry-form.module.css";

export const dynamic = "force-dynamic";

export default function EnrollPage() {
  return (
    <>
      <h1>운영자 등록</h1>
      <p className={`lead ${styles.intro}`}>등록은 서버의 루프백 전용 포트에서만 열립니다.</p>
      <section className="panel" role="status">
        <h2>이 주소에서는 등록할 수 없습니다</h2>
        <p>tailnet의 8446·8447과 그 뒤의 4312·4313에서는 등록 화면이 열리지 않습니다. 서버에서 루프백 전용 포트로 열거나 ssh 터널을 사용하세요.</p>
      </section>
    </>
  );
}
