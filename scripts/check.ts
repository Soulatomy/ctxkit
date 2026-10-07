import fs from "node:fs";
import path from "node:path";
import { ProfileStore } from "../src/core/profile/store.js";
import { ProxyStore } from "../src/core/proxy/store.js";
import { getHost, allHostNames } from "../src/hosts/registry.js";
import { generateFingerprint } from "../src/core/fingerprint/seed.js";
import { runEngineCheck } from "../src/check/service.js";
import type { CheckReport } from "../src/check/runner.js";
import { checkConsistency } from "../src/core/fingerprint/consistency.js";
import { PROXIES_DB } from "../src/core/config.js";
import { log } from "../src/core/logger.js";
import type { EngineName } from "../src/hosts/types.js";
import type { Fingerprint } from "../src/core/fingerprint/types.js";
import type { ProxyConfig } from "../src/core/proxy/types.js";

interface Args {
  profile?: string;
  engines: EngineName[];
  headless: boolean;
  sites: boolean;
  json: boolean;
  minScore: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { engines: [], headless: true, sites: true, json: false, minScore: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") args.profile = argv[++i];
    else if (a === "--engine") args.engines.push(argv[++i] as EngineName);
    else if (a === "--all-engines") args.engines = allHostNames();
    else if (a === "--headed") args.headless = false;
    else if (a === "--no-sites") args.sites = false;
    else if (a === "--json") args.json = true;
    else if (a === "--min-score") args.minScore = Number(argv[++i]);
  }
  return args;
}

async function checkOne(
  engine: EngineName,
  fp: Fingerprint,
  proxy: ProxyConfig | undefined,
  args: Args,
): Promise<CheckReport | null> {
  const avail = await getHost(engine).isAvailable();
  if (!avail.ok) {
    log.warn("check", `skip ${engine}: ${avail.reason}`);
    return null;
  }
  log.info("check", `=== ${engine} ===`);
  return runEngineCheck(engine, fp, proxy, { headless: args.headless, sites: args.sites });
}

function printReport(r: CheckReport): void {
  console.log(`\n━━ ${r.engine}  signal-consistency: ${r.signalScore}/100  (${r.reportDir})`);
  for (const c of r.signalChecks) {
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.field}${c.ok ? "" : `  expected=${JSON.stringify(c.expected)} actual=${JSON.stringify(c.actual)}`}`);
  }
  if (r.sites.length) {
    console.log("  sites:");
    for (const s of r.sites) {
      const status = s.error ? `ERROR ${s.error.slice(0, 60)}` : s.blocked ? "BLOCKED?" : "ok";
      console.log(`    - ${s.id}: ${status}${s.screenshot ? `  [${path.basename(s.screenshot)}]` : ""}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = new ProfileStore();
  const proxies = new ProxyStore(PROXIES_DB);

  let fp: Fingerprint;
  let proxy: ProxyConfig | undefined;
  let engines = args.engines;

  if (args.profile) {
    const profile = store.resolve(args.profile);
    if (!profile) {
      log.error("check", `profile not found: ${args.profile}`);
      process.exit(1);
    }
    fp = profile.fingerprint;
    proxy = store.resolveProxy(profile, proxies);
    if (!engines.length) engines = [profile.engine];
  } else {
    log.info("check", "no --profile given; using an ephemeral fingerprint (id=selftest)");
    fp = generateFingerprint("selftest");
    if (!engines.length) engines = allHostNames();
  }

  const issues = checkConsistency(fp, proxy);
  if (issues.length) {
    console.log("fingerprint consistency warnings:");
    for (const i of issues) console.log(`  - ${i.field}: ${i.message}`);
  }

  const reports: CheckReport[] = [];
  for (const engine of engines) {
    const r = await checkOne(engine, fp, proxy, args);
    if (r) reports.push(r);
  }

  for (const r of reports) printReport(r);

  if (args.json) {
    const out = path.join("data", "reports", `comparison-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(reports, null, 2));
    console.log(`\nwrote ${out}`);
  }

  // CI gate: fail the process if any engine falls below the required score.
  if (args.minScore > 0) {
    const below = reports.filter((r) => r.signalScore < args.minScore);
    if (below.length) {
      log.error(
        "check",
        `score gate failed (min ${args.minScore}): ${below.map((r) => `${r.engine}=${r.signalScore}`).join(", ")}`,
      );
      process.exit(1);
    }
    log.info("check", `score gate passed (min ${args.minScore}) for: ${reports.map((r) => `${r.engine}=${r.signalScore}`).join(", ")}`);
  }
}

main().catch((err) => {
  log.error("check", (err as Error).message);
  process.exit(1);
});
