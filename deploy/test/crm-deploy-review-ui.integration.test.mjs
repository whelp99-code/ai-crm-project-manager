import { describe, expect, it } from "vitest";
import { statSync } from "node:fs";
import { join } from "node:path";
import { withDeployment as runDeployment, readJson, readText, exists } from "./fixtures/deployment.mjs";

const withDeployment = (options, inspect) => runDeployment({
  script: "deploy/crm-deploy-review-ui.sh",
  target: "f1fde1cf73c013a17e606b98c0076ae289af8740",
  units: ["core5-api", "core5-web", "core5-review-ui"], ...options,
}, inspect);

function restored(result) {
  for (const [index, unit] of result.units.entries()) {
    if (unit === "core5-review-ui") {
      expect(exists(result.dropins[index])).toBe(false);
      continue;
    }
    expect(readText(result.dropins[index])).toBe(result.originals[unit]);
    expect(statSync(result.dropins[index]).mode & 0o777).toBe(0o640);
  }
  expect(readText(result.humanEnv)).toBe(result.humanBefore);
  expect(readText(result.newAuth)).toBe(result.ownerBefore);
}

describe("PR65 deployment runtime regressions", () => {
  it.each(["core5-api", "core5-web", "core5-review-ui"])("does not publish when only %s is dead", async deadUnit => {
    await withDeployment({ deadUnit, deadPhase: "deploy" }, result => {
      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain("CRM_REVIEW_UI_LIVE");
      expect(result.stderr).toContain("CRM_ROLLBACK_OK");
      restored(result);
    });
  });

  it.each(["core5-api", "core5-web", "core5-review-ui"])("retains recovery files when %s alone fails rollback", async deadUnit => {
    await withDeployment({ deadUnit, deadPhase: "rollback", failReload: true }, result => {
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("CRM_ROLLBACK_FAILED");
      expect(result.stderr).not.toContain("CRM_ROLLBACK_OK");
      expect(exists(result.release)).toBe(true);
      restored(result);
    });
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    for (const signalAt of ["write", "restart"]) {
      it(`finishes rollback for ${signal} at ${signalAt}, including repeated interruption`, async () => {
        await withDeployment({ signal, signalAt, repeatSignal: true }, result => {
          expect(result.signal).toBeNull();
          expect(result.code).toBe(signal === "SIGINT" ? 130 : 143);
          expect(result.stderr).toContain("CRM_ROLLBACK_OK");
          expect(result.stdout).not.toContain("CRM_REVIEW_UI_LIVE");
          expect(exists(join(result.root, "rollback-signal-sent"))).toBe(true);
          if (signalAt === "restart") expect(exists(join(result.root, "interrupted-child-closed"))).toBe(true);
          expect(exists(result.release)).toBe(false);
          restored(result);
        });
      });
    }
  }

  it("applies private EnvironmentFiles and verifies restarted auth without changing human env", async () => {
    await withDeployment({}, result => {
      expect(result.code, result.stderr).toBe(0);
      expect(result.state.units["core5-api"].environment.CWOS_V2_OPERATOR_AUTH_STATE_PATH).toBe(result.newAuth);
      expect(result.state.units["core5-web"].environment.CRM_WEB_ORIGIN).toBe("https://web.invalid");
      expect(result.state.units["core5-review-ui"].environment.CRM_WEB_ORIGIN).toBe("https://review.invalid");
      expect(result.state.units["core5-review-ui"].environment.CRM_REVIEW_UI).toBe("1");
      expect(statSync(result.configuration("core5-review-ui").envFiles.at(-1)).mode & 0o777).toBe(0o600);
      const overlay = result.configuration("core5-api").envFiles.at(-1);
      expect(overlay).not.toBe(result.humanEnv);
      expect(statSync(overlay).mode & 0o777).toBe(0o600);
      expect(result.events.filter(event => event.args.includes("is-active")).every(event =>
        event.args.filter(arg => arg.startsWith("core5-")).length === 1)).toBe(true);
      expect(result.events.some(event => event.args.includes("--property=MainPID"))).toBe(true);
      expect(readText(result.humanEnv)).toBe(result.humanBefore);
      expect(readText(result.newAuth)).toBe(result.ownerBefore);
    });
  });

  it("rolls back when a healthy process still received the legacy auth path", async () => {
    await withDeployment({ staleAuth: true }, result => {
      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain("CRM_REVIEW_UI_LIVE");
      expect(result.stderr).toContain("CRM_ROLLBACK_OK");
      expect(result.state.units["core5-api"].environment.CWOS_V2_OPERATOR_AUTH_STATE_PATH).toBe(result.oldAuth);
      restored(result);
    });
  });

  it("rolls back when the review process keeps the old origin despite healthy probes", async () => {
    await withDeployment({ staleReview: true }, result => {
      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain("CRM_REVIEW_UI_LIVE");
      expect(result.stderr).toContain("CRM_ROLLBACK_OK");
      expect(result.state.units["core5-review-ui"].environment.CRM_WEB_ORIGIN).toBe("https://old.invalid");
      restored(result);
    });
  });

  it("streams a 256 MiB dump with exact catalog input and bounded RSS", async () => {
    const bytes = 256 * 1024 * 1024;
    await withDeployment({ dumpBytes: bytes }, result => {
      expect(result.code, result.stderr).toBe(0);
      expect(readJson(join(result.root, "catalog.json"))).toEqual({ bytes, sha256: result.expectedHash });
      expect(result.stdout).toContain(`CRM_BACKUP_OK bytes=${bytes} sha256=${result.expectedHash}`);
      console.info(`DUMP_MEMORY bytes=${bytes} maxRSSKiB=${result.usage.maxRSS}`);
      expect(result.usage.maxRSS).toBeLessThan(192 * 1024);
    });
  }, 30_000);

  it.each([{ dumpBytes: 0 }, { badCatalog: true }])("refuses an unusable dump before unit changes: %j", async options => {
    await withDeployment(options, result => {
      expect(result.code).not.toBe(0);
      expect(result.events.some(event => event.args.includes("daemon-reload"))).toBe(false);
      expect(exists(result.release)).toBe(false);
      restored(result);
    });
  });
});
