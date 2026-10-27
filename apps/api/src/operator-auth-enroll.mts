import { closeSync, constants, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { enrollOperator } from "./operator-auth-enrollment.js";

// Owner-run offline CLI. Credential values never appear in argv, output or errors.
try {
  const { values } = parseArgs({
    options: { input: { type: "string" }, state: { type: "string" } },
    strict: true, allowPositionals: false,
  });
  if (!values.input || !values.state) throw new Error("ENROLLMENT_ARGUMENTS_REQUIRED");
  const fd = openSync(values.input, constants.O_RDONLY | constants.O_NOFOLLOW);
  let input: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()
      || stat.size > 4096) throw new Error("PRIVATE_INPUT_REQUIRED");
    input = JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
  const record = enrollOperator(input, Date.now());
  writeFileSync(values.state, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write("OPERATOR_ENROLLED\n");
} catch {
  process.stderr.write("OPERATOR_ENROLLMENT_REJECTED\n");
  process.exitCode = 1;
}
