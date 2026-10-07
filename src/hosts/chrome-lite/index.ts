import fs from "node:fs";
import { chromium } from "patchright";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { EngineCapabilities, EngineSession, InjectionHost, LaunchRequest } from "../types.js";
import { buildInjectScript } from "../../core/fingerprint/inject.js";
import { toPlaywrightProxy } from "../../core/proxy/types.js";
import { log } from "../../core/logger.js";

const SCOPE = "engine:chrome-lite";

/**
 * chrome-lite: stock Chromium driven through patchright (Patched Playwright).
 *
 * What this buys you for free from the open-source ecosystem:
 *   - automation-leak fixes (Runtime.enable, navigator.webdriver, CLI flags)
 * Runtime + kernel-level fingerprint work is done by OUR init script (thin,
 * replaceable) and, later, optionally by a patched Chromium host.
 */
export class ChromeLiteHost implements InjectionHost {
  readonly name = "chrome-lite" as const;

  readonly capabilities: EngineCapabilities = {
    nativeFingerprint: false,
    jsInjection: true,
    persistentContext: true,
    customProxy: true,
    description:
      "Stock Chromium + patchright (automation-leak patches) + JS fingerprint init script. Product main line.",
  };

  async isAvailable(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const exe = chromium.executablePath();
      if (exe && !fs.existsSync(exe)) {
        return { ok: false, reason: `Chromium not downloaded yet (run: npx patchright install chromium). Expected at ${exe}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  async launch(req: LaunchRequest): Promise<EngineSession> {
    const { fingerprint: fp, proxy } = req;
    fs.mkdirSync(req.userDataDir, { recursive: true });

    const args = [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      // Chrome 137+ refuses software WebGL unless explicitly allowed. On a
      // GPU-less host (CI / containers) this is required, otherwise
      // getContext('webgl') returns null — itself a strong fingerprint signal.
      // On real GPUs this flag is a harmless no-op.
      "--enable-unsafe-swiftshader",
      `--lang=${fp.locale}`,
      ...(req.extensions && req.extensions.length
        ? [`--disable-extensions-except=${req.extensions.join(",")}`, `--load-extension=${req.extensions.join(",")}`]
        : []),
      ...(req.extraArgs ?? []),
    ];

    log.info(SCOPE, `launching profile=${req.profileId} headless=${req.headless} proxy=${proxy ? proxy.server : "direct"}`);

    const context = (await chromium.launchPersistentContext(req.userDataDir, {
      headless: req.headless,
      args,
      proxy: proxy ? toPlaywrightProxy(proxy) : undefined,
      locale: fp.locale,
      timezoneId: fp.timezone,
      userAgent: fp.userAgent,
      viewport: fp.viewport,
      screen: { width: fp.screen.width, height: fp.screen.height },
      colorScheme: fp.colorScheme,
      deviceScaleFactor: 1,
    })) as unknown as BrowserContext;

    // Init script: runs before any page script in every frame. patchright routes
    // this without Runtime.enable, so it does not reintroduce the CDP leak.
    await context.addInitScript({ content: buildInjectScript(fp) });

    const page = context.pages()[0] ?? (await context.newPage());
    if (req.startUrl) await page.goto(req.startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

    const browser = context.browser() as unknown as Browser;
    return {
      engine: this.name,
      fingerprint: fp,
      browser,
      context,
      page: page as unknown as Page,
      launchArgs: args,
      close: async () => {
        // Never let a stuck browser teardown block a job/CI run.
        await Promise.race([
          context.close().catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, 15000)),
        ]);
      },
    };
  }
}
