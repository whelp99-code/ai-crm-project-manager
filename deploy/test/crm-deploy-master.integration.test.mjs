import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
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
  it.each(["SIGHUP", "SIGTERM"])("kills detached-stdio descendants after their leader exits on %s", async signal => {
    await withDeployment({ signal, signalAt: "restart", leaderExitsFirst: true, deadlineMs: 15_000 }, result => {
      expect(result.code).toBe(signal === "SIGHUP" ? 129 : 143);
      expect(result.signal).toBeNull();
      expect(exists(join(result.root, "leader-exited-first"))).toBe(true);
      expect(exists(join(result.root, "descendant-ignored-term"))).toBe(true);
      expect(result.liveOwnedProcesses).toBe(0);
      const leader = Number(readText(join(result.root, "leader-exited-first")));
      const signals = readdirSync(result.root).filter(name => name.startsWith("kill-"))
        .map(name => readJson(join(result.root, name))).filter(event => event.pid === -leader);
      expect(signals.some(event => event.signal === "SIGKILL")).toBe(true);
      const term = signals.find(event => event.signal === "SIGTERM");
      const kill = signals.find(event => event.signal === "SIGKILL");
      expect(kill.at - term.at).toBeGreaterThanOrEqual(4_900);
      expect(result.stderr).toContain("CRM_ROLLBACK_OK");
      restored(result);
    });
  }, 25_000);

  it.each(["/", "/work", "/pilot", "/approvals", "/monitor", "/v2"])("refuses a build with frozen runtime route %s", async staticRoute => {
    await withDeployment({ staticRoute }, result => {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("runtime_page_prerendered");
      expect(result.events.some(event => event.args.includes("daemon-reload"))).toBe(false);
      expect(exists(result.release)).toBe(false);
      restored(result);
    });
  });

  it("preserves explicit public build settings without exposing operational secrets", async () => {
    await withDeployment({ publicApiBase: "https://build-api.invalid" }, result => {
      expect(result.code, result.stderr).toBe(0);
      const build = result.events.filter(event => event.build);
      expect(build.every(event => event.publicApiBase === "https://build-api.invalid")).toBe(true);
      expect(build.every(event => event.exposed.length === 0)).toBe(true);
    });
  });

  it("uses the approved corrected source target", async () => {
    await withDeployment({ target: "2".repeat(40) }, result => {
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("release=app-22222222");
      expect(result.configuration("core5-api").cwd).toBe(join(result.release, "apps/api"));
    });
  });

  it("rejects catalog-readable data that fails restoration before target execution", async () => {
    await withDeployment({ badRestore: true }, result => {
      expect(exists(join(result.root, "catalog.json"))).toBe(true);
      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain("CRM_BACKUP_OK");
      expect(result.events.some(event => event.name === "pnpm")).toBe(false);
      expect(result.events.some(event => event.args.includes("daemon-reload"))).toBe(false);
      expect(exists(join(result.root, "restore-container-removed"))).toBe(true);
      expect(exists(result.release)).toBe(false);
      restored(result);
    });
  });

  it("removes the temporary restore container after interruption", async () => {
    await withDeployment({ signal: "SIGHUP", signalAt: "restore" }, result => {
      expect(result.code).toBe(129);
      expect(result.stdout).not.toContain("CRM_BACKUP_OK");
      expect(result.events.some(event => event.name === "pnpm")).toBe(false);
      expect(readText(join(result.root, "restore-container-removed")))
        .toBe(readText(join(result.root, "restore-container")));
      expect(result.liveOwnedProcesses).toBe(0);
      expect(exists(result.release)).toBe(false);
      restored(result);
    });
  });

  it("waits for the restored web login port before accepting rollback", async () => {
    await withDeployment({ failReload: true, coldRollbackUrls: ["http://127.0.0.1:4313/login"] }, result => {
      expect(result.stderr).toContain("CRM_ROLLBACK_OK");
      const response = result.events.find(event => event.realHttp);
      expect(response?.realHttp.refused).toBe(true);
      expect(response?.realHttp.output).toBe("{}\n200");
      expect(response?.realHttp.requests).toEqual(["/login"]);
      expect(exists(result.release)).toBe(false);
      restored(result);
    });
  }, 20_000);

  it.each([
    { rollbackHttpFailure: "http://127.0.0.1:4313/login" },
    { rollbackUnavailableUrl: "http://127.0.0.1:4313/login" },
    { rollbackBoundaryFailure: "http://127.0.0.1:4313/api/self-entry" },
  ])("preserves artifacts when the restored web surface fails: %j", async options => {
    await withDeployment({ failReload: true, ...options }, result => {
      expect(result.stderr).toContain("ROLLBACK_INCOMPLETE");
      expect(result.stderr).not.toContain("CRM_ROLLBACK_OK");
      expect(exists(result.release)).toBe(true);
      restored(result);
    });
  });

  it("rejects forward web failure and checks the restored web surface", async () => {
    await withDeployment({ deployHttpFailure: "http://127.0.0.1:4313/login" }, result => {
      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain("CRM_1CF5_LIVE");
      expect(result.stderr).toContain("CRM_ROLLBACK_OK");
      expect(result.events.some(event => event.rollback
        && event.args.at(-1) === "http://127.0.0.1:4313/login")).toBe(true);
      restored(result);
    });
  });

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
      expect(result.stderr).toContain("ROLLBACK_INCOMPLETE");
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

  it.each([{ sourceMismatch: true }, { sqlDelta: true }, { sourceUnrelated: true }])("preserves source guards with modeled Git: %j", async options => {
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

  it("kills a TERM-ignoring process group before completing rollback", async () => {
    await withDeployment({ signal: "SIGHUP", signalAt: "restart", stubborn: true, deadlineMs: 15_000 }, result => {
      expect(result.code).toBe(129);
      expect(result.signal).toBeNull();
      expect(exists(join(result.root, "parent-ignored-term"))).toBe(true);
      expect(exists(join(result.root, "descendant-ignored-term"))).toBe(true);
      expect(result.childExits.some(exit => exit.signal === "SIGKILL")).toBe(true);
      expect(result.liveOwnedProcesses).toBe(0);
      expect(result.stderr).toContain("CRM_ROLLBACK_OK");
      restored(result);
    });
  }, 25_000);

  it("waits through real connection refusal before accepting cold rollback", async () => {
    await withDeployment({ failReload: true, coldRollback: true }, result => {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("CRM_ROLLBACK_OK");
      expect(result.stderr).not.toContain("ROLLBACK_INCOMPLETE");
      const http = result.events.filter(event => event.realHttp).map(event => event.realHttp);
      expect(http).toHaveLength(2);
      expect(http.every(event => event.refused && event.code === 0 && event.output === "{}\n200")).toBe(true);
      expect(http.flatMap(event => event.requests).sort()).toEqual(["/health", "/ready"]);
      expect(exists(result.release)).toBe(false);
      expect(result.liveOwnedProcesses).toBe(0);
      restored(result);
    });
  }, 20_000);

  it.each(["core5-api", "core5-web"])("rejects restored %s environment despite cold HTTP recovery", async rollbackEnvironmentUnit => {
    await withDeployment({ failReload: true, coldRollback: true, rollbackEnvironmentUnit }, result => {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("ROLLBACK_INCOMPLETE");
      expect(result.stderr).not.toContain("CRM_ROLLBACK_OK");
      expect(result.events.filter(event => event.realHttp)).toHaveLength(2);
      expect(exists(result.release)).toBe(true);
      expect(exists(join(result.root, "state/backups"))).toBe(true);
      expect(result.liveOwnedProcesses).toBe(0);
      restored(result);
    });
  }, 20_000);

  it.each(["/health", "/ready"])("retains recovery artifacts when rollback %s is 503", async rollbackHttpFailure => {
    await withDeployment({ failReload: true, rollbackHttpFailure }, result => {
      expect(result.stderr).toContain("CRM_ROLLBACK_FAILED");
      expect(result.stderr).toContain("ROLLBACK_INCOMPLETE");
      expect(result.stderr).not.toContain("CRM_ROLLBACK_OK");
      expect(exists(result.release)).toBe(true);
      expect(exists(join(result.root, "state/backups"))).toBe(true);
      restored(result);
    });
  });

  for (const mismatch of ["lateCwdUnit", "staleCwdUnit"]) {
    it.each(["core5-api", "core5-web"])(`rejects ${mismatch} for %s despite healthy environment`, async unit => {
      await withDeployment({ [mismatch]: unit }, result => {
        expect(result.code).not.toBe(0);
        expect(result.stdout).not.toContain("CRM_1CF5_LIVE");
        expect(result.stderr).toContain("CRM_ROLLBACK_OK");
        restored(result);
      });
    });
  }

  it("retains recovery artifacts if the rollback process remains in the new directory", async () => {
    await withDeployment({ failReload: true, rollbackCwdUnit: "core5-api" }, result => {
      expect(result.stderr).toContain("CRM_ROLLBACK_FAILED");
      expect(result.stderr).toContain("ROLLBACK_INCOMPLETE");
      expect(result.stderr).not.toContain("CRM_ROLLBACK_OK");
      expect(exists(result.release)).toBe(true);
      restored(result);
    });
  });

  it("backs up before target execution and withholds build database credentials", async () => {
    await withDeployment({ mutateDb: true }, result => {
      expect(result.code, result.stderr).toBe(0);
      const target = result.events.filter(event => event.name === "pnpm");
      expect(target.length).toBe(3);
      expect(target.every(event => event.backupValidated)).toBe(true);
      expect(target.filter(event => event.build).every(event => event.exposed.length === 0)).toBe(true);
      expect(readJson(join(result.root, "dump-snapshot.json")).dbVersion).toBe(0);
      expect(result.state.dbVersion).toBe(0);
    });
  });

  it.each(["dotdot", "symlink", "hardlink"])("rejects %s aliases of the preserved auth state", async authAlias => {
    await withDeployment({ authAlias }, result => {
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("legacy_auth_state_must_be_preserved");
      expect(result.events).toHaveLength(0);
      expect(readText(result.oldAuth)).toBe(result.oldBefore);
      restored(result);
    });
  });

  it.each([{ dumpBytes: 0 }, { badCatalog: true }])("refuses an unusable dump before unit changes: %j", async options => {
    await withDeployment(options, result => {
      expect(result.code).not.toBe(0);
      expect(result.events.some(event => event.args.includes("daemon-reload"))).toBe(false);
      expect(exists(result.release)).toBe(false);
      restored(result);
    });
  });
});
