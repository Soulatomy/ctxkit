import type { Browser, BrowserContext, Page } from "playwright-core";
import type { EngineCapabilities, EngineSession, InjectionHost, LaunchRequest } from "../types.js";
import type { OS } from "../../core/fingerprint/types.js";
import { log } from "../../core/logger.js";

const SCOPE = "engine:camoufox";

const OS_MAP: Record<OS, string> = {
  windows: "windows",
  macos: "macos",
  linux: "linux",
  // Camoufox only models desktop OSes; map mobile to the closest desktop.
  android: "linux",
  ios: "macos",
};

/**
 * camoufox: Firefox fork that injects the fingerprint at the C++ level.
 *
 * This adapter is intentionally thin: Camoufox owns identity generation (via
 * fpgen), so we hand it the OS and geo hints rather than our own Fingerprint.
 * Keep it behind InjectionHost so it can serve as the "gold standard" baseline
 * the chrome-lite engine is measured against.
 */
export class CamoufoxHost implements InjectionHost {
  readonly name = "camoufox" as const;

  readonly capabilities: EngineCapabilities = {
    nativeFingerprint: true,
    jsInjection: false,
    persistentContext: false,
    customProxy: true,
    description:
      "Firefox fork with C++-level fingerprint injection (fpgen identities). Reference/fallback baseline, not the product main line.",
  };

  async isAvailable(): Promise<{ ok: boolean; reason?: string }> {
    try {
      await import("@camoufox/camoufox");
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: `@camoufox/camoufox not installed or failed to load: ${(err as Error).message}. Try: npm i @camoufox/camoufox`,
      };
    }
  }

  async launch(req: LaunchRequest): Promise<EngineSession> {
    const mod = (await import("@camoufox/camoufox")) as unknown as {
      Camoufox: (opts: Record<string, unknown>) => Promise<Browser>;
    };

    const os = OS_MAP[req.fingerprint.os];
    log.info(SCOPE, `launching profile=${req.profileId} os=${os} headless=${req.headless}`);

    const browser = (await mod.Camoufox({
      headless: req.headless,
      os,
      humanize: true,
      // When a proxy with a country is set, let Camoufox align geo/timezone too.
      proxy: req.proxy ? { server: req.proxy.server, username: req.proxy.username, password: req.proxy.password } : undefined,
      geoip: Boolean(req.proxy?.country),
      args: req.extraArgs ?? [],
    })) as unknown as Browser;

    const context = browser.contexts()[0] as unknown as BrowserContext;
    const page = (await browser.newPage()) as unknown as Page;
    if (req.startUrl) await page.goto(req.startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

    return {
      engine: this.name,
      fingerprint: req.fingerprint,
      browser,
      context,
      page,
      launchArgs: [],
      close: async () => {
        await browser.close().catch(() => {});
      },
    };
  }
}
