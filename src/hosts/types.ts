import type { Browser, BrowserContext, Page } from "playwright-core";
import type { Fingerprint } from "../core/fingerprint/types.js";
import type { ProxyConfig } from "../core/proxy/types.js";

export type EngineName = "chrome-lite" | "camoufox";

export interface EngineCapabilities {
  /** Spoofs at kernel/C++ level (undetectable via JS inspection). */
  nativeFingerprint: boolean;
  /** Applies a JS init-script injection layer. */
  jsInjection: boolean;
  /** Supports a persistent user-data-dir (real per-profile isolation). */
  persistentContext: boolean;
  customProxy: boolean;
  /** Shown in `engines` command output. */
  description: string;
}

export interface LaunchRequest {
  profileId: string;
  fingerprint: Fingerprint;
  proxy?: ProxyConfig;
  userDataDir: string;
  headless: boolean;
  startUrl?: string;
  extraArgs?: string[];
  /** Unpacked extension directories to load (Chromium engines). */
  extensions?: string[];
}

export interface EngineSession {
  engine: EngineName;
  fingerprint: Fingerprint;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  launchArgs: string[];
  close(): Promise<void>;
}

/**
 * The single seam that keeps this architecture "final-shaped":
 * today there are two Playwright-speaking engines; a future native/patched
 * Chromium host is just one more implementation.
 */
export interface InjectionHost {
  readonly name: EngineName;
  readonly capabilities: EngineCapabilities;
  isAvailable(): Promise<{ ok: boolean; reason?: string }>;
  launch(req: LaunchRequest): Promise<EngineSession>;
}
