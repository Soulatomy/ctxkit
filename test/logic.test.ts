import assert from "node:assert/strict";
import { generateFingerprint } from "../src/core/fingerprint/seed.js";
import { checkConsistency } from "../src/core/fingerprint/consistency.js";
import { scoreSignals, type SignalSnapshot } from "../src/check/runner.js";
import type { Fingerprint } from "../src/core/fingerprint/types.js";
import { totpCode, verifyTotp, generateTotpSecret, totpUri } from "../src/core/crypto/totp.js";

/** Build a snapshot that exactly matches the intended fingerprint. */
function perfectSnapshot(fp: Fingerprint): SignalSnapshot {
  return {
    userAgent: fp.userAgent,
    platform: fp.platform,
    languages: fp.languages.slice(),
    timezone: fp.timezone,
    locale: fp.locale,
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: fp.deviceMemory,
    screen: [fp.screen.width, fp.screen.height, fp.screen.colorDepth],
    inner: [fp.viewport.width, fp.viewport.height],
    webglVendor: fp.webgl.vendor,
    webglRenderer: fp.webgl.renderer,
    webdriver: false,
    pluginsLength: 5,
    canvasHash: "deadbeef",
    hasUAData: true,
  };
}

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    throw err;
  }
}

check("fingerprint is deterministic for the same profile id", () => {
  assert.deepEqual(generateFingerprint("abc"), generateFingerprint("abc"));
});

check("different profile ids produce different fingerprints", () => {
  assert.notDeepEqual(generateFingerprint("abc"), generateFingerprint("def"));
});

check("proxy country drives timezone/locale consistency", () => {
  const us = generateFingerprint("us", { server: "http://x", country: "US" });
  assert.equal(us.timezone, "America/New_York");
  assert.equal(us.locale, "en-US");
  assert.deepEqual(checkConsistency(us, { server: "http://x", country: "US" }), []);

  const de = generateFingerprint("de", { server: "http://x", country: "DE" });
  assert.equal(de.timezone, "Europe/Berlin");
  assert.equal(de.locale, "de-DE");
  assert.deepEqual(checkConsistency(de, { server: "http://x", country: "DE" }), []);
});

check("a matching snapshot scores 100", () => {
  const fp = generateFingerprint("score", { server: "http://x", country: "GB" });
  assert.equal(scoreSignals(fp, perfectSnapshot(fp)).score, 100);
});

check("leaks are detected and lower the score", () => {
  const fp = generateFingerprint("score", { server: "http://x", country: "GB" });
  const leaky: SignalSnapshot = { ...perfectSnapshot(fp), webdriver: true, platform: "Linux x86_64", timezone: "UTC" };
  const { score, checks } = scoreSignals(fp, leaky);
  assert.ok(score < 100, "score must drop");
  const failed = new Set(checks.filter((c) => !c.ok).map((c) => c.field));
  assert.ok(failed.has("webdriver-hidden"));
  assert.ok(failed.has("platform"));
  assert.ok(failed.has("timezone"));
});

check("android fingerprint is mobile-coherent", () => {
  const fp = generateFingerprint("and", undefined, { os: "android" });
  assert.equal(fp.platform, "Linux armv8l");
  assert.ok(/Android/.test(fp.userAgent));
  assert.equal(fp.maxTouchPoints, 5);
  assert.equal(fp.uaMetadata?.mobile, true);
  assert.deepEqual(checkConsistency(fp), []);
});

check("ios fingerprint has no UA client hints", () => {
  const fp = generateFingerprint("ios", undefined, { os: "ios" });
  assert.equal(fp.uaMetadata, null);
  assert.ok(/iPhone/.test(fp.userAgent));
  assert.equal(fp.maxTouchPoints, 5);
  assert.deepEqual(checkConsistency(fp), []);
});

check("TOTP matches the RFC 6238 test vector", () => {
  // base32 of the ASCII secret "12345678901234567890"
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totpCode(secret, 59_000, 8), "94287082");
});

check("TOTP generate + verify", () => {
  const secret = generateTotpSecret();
  const code = totpCode(secret);
  assert.ok(/^\d{6}$/.test(code));
  assert.ok(verifyTotp(secret, code));
  assert.ok(!verifyTotp(secret, "000000"));
  assert.ok(totpUri(secret, "me@host").startsWith("otpauth://totp/"));
});

console.log(`\n${passed} logic tests passed`);
