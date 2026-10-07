import assert from "node:assert/strict";
import { ProfileStore } from "../../src/core/profile/store.js";
import { ChromeLiteHost } from "../../src/hosts/chrome-lite/index.js";
import { startLocalPageServer } from "../../src/check/local-server.js";
import { collectSignalsMainWorld } from "../../src/check/runner.js";

/**
 * Integration test for per-profile persistence and isolation.
 * Requires a real browser; run via `npm run test:integration` under xvfb.
 * Skips (exit 0) if the engine is unavailable so CI stays green on stripped images.
 */
const headless = process.env.FB_HEADLESS !== "0";
const COOKIE = "fb-persist";
const VALUE = "abc123";

async function main(): Promise<void> {
  const store = new ProfileStore();
  const profile = store.create({ name: `persist-${Date.now()}`, engine: "chrome-lite" });
  const userDataDir = store.userDataDir(profile.id);
  console.log(`profile ${profile.id} userDataDir=${userDataDir}`);

  const host = new ChromeLiteHost();
  const avail = await host.isAvailable();
  if (!avail.ok) {
    console.log(`SKIP: chrome-lite unavailable: ${avail.reason}`);
    return;
  }

  const server = await startLocalPageServer();
  try {
    // ---- session 1: write state + capture fingerprint --------------------
    const s1 = await host.launch({
      profileId: profile.id,
      fingerprint: profile.fingerprint,
      userDataDir,
      headless,
      startUrl: server.url,
    });
    await s1.context.addCookies([
      // expires is required: without it Chrome treats this as a session cookie
      // and intentionally discards it on close.
      { name: COOKIE, value: VALUE, url: server.url, expires: Math.floor(Date.now() / 1000) + 3600 },
    ]);
    await s1.page.evaluate(([k, v]) => localStorage.setItem(k, v), [COOKIE, VALUE] as const);
    const fp1 = await collectSignalsMainWorld(s1.page, server.url);
    await s1.close();
    console.log("session 1: wrote cookie + localStorage, captured fingerprint");

    // ---- store reload: fingerprint must be stable ------------------------
    const store2 = new ProfileStore();
    const reloaded = store2.get(profile.id);
    assert.ok(reloaded, "profile must persist across store reload");
    assert.deepEqual(reloaded.fingerprint, profile.fingerprint, "fingerprint must not change on reload");
    assert.equal(store2.userDataDir(profile.id), userDataDir, "userDataDir must be stable");

    // ---- session 2: reopen same user-data-dir ----------------------------
    const s2 = await host.launch({
      profileId: profile.id,
      fingerprint: profile.fingerprint,
      userDataDir,
      headless,
      startUrl: server.url,
    });
    const cookies = await s2.context.cookies(server.url);
    const ls = await s2.page.evaluate((k) => localStorage.getItem(k), COOKIE);
    const fp2 = await collectSignalsMainWorld(s2.page, server.url);
    await s2.close();

    assert.equal(cookies.find((c) => c.name === COOKIE)?.value, VALUE, "cookie must survive reopen");
    assert.equal(ls, VALUE, "localStorage must survive reopen");
    assert.deepEqual(fp2, fp1, "fingerprint must not drift between sessions");
    console.log("session 2: cookie + localStorage persisted, fingerprint identical");

    // ---- isolation: a different profile must not see this state ----------
    const other = store.create({ name: `iso-${Date.now()}`, engine: "chrome-lite" });
    const s3 = await host.launch({
      profileId: other.id,
      fingerprint: other.fingerprint,
      userDataDir: store.userDataDir(other.id),
      headless,
      startUrl: server.url,
    });
    const otherCookies = await s3.context.cookies(server.url);
    const otherLs = await s3.page.evaluate((k) => localStorage.getItem(k), COOKIE);
    await s3.close();
    assert.equal(otherCookies.find((c) => c.name === COOKIE), undefined, "profiles must be cookie-isolated");
    assert.equal(otherLs, null, "profiles must be storage-isolated");
    console.log("isolation: second profile sees none of the first profile's state");
  } finally {
    await server.close();
  }

  console.log("\nintegration persistence tests passed");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
