from pathlib import Path

path = Path("packages/domain/src/customer-work-os-graphs.ts")
text = path.read_text()
old = '  loops: [loop("procurement.receipt", ["procurement.receive", "procurement.reconcile"], "Reconcile partial receipts within ordered quantity", "procurement.escalated", "procurement.receive")],'
new = '''  loops: [
    loop("procurement.request_validation", ["procurement.request", "procurement.verify"], "Repair budget, vendor or quantity validation before approval", "procurement.cancelled", "procurement.request"),
    loop("procurement.receipt", ["procurement.receive", "procurement.reconcile"], "Reconcile partial receipts within ordered quantity", "procurement.escalated", "procurement.receive"),
  ],'''
if old not in text and new not in text:
    raise SystemExit("procurement loop marker not found")
path.write_text(text.replace(old, new))
Path("scripts/fix-procurement-graph-loop.py").unlink()
Path(".github/workflows/cwos-fix-procurement-graph.yml").unlink()
