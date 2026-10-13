import { describe, expect, it } from "vitest";
import { statSync } from "node:fs";
import { join } from "node:path";
import { withDeployment, readJson, readText, exists } from "./fixtures/deployment.mjs";

function restored(result) {
  for (const [index, unit] of result.units.entries()) {
    expect(readText(result.dropins[index])).toBe(result.originals[unit]);
    expect(statSync(result.dropins[index]).mode & 0o777).toBe(0o640);
  }
  expect(readText(result.humanEnv)).toBe(result.humanBefore);
  expect(readText(result.newAuth)).toBe(result.ownerBefore);
}

describe("PR63 deployment runtime regressions", () => {
  it.each(["core5-api", "core5-web"])("does not publish when only %s is dead", async deadUnit => {
    await withDeployment({ deadUnit, deadPhase: "deploy" }, result => {
      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain("CRM_1CF5_LIVE");
      expect(result.stderr).toContain("CRM_ROLLBACK_OK");
      restored(result);
    });
  });

  it.each(["core5-api", "core5-web"])("retains recovery files when %s alone fails rollback", async deadUnit => {
    await withDeployment({ deadUnit, deadPhase: "rollback", failReload: true }, result => {
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("CRM_ROLLBACK_FAILED");
      expect(result.stderr).not.toContain("CRM_ROLLBACK_OK");
      expect(exists(result.release)).toBe(true);
      restored(result);
    });
  });

  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    for (const signalAt of ["write", "restart"]) {
      it(`finishes rollback for ${signal} at ${signalAt}, including repeated interruption`, async () => {
        await withDeployment({ signal, signalAt, repeatSignal: true }, result => {
          expect(result.signal).toBeNull();
          expect(result.code).toBe({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }[signal]);
          expect(result.liveOwnedProcesses).toBe(0);
          expect(result.stderr).toContain("CRM_ROLLBACK_OK");
          expect(result.stdout).not.toContain("CRM_1CF5_LIVE");
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
      expect(result.usage.nodeMajor).toBe(22);
      expect(result.state.units["core5-api"].environment.CWOS_V2_OPERATOR_AUTH_STATE_PATH).toBe(result.newAuth);
      expect(result.state.units["core5-web"].environment.CRM_WEB_ORIGIN).toBe("https://web.invalid");
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

  it.each([false, true])("handles missing final newlines with rollback=%s", async failReload => {
    await withDeployment({ noFinalNewline: true, failReload }, result => {
      if (failReload) {
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("CRM_ROLLBACK_OK");
        restored(result);
      } else {
        expect(result.code, result.stderr).toBe(0);
        expect(result.state.units["core5-api"].environment.CWOS_V2_OPERATOR_AUTH_STATE_PATH).toBe(result.newAuth);
        expect(result.state.units["core5-web"].environment.CRM_WEB_ORIGIN).toBe("https://web.invalid");
      }
    });
  });

  it.each([false, true])("excludes concurrent writers through cleanup with rollback=%s", async failReload => {
    await withDeployment({ contend: true, failReload }, result => {
      expect(result.lockHeld).toBe(true);
      expect(result.contender.code).toBe(1);
      expect(result.contender.stderr).toContain("reason=deployment_in_progress");
      expect(result.events.filter(event => event.contender)).toHaveLength(0);
      expect(result.lockReleased).toBe(true);
      expect(result.liveOwnedProcesses).toBe(0);
      if (failReload) {
        expect(result.stderr).toContain("CRM_ROLLBACK_OK");
        restored(result);
      } else expect(result.code, result.stderr).toBe(0);
    });
  });

  it.each([{ sourceMismatch: true }, { sqlDelta: true }])("preserves source guards with modeled Git: %j", async options => {
    await withDeployment(options, result => {
      expect(result.code).not.toBe(0);
      expect(result.events.some(event => event.name === "systemctl")).toBe(false);
      expect(exists(result.release)).toBe(false);
      restored(result);
    });
  });

  it("rolls back when a healthy process still received the legacy auth path", async () => {
    await withDeployment({ staleAuth: true }, result => {
      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain("CRM_1CF5_LIVE");
      expect(result.stderr).toContain("CRM_ROLLBACK_OK");
      expect(result.state.units["core5-api"].environment.CWOS_V2_OPERATOR_AUTH_STATE_PATH).toBe(result.oldAuth);
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
