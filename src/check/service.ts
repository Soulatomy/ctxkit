import fs from "node:fs";
import path from "node:path";
import { getHost } from "../hosts/registry.js";
import type { EngineName } from "../hosts/types.js";
import type { Fingerprint } from "../core/fingerprint/types.js";
import type { ProxyConfig } from "../core/proxy/types.js";
import { startLocalPageServer } from "./local-server.js";
import {
  collectSignalsMainWorld,
  scoreSignals,
  runSites,
  newReportDir,
  type CheckReport,
  type SignalSnapshot,
} from "./runner.js";
import { log } from "../core/logger.js";

export interface RunCheckOptions {
  headless?: boolean;
  sites?: boolean;
  /** Directory for the ephemeral browser profile (defaults to report dir). */
  userDataDir?: string;
}

/**
 * Run a self-check for a single engine+fingerprint and return the report.
 * Local only (no external sites unless `sites` is true). Used by the CLI and
 * by the web console's "self-check" button.
 */
export async function runEngineCheck(
  engine: EngineName,
  fingerprint: Fingerprint,
  proxy: ProxyConfig | undefined,
  opts: RunCheckOptions = {},
): Promise<CheckReport> {
  const host = getHost(engine);
  const avail = await host.isAvailable();
  if (!avail.ok) throw new Error(`engine ${engine} unavailable: ${avail.reason}`);

  const profileId = fingerprint.seed.replace(/^fb:/, "");
  const reportDir = newReportDir(engine, profileId);
  const userDataDir = opts.userDataDir ?? path.join(reportDir, "userdata");

  log.info("check", `running ${engine} check for ${profileId}`);
  const session = await host.launch({
    profileId,
    fingerprint,
    proxy,
    userDataDir,
    headless: opts.headless ?? true,
  });

  try {
    const local = await startLocalPageServer();
    let signals: SignalSnapshot;
    try {
      signals = await collectSignalsMainWorld(session.page, local.url);
    } finally {
      await local.close();
    }
    const { score, checks } = scoreSignals(fingerprint, signals);
    const sites = opts.sites ? await runSites(session.page, reportDir) : [];

    const report: CheckReport = {
      engine,
      profileId,
      timestamp: new Date().toISOString(),
      signalScore: score,
      signalChecks: checks,
      signals,
      sites,
      reportDir,
    };
    fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(report, null, 2));
    return report;
  } finally {
    await session.close();
  }
}
