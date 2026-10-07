import type { Fingerprint, FingerprintOverrides, OS } from "./types.js";
import type { ProxyConfig } from "../proxy/types.js";
import { deriveGeoByCountry } from "./consistency.js";

/* -------------------------------------------------------------------------- */
/* Deterministic PRNG                                                          */
/* -------------------------------------------------------------------------- */

function hashCode(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32: tiny, fast, deterministic. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

function weightedPick<T>(rng: () => number, entries: readonly [T, number][]): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [value, w] of entries) {
    r -= w;
    if (r <= 0) return value;
  }
  return entries[entries.length - 1]![0];
}

/* -------------------------------------------------------------------------- */
/* Plausible value pools                                                       */
/* -------------------------------------------------------------------------- */

const CHROME_MAJOR = 131;
const CHROME_FULL = "131.0.6778.86";

const PLATFORM_BY_OS: Record<OS, string> = {
  windows: "Win32",
  macos: "MacIntel",
  linux: "Linux x86_64",
  android: "Linux armv8l",
  ios: "iPhone",
};

const MOBILE_OSES: readonly OS[] = ["android", "ios"];
function isMobile(os: OS): boolean {
  return MOBILE_OSES.includes(os);
}

// Real-world OS weighting (Windows dominates; mobile is a minority).
const OS_WEIGHTS: readonly [OS, number][] = [
  ["windows", 62],
  ["macos", 14],
  ["linux", 8],
  ["android", 10],
  ["ios", 6],
];

const SCREENS_BY_OS: Record<OS, readonly { width: number; height: number; w: number }[]> = {
  windows: [
    { width: 1920, height: 1080, w: 58 },
    { width: 1536, height: 864, w: 12 },
    { width: 2560, height: 1440, w: 12 },
    { width: 1366, height: 768, w: 12 },
    { width: 3840, height: 2160, w: 6 },
  ],
  macos: [
    { width: 1440, height: 900, w: 35 },
    { width: 1512, height: 982, w: 30 },
    { width: 1728, height: 1117, w: 20 },
    { width: 2560, height: 1440, w: 15 },
  ],
  linux: [
    { width: 1920, height: 1080, w: 70 },
    { width: 1366, height: 768, w: 30 },
  ],
  android: [
    { width: 412, height: 915, w: 40 },
    { width: 360, height: 800, w: 30 },
    { width: 393, height: 873, w: 30 },
  ],
  ios: [
    { width: 390, height: 844, w: 45 },
    { width: 428, height: 926, w: 30 },
    { width: 375, height: 812, w: 25 },
  ],
};

const GPUS_BY_OS: Record<OS, readonly { vendor: string; renderer: string; w: number }[]> = {
  windows: [
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)", w: 30 },
    { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)", w: 25 },
    { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)", w: 20 },
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)", w: 25 },
  ],
  macos: [
    { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, Apple M1, OpenGL 4.1)", w: 45 },
    { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, Apple M2, OpenGL 4.1)", w: 35 },
    { vendor: "Google Inc. (Intel Inc.)", renderer: "ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 640, OpenGL 4.1)", w: 20 },
  ],
  linux: [
    { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6 (Core Profile) Mesa 22.0.5)", w: 50 },
    { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon RX 5700 (NAVI10, DRM 3.42.0, 5.16.0) (LLVM 13.0.0), OpenGL 4.6)", w: 50 },
  ],
  android: [
    { vendor: "Qualcomm", renderer: "Adreno (TM) 640", w: 40 },
    { vendor: "ARM", renderer: "Mali-G78 MP14", w: 30 },
    { vendor: "Qualcomm", renderer: "Adreno (TM) 730", w: 30 },
  ],
  ios: [
    { vendor: "Apple Inc.", renderer: "Apple GPU", w: 100 },
  ],
};

const DESKTOP_CORES = [4, 8, 8, 8, 12, 16] as const;
const DESKTOP_MEMORY = [4, 8, 8, 8, 16] as const;
const MOBILE_CORES = [4, 6, 8] as const;
const MOBILE_MEMORY = [2, 4, 4, 8] as const;

function buildUAMetadata(os: OS): Fingerprint["uaMetadata"] {
  // iOS Chrome is WebKit-based and exposes no UA client hints.
  if (os === "ios") return null;
  const mobile = isMobile(os);
  const platform = os === "windows" ? "Windows" : os === "macos" ? "macOS" : os === "android" ? "Android" : "Linux";
  const platformVersion = os === "windows" ? "15.0.0" : os === "macos" ? "14.5.0" : os === "android" ? "13.0.0" : "6.6.0";
  const fullVersionList = [
    { brand: "Chromium", version: CHROME_FULL },
    { brand: "Google Chrome", version: CHROME_FULL },
    { brand: "Not?A_Brand", version: "24.0.0.0" },
  ];
  return {
    brands: [
      { brand: "Chromium", version: String(CHROME_MAJOR) },
      { brand: "Google Chrome", version: String(CHROME_MAJOR) },
      { brand: "Not?A_Brand", version: "24" },
    ],
    platform,
    platformVersion,
    mobile,
    architecture: mobile ? "" : "x86",
    bitness: mobile ? "" : "64",
    fullVersionList,
  };
}

function buildUserAgent(os: OS): string {
  const base = `Mozilla/5.0 `;
  switch (os) {
    case "windows":
      return `${base}(Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL} Safari/537.36`;
    case "macos":
      return `${base}(Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL} Safari/537.36`;
    case "linux":
      return `${base}(X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL} Safari/537.36`;
    case "android":
      return `${base}(Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL} Mobile Safari/537.36`;
    case "ios":
      return `${base}(iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${CHROME_FULL} Mobile/15E148 Safari/604.1`;
  }
}

/* -------------------------------------------------------------------------- */
/* Generator                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Generate a coherent fingerprint deterministically from a profile id.
 * Same id + same overrides => same fingerprint, forever.
 */
export function generateFingerprint(
  profileId: string,
  proxy?: ProxyConfig,
  overrides: FingerprintOverrides = {},
): Fingerprint {
  const seed = `fb:${profileId}`;
  const rng = mulberry32(hashCode(seed));

  const os: OS = overrides.os ?? weightedPick(rng, OS_WEIGHTS);

  const screenEntry = weightedPick(
    rng,
    SCREENS_BY_OS[os].map((s) => [s, s.w] as const),
  );
  const screen = overrides.screen ?? {
    width: screenEntry.width,
    height: screenEntry.height,
    colorDepth: 24,
  };
  // Viewport is the window inner size: slightly smaller than the screen.
  // Mobile viewports fill the width and leave room for browser chrome.
  const viewport = isMobile(os)
    ? { width: screen.width, height: screen.height - Math.floor(60 + rng() * 60) }
    : { width: screen.width - Math.floor(80 + rng() * 120), height: screen.height - Math.floor(140 + rng() * 120) };

  const gpu = weightedPick(
    rng,
    GPUS_BY_OS[os].map((g) => [g, g.w] as const),
  );

  const geo = proxy?.country ? deriveGeoByCountry(proxy.country) : undefined;
  const timezone = overrides.timezone ?? proxy?.timezone ?? geo?.timezone ?? pick(rng, ["America/New_York", "Europe/London", "Europe/Berlin", "Asia/Singapore"]);
  const locale = overrides.locale ?? geo?.locale ?? "en-US";
  const languages = overrides.languages ?? geo?.languages ?? ["en-US", "en"];
  const mobile = isMobile(os);

  return {
    seed,
    os,
    userAgent: buildUserAgent(os),
    platform: PLATFORM_BY_OS[os],
    uaMetadata: buildUAMetadata(os),
    languages,
    timezone,
    locale,
    screen,
    viewport,
    hardwareConcurrency: overrides.hardwareConcurrency ?? pick(rng, mobile ? MOBILE_CORES : DESKTOP_CORES),
    deviceMemory: overrides.deviceMemory ?? pick(rng, mobile ? MOBILE_MEMORY : DESKTOP_MEMORY),
    webgl: { vendor: gpu.vendor, renderer: gpu.renderer },
    canvasNoiseSeed: Math.floor(rng() * 1e9),
    audioNoiseSeed: Math.floor(rng() * 1e9),
    doNotTrack: pick(rng, ["1", "0", null] as const),
    colorScheme: rng() > 0.3 ? "light" : "dark",
    maxTouchPoints: mobile ? 5 : 0,
  };
}

/**
 * Reverse a fingerprint into the overrides that reproduce it. Used by
 * profile export so a re-imported profile keeps the same identity.
 */
export function fingerprintToOverrides(fp: Fingerprint): FingerprintOverrides {
  return {
    os: fp.os,
    timezone: fp.timezone,
    locale: fp.locale,
    languages: fp.languages,
    screen: fp.screen,
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: fp.deviceMemory,
  };
}
