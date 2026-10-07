import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

/** Isolate test data from the developer's real data dir. */
process.env.FB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fb-api-"));

const { startServer } = await import("../src/server/index.js");

interface Res<T = any> {
  status: number;
  body: T;
}

async function req<T = any>(base: string, method: string, route: string, body?: unknown, token?: string): Promise<Res<T>> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(base + route, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let passed = 0;
function check(name: string, cond: boolean): void {
  if (!cond) throw new Error(`assertion failed: ${name}`);
  passed++;
  console.log(`  ok  ${name}`);
}

const server = await startServer({ port: 0 });
const base = server.url;
console.log(`api test server: ${base}`);

try {
  const health = await req(base, "GET", "/api/health");
  check("health responds ok", health.status === 200 && health.body.ok === true);

  const engines = await req(base, "GET", "/api/engines");
  check("engines listed", engines.status === 200 && Array.isArray(engines.body) && engines.body.length >= 1);
  check("chrome-lite engine present", engines.body.some((e: any) => e.name === "chrome-lite"));

  // create profile
  const created = await req(base, "POST", "/api/profiles", { name: "test-1", engine: "chrome-lite", overrides: { os: "windows" } });
  check("profile created", created.status === 200 && typeof created.body.id === "string");
  const profileId = created.body.id as string;
  check("profile os override applied", created.body.os === "windows");

  // validation
  const bad = await req(base, "POST", "/api/profiles", {});
  check("missing name rejected (400)", bad.status === 400);

  // list + detail
  const list = await req(base, "GET", "/api/profiles");
  check("profile appears in list", list.body.some((p: any) => p.id === profileId));
  const detail = await req(base, "GET", `/api/profiles/${profileId}`);
  check("profile detail has fingerprint", detail.status === 200 && detail.body.fingerprint?.userAgent?.includes("Windows"));
  check("profile starts stopped", detail.body.running === false);

  // patch
  const patched = await req(base, "PATCH", `/api/profiles/${profileId}`, { name: "test-renamed" });
  check("profile renamed", patched.status === 200 && patched.body.name === "test-renamed");

  // proxies
  const proxy = await req(base, "POST", "/api/proxies", { server: "http://1.2.3.4:8080", name: "p1", country: "us" });
  check("proxy created + country upper-cased", proxy.status === 200 && proxy.body.country === "US");
  const proxyId = proxy.body.id as string;

  const bind = await req(base, "PATCH", `/api/profiles/${profileId}`, { proxyId });
  check("proxy bound to profile", bind.status === 200 && bind.body.proxyId === proxyId);
  const afterBind = await req(base, "GET", "/api/profiles");
  check("profile shows bound proxy", afterBind.body.find((p: any) => p.id === profileId)?.proxy?.includes("1.2.3.4:8080"));

  // unbind
  const unbind = await req(base, "PATCH", `/api/profiles/${profileId}`, { proxyId: null });
  check("proxy unbound", unbind.status === 200 && unbind.body.proxyId === null);

  // delete
  const delProxy = await req(base, "DELETE", `/api/proxies/${proxyId}`);
  check("proxy deleted", delProxy.status === 200);
  const delProfile = await req(base, "DELETE", `/api/profiles/${profileId}`);
  check("profile deleted", delProfile.status === 200);
  const gone = await req(base, "GET", `/api/profiles/${profileId}`);
  check("deleted profile is 404", gone.status === 404);

  // unknown route
  const unknown = await req(base, "GET", "/api/nope");
  check("unknown route is 404", unknown.status === 404);

  // sessions empty
  const sessions = await req(base, "GET", "/api/sessions");
  check("sessions list empty", sessions.status === 200 && sessions.body.length === 0);

  // settings
  const settings0 = await req(base, "GET", "/api/settings");
  check("settings have defaults", settings0.status === 200 && settings0.body.defaultEngine === "chrome-lite");
  check("settings default onboarded=false", settings0.body.onboarded === false);
  const settings1 = await req(base, "PATCH", "/api/settings", { defaultOs: "linux", headlessByDefault: true, onboarded: true });
  check("settings updated", settings1.body.defaultOs === "linux" && settings1.body.headlessByDefault === true && settings1.body.onboarded === true);
  check("engine install rejects unknown engine", (await req(base, "POST", "/api/engines/nope/install", {})).status === 404);
  const viaDefault = await req(base, "POST", "/api/profiles", { name: "default-os" });
  check("create applies default OS", viaDefault.body.os === "linux");

  // batch create
  const batch = await req(base, "POST", "/api/profiles/batch", {
    count: 3, namePattern: "b-{n}", tags: ["batch"], overrides: { os: "windows" },
  });
  check("batch created 3 named profiles", batch.status === 200 && batch.body.created === 3 && batch.body.profiles[0].name === "b-1");
  check("batch applied tags", batch.body.profiles[0].tags.includes("batch"));
  check("batch applied overrides", batch.body.profiles[0].os === "windows");
  const batchId = batch.body.profiles[0].id as string;

  // tags + notes
  const tagged = await req(base, "PATCH", `/api/profiles/${batchId}`, { tags: ["a", "b"], notes: "hello" });
  check("tags + notes patched", tagged.body.tags.join(",") === "a,b" && tagged.body.notes === "hello");

  // duplicate
  const dup = await req(base, "POST", `/api/profiles/${batchId}/duplicate`, {});
  check("duplicate creates a new profile", dup.status === 200 && dup.body.id !== batchId);

  // export / import
  const exported = await req(base, "GET", `/api/export?ids=${batchId}`);
  check("export returns the selected profile", exported.body.profiles.length === 1 && exported.body.profiles[0].name === "b-1");
  const imported = await req(base, "POST", "/api/import", exported.body);
  check("import recreates the profile", imported.body.imported === 1);
  check("imported profile keeps overrides", imported.body.profiles[0].os === "windows");

  // folder + status
  const foldered = await req(base, "POST", "/api/profiles", { name: "foldered", folder: "Amazon", status: "warmup" });
  check("folder + status stored", foldered.body.folder === "Amazon" && foldered.body.status === "warmup");
  check("export includes folder", (await req(base, "GET", `/api/export?ids=${foldered.body.id}`)).body.profiles[0].folder === "Amazon");

  // bulk operations (delete is browser-free)
  const bulkIds = (await req(base, "POST", "/api/profiles/batch", { count: 2, namePattern: "del-{n}" })).body.profiles.map((p: any) => p.id);
  const bulk = await req(base, "POST", "/api/profiles/bulk", { action: "delete", ids: bulkIds });
  check("bulk delete succeeds", bulk.status === 200 && bulk.body.failed === 0 && bulk.body.total === 2);
  check("bulk-deleted profile is gone", (await req(base, "GET", `/api/profiles/${bulkIds[0]}`)).status === 404);
  check("invalid bulk action rejected", (await req(base, "POST", "/api/profiles/bulk", { action: "nope", ids: ["x"] })).status === 400);

  // activity log
  const activity = await req(base, "GET", "/api/activity");
  check("activity records events", activity.status === 200 && activity.body.some((e: any) => e.type === "profile.create"));
  check("activity cleared", (await req(base, "DELETE", "/api/activity")).body.cleared === true);
  check("activity empty after clear", (await req(base, "GET", "/api/activity")).body.length === 0);

  // secret encryption
  const { encryptSecret, decryptSecret } = await import("../src/core/crypto/secrets.js");
  const cipher = encryptSecret("s3cr3t");
  check("secret encrypted + decrypts", cipher.startsWith("enc:") && cipher !== "s3cr3t" && decryptSecret(cipher) === "s3cr3t");
  check("plaintext passes through decrypt", decryptSecret("plain") === "plain");

  const secProxy = await req(base, "POST", "/api/proxies", { server: "http://9.9.9.9:1", name: "sec", password: "topsecret" });
  const rawProxies = fs.readFileSync(path.join(process.env.FB_DATA_DIR as string, "proxies.json"), "utf8");
  check("proxy password encrypted on disk", !rawProxies.includes("topsecret") && rawProxies.includes("enc:"));
  check("proxy password masked in API", (await req(base, "GET", "/api/proxies")).body.find((p: any) => p.id === secProxy.body.id)?.password === "***");

  // extensions
  const extProfile = await req(base, "POST", "/api/profiles", { name: "ext", extensions: ["/tmp/ext-a", "/tmp/ext-b"] });
  check("extensions stored", extProfile.body.extensions.length === 2);
  check("export includes extensions", (await req(base, "GET", `/api/export?ids=${extProfile.body.id}`)).body.profiles[0].extensions.length === 2);

  // proxy export / import
  check("proxy export lists proxies", (await req(base, "GET", "/api/proxies/export")).body.proxies.length >= 1);
  check("proxy import", (await req(base, "POST", "/api/proxies/import", { proxies: [{ server: "http://1.1.1.1:1", name: "imp" }] })).body.imported === 1);

  // proxy reachability test (local listener)
  const listener = net.createServer((s) => s.end());
  await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
  const livePort = (listener.address() as net.AddressInfo).port;
  const liveProxy = await req(base, "POST", "/api/proxies", { server: `http://127.0.0.1:${livePort}` });
  check("proxy test reachable", (await req(base, "POST", `/api/proxies/${liveProxy.body.id}/test`)).body.reachable === true);
  const deadProxy = await req(base, "POST", "/api/proxies", { server: "http://127.0.0.1:1" });
  check("proxy test unreachable", (await req(base, "POST", `/api/proxies/${deadProxy.body.id}/test`)).body.reachable === false);
  listener.close();

  // bookmarks import/export (file-based, browser-free)
  const bmProfile = await req(base, "POST", "/api/profiles", { name: "bm" });
  const bmId = bmProfile.body.id as string;
  check("bookmarks empty initially", (await req(base, "GET", `/api/profiles/${bmId}/bookmarks`)).body.bookmarks === null);
  const bm = { roots: { bookmark_bar: { children: [{ name: "Example", url: "https://example.com" }] } } };
  check("bookmarks import", (await req(base, "POST", `/api/profiles/${bmId}/bookmarks`, { bookmarks: bm })).body.saved === true);
  check("bookmarks round-trip", JSON.stringify((await req(base, "GET", `/api/profiles/${bmId}/bookmarks`)).body.bookmarks) === JSON.stringify(bm));

  // static UI
  const indexHtml = await fetch(base + "/").then((r) => r.text());
  check("web console index served", indexHtml.includes("Fingerprint Browser"));
  const appJs = await fetch(base + "/app.js");
  check("web console app.js served", appJs.status === 200 && (appJs.headers.get("content-type") ?? "").includes("javascript"));
  const spaFallback = await fetch(base + "/some/spa/route");
  check("SPA fallback serves index", spaFallback.status === 200 && (await spaFallback.text()).includes("Fingerprint Browser"));

  // optional bearer-token auth
  process.env.FB_TOKEN = "tok123";
  const authServer = await startServer({ port: 0 });
  try {
    check("auth required without token", (await fetch(authServer.url + "/api/profiles")).status === 401);
    check("auth accepted with token", (await fetch(authServer.url + "/api/profiles", { headers: { authorization: "Bearer tok123" } })).status === 200);
    check("health stays public", (await fetch(authServer.url + "/api/health")).status === 200);
  } finally {
    await authServer.close();
    delete process.env.FB_TOKEN;
  }

  // action synchronizer validation (no running sessions)
  const synced = await req(base, "POST", "/api/sync", { action: "type", ids: ["nonexistent"], text: "hi" });
  check("sync reports not-running", synced.status === 200 && synced.body.failed === 1 && synced.body.results[0].error === "not running");
  check("sync rejects unknown action", (await req(base, "POST", "/api/sync", { action: "nope", ids: ["x"] })).status === 400);

  // team / roles (separate server sharing the data dir)
  const teamServer = await startServer({ port: 0 });
  try {
    const admin = (await req(teamServer.url, "POST", "/api/users", { name: "boss", role: "admin" })).body;
    check("first user bootstraps in open mode", typeof admin.token === "string");
    const op = (await req(teamServer.url, "POST", "/api/users", { name: "op", role: "operator", token: "optok" }, admin.token)).body;
    await req(teamServer.url, "POST", "/api/users", { name: "view", role: "viewer", token: "viewtok" }, admin.token);

    check("unauthorized without token", (await req(teamServer.url, "GET", "/api/profiles")).status === 401);
    check("admin can list users", (await req(teamServer.url, "GET", "/api/users", undefined, admin.token)).status === 200);
    check("operator can read", (await req(teamServer.url, "GET", "/api/profiles", undefined, "optok")).status === 200);
    check("operator cannot manage users", (await req(teamServer.url, "GET", "/api/users", undefined, "optok")).status === 403);
    check("operator can write", (await req(teamServer.url, "POST", "/api/profiles", { name: "op-profile" }, "optok")).status === 200);
    check("viewer can read", (await req(teamServer.url, "GET", "/api/profiles", undefined, "viewtok")).status === 200);
    check("viewer cannot write", (await req(teamServer.url, "POST", "/api/profiles", { name: "v" }, "viewtok")).status === 403);
    check("me returns operator role", (await req(teamServer.url, "GET", "/api/me", undefined, "optok")).body.role === "operator");
    void op;

    // TOTP 2FA
    const { totpCode } = await import("../src/core/crypto/totp.js");
    const setup = await req(teamServer.url, "POST", "/api/auth/totp/setup", undefined, "optok");
    check("totp setup returns a secret", setup.status === 200 && typeof setup.body.secret === "string");
    const enable = await req(teamServer.url, "POST", "/api/auth/totp/enable", { code: totpCode(setup.body.secret) }, "optok");
    check("totp enable succeeds", enable.body.enabled === true);
    check("user token without totp is rejected", (await req(teamServer.url, "GET", "/api/profiles", undefined, "optok")).status === 401);
    check("login without totp is rejected", (await req(teamServer.url, "POST", "/api/auth/login", { token: "optok" })).status === 401);
    const login = await req(teamServer.url, "POST", "/api/auth/login", { token: "optok", totp: totpCode(setup.body.secret) });
    check("login with totp issues a session", login.status === 200 && typeof login.body.session === "string");
    check("session token is accepted", (await req(teamServer.url, "GET", "/api/profiles", undefined, login.body.session)).status === 200);
  } finally {
    await teamServer.close();
  }

  console.log(`\n${passed} API tests passed`);
} finally {
  await server.close();
}
