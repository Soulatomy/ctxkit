import type { Fingerprint } from "./types.js";

/**
 * Build a page-context init script that applies the fingerprint.
 *
 * NOTE: this is the deliberately thin, Chromium-side injection layer. It is the
 * part you will iteratively harden (or replace with native patches) — the
 * anti-detect work that cannot be fully outsourced. Everything else in this
 * project is plumbing. The engine adapters only feed this script (chrome-lite)
 * or hand the identity to the kernel (camoufox).
 */
export function buildInjectScript(fp: Fingerprint): string {
  const FP = JSON.stringify(fp);
  return `(() => {
  "use strict";
  const FP = ${FP};

  // ---- native-function spoofing helpers -----------------------------------
  const nativeToString = Function.prototype.toString;
  const spoofed = new WeakMap();
  function markNative(fn, name) {
    try { spoofed.set(fn, "function " + (name || fn.name || "") + "() { [native code] }"); } catch (e) {}
    return fn;
  }
  Function.prototype.toString = markNative(function toString() {
    return spoofed.get(this) || nativeToString.call(this);
  }, "toString");

  function define(obj, prop, getter) {
    try {
      Object.defineProperty(obj, prop, { get: markNative(getter, "get " + prop), configurable: true });
    } catch (e) {}
  }

  const nav = Navigator.prototype;

  // ---- navigator ----------------------------------------------------------
  define(nav, "userAgent", () => FP.userAgent);
  define(nav, "appVersion", () => FP.userAgent.replace("Mozilla/", ""));
  define(nav, "platform", () => FP.platform);
  define(nav, "language", () => FP.languages[0]);
  define(nav, "languages", () => Object.freeze(FP.languages.slice()));
  define(nav, "hardwareConcurrency", () => FP.hardwareConcurrency);
  define(nav, "deviceMemory", () => FP.deviceMemory);
  define(nav, "webdriver", () => false);
  define(nav, "doNotTrack", () => FP.doNotTrack);
  define(nav, "maxTouchPoints", () => FP.maxTouchPoints);

  // userAgentData / client hints
  if (FP.uaMetadata && "userAgentData" in navigator) {
    const ua = FP.uaMetadata;
    const uad = {
      brands: Object.freeze(ua.brands.map((b) => Object.freeze({ ...b }))),
      mobile: ua.mobile,
      platform: ua.platform,
      getHighEntropyValues: markNative(async (hints) => {
        const out = { brands: ua.brands, mobile: ua.mobile, platform: ua.platform };
        if (hints.includes("platformVersion")) out.platformVersion = ua.platformVersion;
        if (hints.includes("architecture")) out.architecture = ua.architecture;
        if (hints.includes("bitness")) out.bitness = ua.bitness;
        if (hints.includes("fullVersionList")) out.fullVersionList = ua.fullVersionList;
        return out;
      }, "getHighEntropyValues"),
      toJSON() { return { brands: ua.brands, mobile: ua.mobile, platform: ua.platform }; },
    };
    define(nav, "userAgentData", () => uad);
  }

  // ---- screen / viewport --------------------------------------------------
  const scr = Screen.prototype;
  define(scr, "width", () => FP.screen.width);
  define(scr, "height", () => FP.screen.height);
  define(scr, "availWidth", () => FP.screen.width);
  define(scr, "availHeight", () => FP.screen.height - 40);
  define(scr, "colorDepth", () => FP.screen.colorDepth);
  define(scr, "pixelDepth", () => FP.screen.colorDepth);
  define(window, "innerWidth", () => FP.viewport.width);
  define(window, "innerHeight", () => FP.viewport.height);
  define(window, "outerWidth", () => FP.viewport.width);
  define(window, "outerHeight", () => FP.viewport.height + 80);

  // ---- timezone / locale --------------------------------------------------
  const origResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
  Intl.DateTimeFormat.prototype.resolvedOptions = markNative(function resolvedOptions() {
    const o = origResolved.call(this);
    o.timeZone = FP.timezone;
    o.locale = FP.locale;
    return o;
  }, "resolvedOptions");

  // ---- deterministic canvas noise ----------------------------------------
  // Seeded per profile so the same profile always produces the same hash.
  let cseed = FP.canvasNoiseSeed >>> 0;
  function rnd() {
    cseed |= 0; cseed = (cseed + 0x6d2b79f5) | 0;
    let t = Math.imul(cseed ^ (cseed >>> 15), 1 | cseed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = markNative(function getImageData() {
    const data = origGetImageData.apply(this, arguments);
    for (let i = 0; i < data.data.length; i += 4) {
      if (rnd() < 0.03) data.data[i] = (data.data[i] + 1) & 0xff;
    }
    return data;
  }, "getImageData");
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = markNative(function toDataURL() {
    const ctx = this.getContext("2d");
    if (ctx) { try { const id = ctx.getImageData(0, 0, this.width, this.height); ctx.putImageData(id, 0, 0); } catch (e) {} }
    return origToDataURL.apply(this, arguments);
  }, "toDataURL");

  // ---- WebGL vendor / renderer -------------------------------------------
  const origGetParameter = WebGLRenderingContext.prototype.getParameter;
  const origGetParameter2 = (window.WebGL2RenderingContext || {}).prototype
    ? WebGL2RenderingContext.prototype.getParameter : null;
  function wrappedGetParameter(orig) {
    return markNative(function getParameter(p) {
      if (p === 37445) return FP.webgl.vendor;   // UNMASKED_VENDOR_WEBGL
      if (p === 37446) return FP.webgl.renderer; // UNMASKED_RENDERER_WEBGL
      return orig.call(this, p);
    }, "getParameter");
  }
  WebGLRenderingContext.prototype.getParameter = wrappedGetParameter(origGetParameter);
  if (origGetParameter2) WebGL2RenderingContext.prototype.getParameter = wrappedGetParameter(origGetParameter2);
})();`;
}
