import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { REPORTS_DIR, ensureDataDirs } from "../core/config.js";
import type { Fingerprint } from "../core/fingerprint/types.js";
import { TARGETS, type DetectionTarget } from "./targets.js";
import { log } from "../core/logger.js";

const SCOPE = "check";

export interface SignalSnapshot {
  userAgent: string;
  platform: string;
  languages: string[];
  timezone: string;
  locale: string;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  screen: [number, number, number];
  inner: [number, number];
  webglVendor: string | null;
  webglRenderer: string | null;
  webdriver: boolean | null;
  pluginsLength: number;
  canvasHash: string;
  hasUAData: boolean;
}

export interface SignalCheck {
  field: string;
  ok: boolean;
  expected: unknown;
  actual: unknown;
}

export interface SiteResult {
  id: string;
  url: string;
  title: string;
  blocked: boolean;
  screenshot: string;
  textSnippet: string;
  error?: string;
}

export interface CheckReport {
  engine: string;
  profileId: string;
  timestamp: string;
  signalScore: number;
  signalChecks: SignalCheck[];
  signals: SignalSnapshot;
  sites: SiteResult[];
  reportDir: string;
}

/**
 * Main-world snapshot logic, serialized as a string so it can be installed as a
 * page init script. It runs in the MAIN world (where real pages and the
 * fingerprint overrides live) and stashes the result in a DOM attribute, which
 * the checker can read even though `page.evaluate` runs in an isolated world.
 */
const SNAPSHOT_FN = `function fbCollect() {
  var out = {};
  try {
    var canvas = document.createElement('canvas');
    canvas.width = 200; canvas.height = 40;
    var ctx = canvas.getContext('2d');
    var canvasHash = '';
    if (ctx) {
      ctx.textBaseline = 'top'; ctx.font = '14px Arial';
      ctx.fillStyle = '#f60'; ctx.fillRect(0, 0, 100, 20);
      ctx.fillStyle = '#069'; ctx.fillText('fingerprint-browser', 2, 2);
      var data = canvas.toDataURL();
      var h = 0;
      for (var i = 0; i < data.length; i++) h = (Math.imul(31, h) + data.charCodeAt(i)) | 0;
      canvasHash = (h >>> 0).toString(16);
    }
    var webglVendor = null, webglRenderer = null;
    try {
      var gl = document.createElement('canvas').getContext('webgl');
      var dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
      if (gl && dbg) {
        webglVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
        webglRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      }
    } catch (e) {}
    var ro = Intl.DateTimeFormat().resolvedOptions();
    out = {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      languages: Array.prototype.slice.call(navigator.languages || []),
      timezone: ro.timeZone,
      locale: ro.locale,
      hardwareConcurrency: navigator.hardwareConcurrency == null ? null : navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory == null ? null : navigator.deviceMemory,
      screen: [screen.width, screen.height, screen.colorDepth],
      inner: [window.innerWidth, window.innerHeight],
      webglVendor: webglVendor,
      webglRenderer: webglRenderer,
      webdriver: navigator.webdriver == null ? null : navigator.webdriver,
      pluginsLength: navigator.plugins.length,
      canvasHash: canvasHash,
      hasUAData: 'userAgentData' in navigator,
    };
  } catch (e) { out = { error: String(e) }; }
  return out;
}`;

/**
 * Init script that captures the main-world snapshot on DOMContentLoaded and
 * writes it to <html data-fb-signals="...">. Registered AFTER the fingerprint
 * init script, and deferred to a macrotask, so it observes the final state.
 */
export const MAIN_WORLD_REPORTER = `(function () {
  ${SNAPSHOT_FN}
  function install() {
    try {
      var snap = fbCollect();
      document.documentElement.setAttribute('data-fb-signals', JSON.stringify(snap));
    } catch (e) {
      document.documentElement.setAttribute('data-fb-signals', JSON.stringify({ error: String(e) }));
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(install, 0); });
  } else {
    setTimeout(install, 0);
  }
})();`;

/**
 * Collect signals from the MAIN world by navigating to `url`. Registers the
 * reporter init script first (init scripts only affect subsequent navigations),
 * then reads the snapshot out of the DOM so the isolated-world evaluate is never
 * relied on.
 */
export async function collectSignalsMainWorld(page: Page, url: string): Promise<SignalSnapshot> {
  await page.addInitScript({ content: MAIN_WORLD_REPORTER });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.documentElement.hasAttribute("data-fb-signals"),
    undefined,
    { timeout: 15000 },
  );
  const raw = await page.getAttribute("html", "data-fb-signals");
  if (!raw) throw new Error("main-world snapshot attribute missing");
  const parsed = JSON.parse(raw) as SignalSnapshot & { error?: string };
  if (parsed.error) throw new Error(`main-world snapshot error: ${parsed.error}`);
  return parsed;
}

/**
 * Score how well the live browser matches the intended fingerprint. This is
 * self-consistency, NOT a WAF verdict — the sites probe covers the latter.
 */
export function scoreSignals(fp: Fingerprint, s: SignalSnapshot): { score: number; checks: SignalCheck[] } {
  const checks: SignalCheck[] = [];
  const add = (field: string, ok: boolean, expected: unknown, actual: unknown) => checks.push({ field, ok, expected, actual });

  add("userAgent", s.userAgent === fp.userAgent, fp.userAgent, s.userAgent);
  add("platform", s.platform === fp.platform, fp.platform, s.platform);
  add("timezone", s.timezone === fp.timezone, fp.timezone, s.timezone);
  add("locale-prefix", s.locale.toLowerCase().startsWith(fp.locale.slice(0, 2).toLowerCase()), fp.locale, s.locale);
  add("languages", s.languages[0] === fp.languages[0], fp.languages[0], s.languages[0]);
  add("screen", s.screen[0] === fp.screen.width && s.screen[1] === fp.screen.height, [fp.screen.width, fp.screen.height], s.screen);
  add("webglVendor", s.webglVendor === fp.webgl.vendor, fp.webgl.vendor, s.webglVendor);
  add("webglRenderer", s.webglRenderer === fp.webgl.renderer, fp.webgl.renderer, s.webglRenderer);
  add("webdriver-hidden", s.webdriver === false || s.webdriver === null, false, s.webdriver);

  const passed = checks.filter((c) => c.ok).length;
  const score = Math.round((passed / checks.length) * 100);
  return { score, checks };
}

function isBlocked(t: DetectionTarget, text: string): boolean {
  const lower = text.toLowerCase();
  const keywords = t.blockKeywords ?? ["just a moment", "verify you are human", "access denied", "cf-challenge", "checking your browser"];
  return keywords.some((k) => lower.includes(k));
}

export async function runSites(page: Page, outDir: string): Promise<SiteResult[]> {
  const results: SiteResult[] = [];
  for (const t of TARGETS) {
    const result: SiteResult = {
      id: t.id,
      url: t.url,
      title: "",
      blocked: false,
      screenshot: "",
      textSnippet: "",
    };
    try {
      await page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      if (t.settleMs) await page.waitForTimeout(t.settleMs);
      result.title = await page.title().catch(() => "");
      const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      result.textSnippet = text.slice(0, 2000);
      result.blocked = isBlocked(t, text);
      const shot = path.join(outDir, `${t.id}.png`);
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      result.screenshot = shot;
    } catch (err) {
      result.error = (err as Error).message;
    }
    log.info(SCOPE, `site ${t.id}: ${result.error ? `ERROR ${result.error}` : result.blocked ? "BLOCKED?" : "ok"}`);
    results.push(result);
  }
  return results;
}

export function newReportDir(engine: string, profileId: string): string {
  ensureDataDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(REPORTS_DIR, `${stamp}_${engine}_${profileId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
