const styles = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f4f7fb; color: #172033; font-family: Arial, sans-serif; }
  main { max-width: 1040px; margin: 0 auto; padding: 48px 24px; }
  .eyebrow { color: #526581; font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
  h1 { margin: 10px 0 8px; font-size: clamp(28px, 4vw, 42px); letter-spacing: -.03em; }
  .intro { color: #526581; max-width: 700px; line-height: 1.55; }
  .notice { margin: 28px 0; padding: 18px 20px; border: 1px solid #f0c36b; border-radius: 12px; background: #fff8e8; }
  .notice strong { display: block; margin-bottom: 5px; color: #7c4d00; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
  .card { padding: 20px; border: 1px solid #dce3ee; border-radius: 14px; background: white; box-shadow: 0 4px 18px rgb(35 55 85 / 5%); }
  .card h2 { margin: 0 0 16px; font-size: 16px; }
  dl { display: grid; grid-template-columns: minmax(110px, .7fr) 1.3fr; gap: 12px 16px; margin: 0; font-size: 14px; }
  dt { color: #64748b; } dd { margin: 0; font-weight: 700; overflow-wrap: anywhere; }
  .status { display: inline-block; padding: 5px 9px; border-radius: 999px; background: #eef2ff; color: #3730a3; font-size: 12px; }
  .closed { background: #e7f7ed; color: #176b3b; }
  .footer { margin-top: 22px; color: #64748b; font-size: 12px; }
  @media (max-width: 640px) { main { padding: 28px 16px; } .grid { grid-template-columns: 1fr; } dl { grid-template-columns: 1fr; gap: 4px; } dd { margin-bottom: 8px; } }
`;

export default function Core5C06FixturePage() {
  return (
    <>
      <style>{styles}</style>
      <main>
        <div className="eyebrow">AI-CRM + PM / test-only fixture</div>
        <h1>C06 follow-up / correction / closure</h1>
        <p className="intro">
          A deterministic review fixture for mapping one customer mail to its work item,
          recording a correction, and closing without inventing delivery evidence.
        </p>

        <div className="notice" data-testid="fail-closed-copy">
          <strong>Fail-closed handling</strong>
          No delivery claim is inferred from missing or ambiguous mail evidence. This fixture is local-only and makes no CRM or external mail calls.
        </div>

        <div className="grid">
          <section className="card" aria-labelledby="mapping-title">
            <h2 id="mapping-title">Mail-work mapping</h2>
            <dl data-testid="mail-work-mapping" data-mail-id="mail-c06-001" data-work-id="work-c06-001">
              <dt>Mail</dt><dd>mail-c06-001</dd>
              <dt>Work item</dt><dd>work-c06-001</dd>
              <dt>Relationship</dt><dd>follow-up correction</dd>
            </dl>
          </section>

          <section className="card" aria-labelledby="correction-title">
            <h2 id="correction-title">Correction record</h2>
            <dl>
              <dt>Reason</dt><dd data-testid="correction-reason">Customer requested corrected delivery window</dd>
              <dt>Evidence</dt><dd data-testid="evidence-reference">evidence://mail-c06-001/delivery-status</dd>
            </dl>
          </section>

          <section className="card" aria-labelledby="terminal-title">
            <h2 id="terminal-title">Delivery terminal</h2>
            <dl>
              <dt>State</dt><dd><span className="status" data-testid="delivery-terminal">DELIVERY_UNKNOWN</span></dd>
              <dt>Interpretation</dt><dd>Delivery status remains unconfirmed</dd>
            </dl>
          </section>

          <section className="card" aria-labelledby="customer-state-title">
            <h2 id="customer-state-title">Customer-work state</h2>
            <dl>
              <dt>State</dt><dd><span className="status closed" data-testid="customer-work-state">CLOSED</span></dd>
              <dt>Closure</dt><dd>Correction recorded; no further action queued</dd>
            </dl>
          </section>
        </div>
        <p className="footer">Fixture route: /core5-c06 · No live account boundary crossed.</p>
      </main>
    </>
  );
}
