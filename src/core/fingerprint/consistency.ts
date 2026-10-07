import type { Fingerprint } from "./types.js";
import type { ProxyConfig } from "../proxy/types.js";

export interface GeoProfile {
  timezone: string;
  locale: string;
  languages: string[];
}

/**
 * Minimal country -> geo mapping so timezone/locale line up with the proxy exit.
 * Extend as needed; a mismatch between exit IP geo and browser timezone is one of
 * the easiest signals for a WAF to catch.
 */
const GEO: Record<string, GeoProfile> = {
  US: { timezone: "America/New_York", locale: "en-US", languages: ["en-US", "en"] },
  CA: { timezone: "America/Toronto", locale: "en-CA", languages: ["en-CA", "en"] },
  GB: { timezone: "Europe/London", locale: "en-GB", languages: ["en-GB", "en"] },
  DE: { timezone: "Europe/Berlin", locale: "de-DE", languages: ["de-DE", "de"] },
  FR: { timezone: "Europe/Paris", locale: "fr-FR", languages: ["fr-FR", "fr"] },
  NL: { timezone: "Europe/Amsterdam", locale: "nl-NL", languages: ["nl-NL", "nl"] },
  ES: { timezone: "Europe/Madrid", locale: "es-ES", languages: ["es-ES", "es"] },
  IT: { timezone: "Europe/Rome", locale: "it-IT", languages: ["it-IT", "it"] },
  PL: { timezone: "Europe/Warsaw", locale: "pl-PL", languages: ["pl-PL", "pl"] },
  RU: { timezone: "Europe/Moscow", locale: "ru-RU", languages: ["ru-RU", "ru"] },
  SG: { timezone: "Asia/Singapore", locale: "en-SG", languages: ["en-SG", "en"] },
  JP: { timezone: "Asia/Tokyo", locale: "ja-JP", languages: ["ja-JP", "ja"] },
  KR: { timezone: "Asia/Seoul", locale: "ko-KR", languages: ["ko-KR", "ko"] },
  CN: { timezone: "Asia/Shanghai", locale: "zh-CN", languages: ["zh-CN", "zh"] },
  HK: { timezone: "Asia/Hong_Kong", locale: "zh-HK", languages: ["zh-HK", "zh"] },
  TW: { timezone: "Asia/Taipei", locale: "zh-TW", languages: ["zh-TW", "zh"] },
  IN: { timezone: "Asia/Kolkata", locale: "en-IN", languages: ["en-IN", "en"] },
  AU: { timezone: "Australia/Sydney", locale: "en-AU", languages: ["en-AU", "en"] },
  BR: { timezone: "America/Sao_Paulo", locale: "pt-BR", languages: ["pt-BR", "pt"] },
  MX: { timezone: "America/Mexico_City", locale: "es-MX", languages: ["es-MX", "es"] },
  AE: { timezone: "Asia/Dubai", locale: "en-AE", languages: ["en-AE", "en"] },
};

export function deriveGeoByCountry(country: string): GeoProfile | undefined {
  return GEO[country.toUpperCase()];
}

export interface ConsistencyIssue {
  field: string;
  message: string;
}

/**
 * Sanity-check that a fingerprint is internally coherent. This is the seed of
 * your CI gate: run it before every release of the fingerprint engine.
 */
export function checkConsistency(fp: Fingerprint, proxy?: ProxyConfig): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];

  if (proxy?.country) {
    const geo = deriveGeoByCountry(proxy.country);
    if (geo) {
      if (fp.timezone !== geo.timezone) {
        issues.push({ field: "timezone", message: `fingerprint ${fp.timezone} != proxy country ${proxy.country} ${geo.timezone}` });
      }
      if (!fp.languages.some((l) => l.toLowerCase().startsWith(geo.locale.slice(0, 2)))) {
        issues.push({ field: "languages", message: `languages ${fp.languages.join(",")} do not match proxy locale ${geo.locale}` });
      }
    }
  }

  if (fp.os === "macos" && !/Macintosh/.test(fp.userAgent)) {
    issues.push({ field: "userAgent", message: "macOS profile but UA is not Macintosh" });
  }
  if (fp.os === "windows" && !/Windows NT/.test(fp.userAgent)) {
    issues.push({ field: "userAgent", message: "Windows profile but UA has no Windows NT" });
  }
  if (fp.os === "android" && !/Android/.test(fp.userAgent)) {
    issues.push({ field: "userAgent", message: "Android profile but UA has no Android" });
  }
  if (fp.os === "ios" && !/iPhone|iPad/.test(fp.userAgent)) {
    issues.push({ field: "userAgent", message: "iOS profile but UA is not iPhone/iPad" });
  }
  if ((fp.os === "android" || fp.os === "ios") && fp.maxTouchPoints === 0) {
    issues.push({ field: "maxTouchPoints", message: "mobile profile should report touch points" });
  }
  if (fp.viewport.width > fp.screen.width || fp.viewport.height > fp.screen.height) {
    issues.push({ field: "viewport", message: "viewport must not exceed screen" });
  }
  if (fp.webgl.renderer.length === 0) {
    issues.push({ field: "webgl", message: "empty WebGL renderer" });
  }

  return issues;
}
