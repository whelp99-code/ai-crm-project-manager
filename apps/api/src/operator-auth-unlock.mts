import { FileOperatorAuthStore } from "./operator-auth-store.js";

// Offline only: stop the single owning API process before changing its state.
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--state" || !args[1]) throw new Error("input");
  const store = new FileOperatorAuthStore(args[1]);
  const record = store.read();
  const { rate: _rate, ...enrollment } = record;
  store.write(enrollment);
  process.stdout.write("OPERATOR_UNLOCKED\n");
} catch {
  process.stderr.write("OPERATOR_UNLOCK_REJECTED\n");
  process.exitCode = 1;
}
