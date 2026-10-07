import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * End-to-end: launch and stop a real browser through the HTTP API.
 * Requires a real engine (chrome-lite). Skips cleanly if unavailable.
 * Run under xvfb via `npm run test:integration`.
 */
process.env.FB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fb-api-launch-"));

const { startServer } = await import("../../src/server/index.js");
const { getHost } = await import("../../src/hosts/registry.js");
const { startLocalPageServer } = await import("../../src/check/local-server.js");

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0"><div id="area" style="width:1200px;height:800px"></div>
<script>
document.documentElement.setAttribute('data-mm','0');
var mm = 0;
addEventListener('mousemove', function () { mm++; document.documentElement.setAttribute('data-mm', String(mm)); }, true);
</script></body></html>`;

const host = getHost("chrome-lite");
const avail = await host.isAvailable();
if (!avail.ok) {
  console.log(`SKIP: chrome-lite unavailable: ${avail.reason}`);
  process.exit(0);
}

async function req<T = any>(base: string, method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(base + route, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const server = await startServer({ port: 0 });
const base = server.url;
console.log(`api launch test server: ${base}`);

try {
  const created = await req(base, "POST", "/api/profiles", { name: "launch-test", engine: "chrome-lite" });
  assert.equal(created.status, 200, "profile create");
  const id = created.body.id as string;

  const launch = await req(base, "POST", `/api/profiles/${id}/launch`, { headless: true });
  assert.equal(launch.status, 200, `launch failed: ${JSON.stringify(launch.body)}`);
  assert.equal(launch.body.status, "running");

  const list = await req(base, "GET", "/api/profiles");
  assert.equal(list.body.find((p: any) => p.id === id)?.running, true, "profile should be running");

  const sessions = await req(base, "GET", "/api/sessions");
  assert.equal(sessions.body.length, 1, "one running session");
  assert.equal(sessions.body[0].profileId, id);

  // human-like typing into the running session
  const typed = await req(base, "POST", `/api/profiles/${id}/type`, { text: "hello", minDelayMs: 1, maxDelayMs: 2 });
  assert.equal(typed.status, 200, `type failed: ${JSON.stringify(typed.body)}`);
  assert.equal(typed.body.typed, 5);
  console.log("human typing via API ok");

  // action synchronizer across two running sessions
  const created2 = await req(base, "POST", "/api/profiles", { name: "launch-test-2", engine: "chrome-lite" });
  const id2 = created2.body.id as string;
  const launch2 = await req(base, "POST", `/api/profiles/${id2}/launch`, { headless: true });
  assert.equal(launch2.status, 200, `second launch failed: ${JSON.stringify(launch2.body)}`);
  const sync = await req(base, "POST", "/api/sync", { action: "type", ids: [id, id2], text: "sync", minDelayMs: 1, maxDelayMs: 2 });
  assert.equal(sync.status, 200, `sync failed: ${JSON.stringify(sync.body)}`);
  assert.equal(sync.body.total, 2);
  assert.equal(sync.body.failed, 0);
  console.log("action synchronizer ok");
  await req(base, "POST", `/api/profiles/${id2}/stop`, {});

  const stop = await req(base, "POST", `/api/profiles/${id}/stop`, {});
  assert.equal(stop.status, 200);
  assert.equal(stop.body.closed, true);

  const after = await req(base, "GET", "/api/profiles");
  assert.equal(after.body.find((p: any) => p.id === id)?.running, false, "profile should be stopped");

  const sessionsAfter = await req(base, "GET", "/api/sessions");
  assert.equal(sessionsAfter.body.length, 0, "no running sessions after stop");

  // cookie import/export via the API (ephemeral context)
  const cookie = { name: "fbapi", value: "v1", domain: "example.com", path: "/", expires: Math.floor(Date.now() / 1000) + 3600 };
  const imp = await req(base, "POST", `/api/profiles/${id}/cookies`, { cookies: [cookie] });
  assert.equal(imp.status, 200, `cookie import failed: ${JSON.stringify(imp.body)}`);
  assert.equal(imp.body.imported, 1);
  const exp = await req(base, "GET", `/api/profiles/${id}/cookies`);
  assert.equal(exp.status, 200);
  assert.ok(exp.body.cookies.some((c: any) => c.name === "fbapi" && c.value === "v1"), "imported cookie should be readable");
  console.log("cookie import/export via API ok");

  // live input mirroring (leader -> follower)
  const local = await startLocalPageServer(PAGE);
  const leaderId = (await req(base, "POST", "/api/profiles", { name: "mirror-leader" })).body.id as string;
  const followerId = (await req(base, "POST", "/api/profiles", { name: "mirror-follower" })).body.id as string;
  await req(base, "POST", `/api/profiles/${leaderId}/launch`, { headless: true, startUrl: local.url });
  await req(base, "POST", `/api/profiles/${followerId}/launch`, { headless: true, startUrl: local.url });
  const group = await req(base, "POST", "/api/sync/start", { leaderId, followerIds: [followerId] });
  assert.equal(group.status, 200, `mirror start failed: ${JSON.stringify(group.body)}`);
  const before = await req(base, "POST", `/api/profiles/${followerId}/eval`, { expr: "document.documentElement.getAttribute('data-mm')" });
  // drive the leader with a Playwright click (generates a trusted mousemove)
  await req(base, "POST", "/api/sync", { action: "click", ids: [leaderId], x: 120, y: 140 });
  await new Promise((r) => setTimeout(r, 1500));
  const mmAfter = await req(base, "POST", `/api/profiles/${followerId}/eval`, { expr: "document.documentElement.getAttribute('data-mm')" });
  assert.ok(
    Number(mmAfter.body.result) > Number(before.body.result || 0),
    `follower did not receive mirrored input: before=${before.body.result} after=${mmAfter.body.result}`,
  );
  console.log("live input mirroring ok");
  await req(base, "POST", "/api/sync/stop", { groupId: group.body.id });
  await req(base, "POST", `/api/profiles/${leaderId}/stop`, {});
  await req(base, "POST", `/api/profiles/${followerId}/stop`, {});
  await local.close();

  console.log("\nAPI launch/stop integration test passed");
} finally {
  await server.close();
}
