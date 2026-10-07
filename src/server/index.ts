import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { ProfileStore } from "../core/profile/store.js";
import { ProxyStore } from "../core/proxy/store.js";
import { SettingsStore } from "../core/settings/store.js";
import { ActivityStore } from "../core/activity/store.js";
import { UserStore, ROLE_RANK, type Role } from "../core/users/store.js";
import { generateTotpSecret, verifyTotp, totpUri } from "../core/crypto/totp.js";
import { SessionManager } from "../core/session/manager.js";
import { Synchronizer } from "../core/sync/mirror.js";
import { allHostNames, getHost } from "../hosts/registry.js";
import { PROXIES_DB, ROOT } from "../core/config.js";
import { runEngineCheck } from "../check/service.js";
import { humanType } from "../core/behavior/typing.js";
import { log } from "../core/logger.js";
import type { BrowserContext } from "playwright-core";
import type { FingerprintOverrides, OS } from "../core/fingerprint/types.js";
import type { ExportedProfile, Profile } from "../core/profile/types.js";
import type { EngineName } from "../hosts/types.js";

const SCOPE = "server";
const UI_DIR = path.join(ROOT, "ui");

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface ApiReq {
  params: Record<string, string>;
  query: Record<string, string>;
  body: Record<string, unknown>;
  user?: { id?: string; name: string; role: Role };
  bearer?: string;
}

interface Route {
  method: string;
  segments: string[];
  handler: (req: ApiReq) => Promise<unknown>;
}

interface AppContext {
  profiles: ProfileStore;
  proxies: ProxyStore;
  settings: SettingsStore;
  activity: ActivityStore;
  users: UserStore;
  sessions: SessionManager;
  /** Live input mirroring groups (leader -> followers). */
  sync: Synchronizer;
  /** Short-lived session tokens issued by /api/auth/login (post-2FA). */
  authSessions: Map<string, { userId?: string; name: string; role: Role; expires: number }>;
}

const OSES: OS[] = ["windows", "macos", "linux", "android", "ios"];

/** Minimum role rank required for a request. */
function requiredRank(method: string, pathname: string): number {
  if (pathname.startsWith("/api/users")) return ROLE_RANK.admin;
  if (pathname.startsWith("/api/auth/")) return ROLE_RANK.viewer; // any authenticated user
  if (pathname === "/api/settings" && method !== "GET") return ROLE_RANK.admin;
  if (method === "GET") return ROLE_RANK.viewer;
  return ROLE_RANK.operator;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

async function readJson(stream: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  if (body === undefined || body === null) {
    res.writeHead(status).end();
    return;
  }
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function toOverrides(input: unknown): FingerprintOverrides | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const out: FingerprintOverrides = {};
  if (typeof o.os === "string" && OSES.includes(o.os as OS)) out.os = o.os as OS;
  if (typeof o.timezone === "string") out.timezone = o.timezone;
  if (typeof o.locale === "string") out.locale = o.locale;
  if (Array.isArray(o.languages)) out.languages = o.languages.filter((l): l is string => typeof l === "string");
  if (typeof o.hardwareConcurrency === "number") out.hardwareConcurrency = o.hardwareConcurrency;
  if (typeof o.deviceMemory === "number") out.deviceMemory = o.deviceMemory;
  if (o.screen && typeof o.screen === "object") {
    const s = o.screen as Record<string, unknown>;
    if (typeof s.width === "number" && typeof s.height === "number") {
      out.screen = { width: s.width, height: s.height, colorDepth: typeof s.colorDepth === "number" ? s.colorDepth : 24 };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function toStringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out = input.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim());
  return out.length ? out : undefined;
}

/**
 * Run `fn` against the profile's browser context: reuse the running session if
 * present, otherwise launch a short-lived headless context and close it after.
 * Used by cookie import/export.
 */
async function withProfileContext<T>(ctx: AppContext, profile: Profile, fn: (context: BrowserContext) => Promise<T>): Promise<T> {
  const running = ctx.sessions.get(profile.id);
  if (running) return fn(running.context);

  const host = getHost(profile.engine);
  const avail = await host.isAvailable();
  if (!avail.ok) throw new HttpError(503, `engine ${profile.engine} unavailable: ${avail.reason}`);

  const session = await host.launch({
    profileId: profile.id,
    fingerprint: profile.fingerprint,
    proxy: ctx.profiles.resolveProxy(profile, ctx.proxies),
    userDataDir: ctx.profiles.userDataDir(profile.id),
    headless: true,
  });
  try {
    return await fn(session.context);
  } finally {
    await session.close();
  }
}
function maskProxy(p: { server: string; country?: string } | undefined): string {
  if (!p) return "direct";
  return `${p.server}${p.country ? ` [${p.country}]` : ""}`;
}

/** Run a command with a timeout, returning the tail of its output. */
function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: null, output: (err as Error).message, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onData = (buf: Buffer) => {
      out += buf.toString();
      if (out.length > 20000) out = out.slice(-20000);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${out}\n${err.message}`, timedOut });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: out, timedOut });
    });
  });
}

function proxyHostPort(server: string): { host: string; port: number } | null {
  try {
    const u = new URL(server);
    const port = Number(u.port || (u.protocol.startsWith("socks") ? 1080 : 8080));
    if (!u.hostname || !port) return null;
    return { host: u.hostname, port };
  } catch {
    return null;
  }
}

/** TCP reachability check for a proxy endpoint (no traffic, just connect). */
function tcpReachable(host: string, port: number, timeoutMs = 3000): Promise<{ reachable: boolean; ms: number; error?: string }> {
  const start = Date.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (reachable: boolean, error?: string) => {
      socket.destroy();
      resolve({ reachable, ms: Date.now() - start, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false, "timeout"));
    socket.once("error", (e) => done(false, (e as Error).message));
  });
}

function profileView(ctx: AppContext, profile: ReturnType<ProfileStore["list"]>[number]) {
  const proxy = ctx.profiles.resolveProxy(profile, ctx.proxies);
  return {
    id: profile.id,
    name: profile.name,
    engine: profile.engine,
    os: profile.fingerprint.os,
    timezone: profile.fingerprint.timezone,
    locale: profile.fingerprint.locale,
    proxy: maskProxy(proxy),
    proxyId: profile.proxyId ?? null,
    notes: profile.notes ?? "",
    tags: profile.tags ?? [],
    folder: profile.folder ?? "",
    status: profile.status ?? "",
    extensions: profile.extensions ?? [],
    running: ctx.sessions.isRunning(profile.id),
    createdAt: profile.createdAt,
    lastUsedAt: profile.lastUsedAt ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                      */
/* -------------------------------------------------------------------------- */

function buildRoutes(ctx: AppContext): Route[] {
  const r = (method: string, pattern: string, handler: (req: ApiReq) => Promise<unknown>): Route => ({
    method,
    segments: pattern.split("/").filter(Boolean),
    handler,
  });

  return [
    r("GET", "/api/health", async () => ({ ok: true, name: "fingerprint-browser", time: new Date().toISOString() })),

    r("GET", "/api/engines", async () => {
      const out = [];
      for (const name of allHostNames()) {
        const host = getHost(name);
        const avail = await host.isAvailable();
        out.push({ name, available: avail.ok, reason: avail.reason, capabilities: host.capabilities });
      }
      return out;
    }),

    r("POST", "/api/engines/:name/install", async ({ params }) => {
      const name = params.name as EngineName;
      if (!allHostNames().includes(name)) throw new HttpError(404, `unknown engine: ${name}`);
      const [cmd, args] =
        name === "chrome-lite" ? ["npx", ["--yes", "patchright", "install", "chromium"]] : ["npx", ["--yes", "camoufox", "fetch"]];
      ctx.activity.record({ type: "engine.install", message: name });
      const result = await runCommand(cmd, args, 10 * 60 * 1000);
      const avail = await getHost(name).isAvailable();
      return { engine: name, ...result, available: avail.ok, reason: avail.reason };
    }),

    r("GET", "/api/profiles", async () => {
      return ctx.profiles.list().map((p) => profileView(ctx, p));
    }),

    r("POST", "/api/profiles", async ({ body }) => {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) throw new HttpError(400, "name is required");
      const settings = ctx.settings.get();
      const engine = (typeof body.engine === "string" ? body.engine : settings.defaultEngine) as EngineName;
      if (!allHostNames().includes(engine)) throw new HttpError(400, `unknown engine: ${engine}`);
      const overrides = toOverrides(body.overrides) ?? (settings.defaultOs ? { os: settings.defaultOs } : undefined);
      const profile = ctx.profiles.create({
        name,
        engine,
        proxyId: typeof body.proxyId === "string" ? body.proxyId : settings.defaultProxyId ?? undefined,
        overrides,
        notes: typeof body.notes === "string" ? body.notes : undefined,
        tags: toStringArray(body.tags),
        folder: typeof body.folder === "string" ? body.folder : undefined,
        status: typeof body.status === "string" ? body.status : undefined,
        extensions: toStringArray(body.extensions),
      });
      ctx.activity.record({ type: "profile.create", profileId: profile.id, profileName: profile.name });
      return profileView(ctx, profile);
    }),

    r("POST", "/api/profiles/batch", async ({ body }) => {
      const count = Math.min(Math.max(Number(body.count) || 0, 1), 500);
      const pattern = typeof body.namePattern === "string" && body.namePattern.trim() ? body.namePattern.trim() : "profile-{n}";
      const settings = ctx.settings.get();
      const engine = (typeof body.engine === "string" ? body.engine : settings.defaultEngine) as EngineName;
      if (!allHostNames().includes(engine)) throw new HttpError(400, `unknown engine: ${engine}`);
      const overrides = toOverrides(body.overrides) ?? (settings.defaultOs ? { os: settings.defaultOs } : undefined);
      const proxyId = typeof body.proxyId === "string" ? body.proxyId : settings.defaultProxyId ?? undefined;
      const start = Number(body.startIndex) || 1;
      const tags = toStringArray(body.tags);

      const created = [];
      for (let i = 0; i < count; i++) {
        const n = start + i;
        created.push(
          profileView(
            ctx,
            ctx.profiles.create({
              name: pattern.includes("{n}") ? pattern.replace(/\{n\}/g, String(n)) : `${pattern}-${n}`,
              engine,
              proxyId,
              overrides,
              notes: typeof body.notes === "string" ? body.notes : undefined,
              tags,
              folder: typeof body.folder === "string" ? body.folder : undefined,
              status: typeof body.status === "string" ? body.status : undefined,
              extensions: toStringArray(body.extensions),
            }),
          ),
        );
      }
      ctx.activity.record({ type: "profile.batchCreate", message: `created ${created.length} profiles` });
      return { created: created.length, profiles: created };
    }),

    r("POST", "/api/profiles/:id/duplicate", async ({ params, body }) => {
      const clone = ctx.profiles.duplicate(params.id, typeof body.name === "string" ? body.name : undefined);
      if (!clone) throw new HttpError(404, "profile not found");
      return profileView(ctx, clone);
    }),

    r("GET", "/api/profiles/:id", async ({ params }) => {
      const p = ctx.profiles.get(params.id);
      if (!p) throw new HttpError(404, "profile not found");
      return { ...profileView(ctx, p), fingerprint: p.fingerprint };
    }),

    r("PATCH", "/api/profiles/:id", async ({ params, body }) => {
      const patch: Parameters<ProfileStore["update"]>[1] = {};
      if (typeof body.name === "string") patch.name = body.name;
      if (typeof body.engine === "string") patch.engine = body.engine as EngineName;
      if (typeof body.notes === "string") patch.notes = body.notes;
      if (typeof body.folder === "string") patch.folder = body.folder;
      if (typeof body.status === "string") patch.status = body.status;
      const tags = toStringArray(body.tags);
      if (tags) patch.tags = tags;
      if (body.extensions === null) patch.extensions = [];
      else {
        const exts = toStringArray(body.extensions);
        if (exts) patch.extensions = exts;
      }
      if (body.proxyId === null) patch.proxyId = null;
      else if (typeof body.proxyId === "string") patch.proxyId = body.proxyId;
      const overrides = toOverrides(body.overrides);
      if (overrides) patch.overrides = overrides;
      const updated = ctx.profiles.update(params.id, patch);
      if (!updated) throw new HttpError(404, "profile not found");
      ctx.activity.record({ type: "profile.update", profileId: updated.id, profileName: updated.name });
      return profileView(ctx, updated);
    }),

    r("DELETE", "/api/profiles/:id", async ({ params }) => {
      const profile = ctx.profiles.get(params.id);
      await ctx.sessions.close(params.id);
      const ok = ctx.profiles.remove(params.id);
      if (!ok) throw new HttpError(404, "profile not found");
      ctx.activity.record({ type: "profile.delete", profileId: params.id, profileName: profile?.name });
      return { deleted: params.id };
    }),

    r("POST", "/api/profiles/:id/launch", async ({ params, body }) => {
      const profile = ctx.profiles.get(params.id);
      if (!profile) throw new HttpError(404, "profile not found");
      const proxy = ctx.profiles.resolveProxy(profile, ctx.proxies);
      const info = await ctx.sessions.launch(profile, proxy, {
        headless: body.headless === true,
        startUrl: typeof body.startUrl === "string" ? body.startUrl : undefined,
      });
      ctx.profiles.touch(profile.id);
      ctx.activity.record({ type: "profile.launch", profileId: profile.id, profileName: profile.name });
      return info;
    }),

    r("POST", "/api/profiles/:id/stop", async ({ params }) => {
      const profile = ctx.profiles.get(params.id);
      const closed = await ctx.sessions.close(params.id);
      if (closed) ctx.activity.record({ type: "profile.stop", profileId: params.id, profileName: profile?.name });
      return { closed };
    }),

    r("POST", "/api/profiles/bulk", async ({ body }) => {
      const action = typeof body.action === "string" ? body.action : "";
      const ids = Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === "string") : [];
      if (!["launch", "stop", "delete"].includes(action)) throw new HttpError(400, "action must be launch|stop|delete");
      if (!ids.length) throw new HttpError(400, "ids is required");

      const results: { id: string; ok: boolean; error?: string }[] = [];
      for (const id of ids) {
        try {
          const profile = ctx.profiles.get(id);
          if (!profile) throw new Error("not found");
          if (action === "launch") {
            await ctx.sessions.launch(profile, ctx.profiles.resolveProxy(profile, ctx.proxies), {
              headless: body.headless === true,
              startUrl: typeof body.startUrl === "string" ? body.startUrl : undefined,
            });
            ctx.profiles.touch(id);
          } else if (action === "stop") {
            await ctx.sessions.close(id);
          } else {
            await ctx.sessions.close(id);
            ctx.profiles.remove(id);
          }
          results.push({ id, ok: true });
        } catch (err) {
          results.push({ id, ok: false, error: (err as Error).message });
        }
      }
      const failed = results.filter((r) => !r.ok).length;
      ctx.activity.record({ type: `profile.bulk.${action}`, message: `${results.length - failed}/${results.length} ok` });
      return { action, total: results.length, failed, results };
    }),

    r("POST", "/api/sync", async ({ body }) => {
      const action = typeof body.action === "string" ? body.action : "";
      const ids = Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === "string") : [];
      if (!["type", "goto", "click", "scroll"].includes(action)) throw new HttpError(400, "action must be type|goto|click|scroll");
      if (!ids.length) throw new HttpError(400, "ids is required");

      const results: { id: string; ok: boolean; error?: string }[] = [];
      for (const id of ids) {
        const session = ctx.sessions.get(id);
        if (!session) {
          results.push({ id, ok: false, error: "not running" });
          continue;
        }
        try {
          if (action === "type") {
            await humanType(session.page, typeof body.text === "string" ? body.text : "", {
              minDelayMs: typeof body.minDelayMs === "number" ? body.minDelayMs : undefined,
              maxDelayMs: typeof body.maxDelayMs === "number" ? body.maxDelayMs : undefined,
            });
          } else if (action === "goto") {
            if (typeof body.url !== "string" || !body.url) throw new Error("url is required");
            await session.page.goto(body.url, { waitUntil: "domcontentloaded", timeout: 30000 });
          } else if (action === "click") {
            await session.page.mouse.click(Number(body.x) || 0, Number(body.y) || 0);
          } else if (action === "scroll") {
            await session.page.mouse.wheel(0, Number(body.deltaY) || 500);
          }
          results.push({ id, ok: true });
        } catch (err) {
          results.push({ id, ok: false, error: (err as Error).message });
        }
      }
      const failed = results.filter((r) => !r.ok).length;
      ctx.activity.record({ type: `sync.${action}`, message: `${results.length - failed}/${results.length} ok` });
      return { action, total: results.length, failed, results };
    }),

    r("GET", "/api/sync", async () => ctx.sync.list()),

    r("POST", "/api/sync/start", async ({ body }) => {
      const leaderId = typeof body.leaderId === "string" ? body.leaderId : "";
      const followerIds = Array.isArray(body.followerIds) ? body.followerIds.filter((i): i is string => typeof i === "string") : [];
      if (!leaderId) throw new HttpError(400, "leaderId is required");
      if (!followerIds.length) throw new HttpError(400, "followerIds is required");
      try {
        const group = await ctx.sync.start(leaderId, followerIds);
        ctx.activity.record({ type: "sync.mirror.start", message: `${leaderId} -> ${followerIds.join(",")}` });
        return group;
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    }),

    r("POST", "/api/sync/stop", async ({ body }) => {
      const groupId = typeof body.groupId === "string" ? body.groupId : "";
      if (!groupId) throw new HttpError(400, "groupId is required");
      const stopped = await ctx.sync.stop(groupId);
      if (!stopped) throw new HttpError(404, "sync group not found");
      ctx.activity.record({ type: "sync.mirror.stop", message: groupId });
      return { stopped: true };
    }),

    r("POST", "/api/profiles/:id/check", async ({ params, body }) => {
      const profile = ctx.profiles.get(params.id);
      if (!profile) throw new HttpError(404, "profile not found");
      const proxy = ctx.profiles.resolveProxy(profile, ctx.proxies);
      return runEngineCheck(profile.engine, profile.fingerprint, proxy, {
        headless: body.headless !== false,
        sites: body.sites === true,
      });
    }),

    r("GET", "/api/profiles/:id/cookies", async ({ params }) => {
      const profile = ctx.profiles.get(params.id);
      if (!profile) throw new HttpError(404, "profile not found");
      const cookies = await withProfileContext(ctx, profile, (c) => c.cookies());
      ctx.activity.record({ type: "profile.cookies.export", profileId: profile.id, profileName: profile.name, message: `${cookies.length} cookies` });
      return { profileId: profile.id, count: cookies.length, cookies };
    }),

    r("POST", "/api/profiles/:id/cookies", async ({ params, body }) => {
      const profile = ctx.profiles.get(params.id);
      if (!profile) throw new HttpError(404, "profile not found");
      const cookies = Array.isArray(body.cookies) ? body.cookies : [];
      if (!cookies.length) throw new HttpError(400, "cookies array is required");
      await withProfileContext(ctx, profile, (c) => c.addCookies(cookies as never));
      ctx.activity.record({ type: "profile.cookies.import", profileId: profile.id, profileName: profile.name, message: `${cookies.length} cookies` });
      return { imported: cookies.length };
    }),

    r("POST", "/api/profiles/:id/type", async ({ params, body }) => {
      const profile = ctx.profiles.get(params.id);
      if (!profile) throw new HttpError(404, "profile not found");
      const session = ctx.sessions.get(profile.id);
      if (!session) throw new HttpError(409, "profile is not running");
      const text = typeof body.text === "string" ? body.text : "";
      if (!text) throw new HttpError(400, "text is required");
      await humanType(session.page, text, {
        minDelayMs: typeof body.minDelayMs === "number" ? body.minDelayMs : undefined,
        maxDelayMs: typeof body.maxDelayMs === "number" ? body.maxDelayMs : undefined,
      });
      ctx.activity.record({ type: "profile.type", profileId: profile.id, profileName: profile.name, message: `${text.length} chars` });
      return { typed: text.length };
    }),

    r("POST", "/api/profiles/:id/eval", async ({ params, body }) => {
      const profile = ctx.profiles.get(params.id);
      if (!profile) throw new HttpError(404, "profile not found");
      const session = ctx.sessions.get(profile.id);
      if (!session) throw new HttpError(409, "profile is not running");
      const expr = typeof body.expr === "string" ? body.expr : "";
      if (!expr) throw new HttpError(400, "expr is required");
      const result = await session.page.evaluate(expr as never);
      return { result };
    }),

    r("GET", "/api/profiles/:id/bookmarks", async ({ params }) => {
      const profile = ctx.profiles.get(params.id);
      if (!profile) throw new HttpError(404, "profile not found");
      if (ctx.sessions.isRunning(params.id)) throw new HttpError(409, "stop the profile before reading bookmarks");
      const file = path.join(ctx.profiles.userDataDir(params.id), "Default", "Bookmarks");
      if (!fs.existsSync(file)) return { bookmarks: null };
      return { bookmarks: JSON.parse(fs.readFileSync(file, "utf8")) };
    }),

    r("POST", "/api/profiles/:id/bookmarks", async ({ params, body }) => {
      const profile = ctx.profiles.get(params.id);
      if (!profile) throw new HttpError(404, "profile not found");
      if (ctx.sessions.isRunning(params.id)) throw new HttpError(409, "stop the profile before writing bookmarks");
      const bookmarks = body.bookmarks;
      if (!bookmarks || typeof bookmarks !== "object") throw new HttpError(400, "bookmarks object is required");
      const dir = path.join(ctx.profiles.userDataDir(params.id), "Default");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "Bookmarks"), JSON.stringify(bookmarks, null, 2));
      ctx.activity.record({ type: "profile.bookmarks.import", profileId: profile.id, profileName: profile.name });
      return { saved: true };
    }),

    r("GET", "/api/proxies", async () => {
      return ctx.proxies.list().map((p) => ({ ...p, password: p.password ? "***" : undefined }));
    }),

    r("GET", "/api/proxies/export", async () => ({ proxies: ctx.proxies.list() })),

    r("POST", "/api/proxies/import", async ({ body }) => {
      const list = Array.isArray(body.proxies) ? (body.proxies as Record<string, unknown>[]) : [];
      const valid = list.filter((p) => p && typeof p.server === "string");
      if (!valid.length) throw new HttpError(400, "proxies array is required");
      const created = valid.map((p) =>
        ctx.proxies.create({
          name: typeof p.name === "string" ? p.name : undefined,
          server: p.server as string,
          username: typeof p.username === "string" ? p.username : undefined,
          password: typeof p.password === "string" ? p.password : undefined,
          country: typeof p.country === "string" ? p.country : undefined,
          timezone: typeof p.timezone === "string" ? p.timezone : undefined,
        }),
      );
      ctx.activity.record({ type: "proxy.import", message: `${created.length} proxies` });
      return { imported: created.length };
    }),

    r("POST", "/api/proxies", async ({ body }) => {
      const server = typeof body.server === "string" ? body.server.trim() : "";
      if (!server) throw new HttpError(400, "server is required");
      const rec = ctx.proxies.create({
        name: typeof body.name === "string" ? body.name : undefined,
        server,
        username: typeof body.username === "string" ? body.username : undefined,
        password: typeof body.password === "string" ? body.password : undefined,
        country: typeof body.country === "string" ? body.country : undefined,
        timezone: typeof body.timezone === "string" ? body.timezone : undefined,
      });
      ctx.activity.record({ type: "proxy.create", message: server });
      return rec;
    }),

    r("PATCH", "/api/proxies/:id", async ({ params, body }) => {
      const updated = ctx.proxies.update(params.id, {
        name: typeof body.name === "string" ? body.name : undefined,
        server: typeof body.server === "string" ? body.server : undefined,
        username: typeof body.username === "string" ? body.username : undefined,
        password: typeof body.password === "string" ? body.password : undefined,
        country: typeof body.country === "string" ? body.country : undefined,
        timezone: typeof body.timezone === "string" ? body.timezone : undefined,
      });
      if (!updated) throw new HttpError(404, "proxy not found");
      return updated;
    }),

    r("DELETE", "/api/proxies/:id", async ({ params }) => {
      const ok = ctx.proxies.remove(params.id);
      if (!ok) throw new HttpError(404, "proxy not found");
      ctx.activity.record({ type: "proxy.delete", message: params.id });
      return { deleted: params.id };
    }),

    r("POST", "/api/proxies/:id/test", async ({ params }) => {
      const rec = ctx.proxies.get(params.id);
      if (!rec) throw new HttpError(404, "proxy not found");
      const hp = proxyHostPort(rec.server);
      if (!hp) throw new HttpError(400, `invalid proxy server: ${rec.server}`);
      const result = await tcpReachable(hp.host, hp.port);
      ctx.activity.record({ type: "proxy.test", message: `${rec.server} ${result.reachable ? "reachable" : "unreachable"}` });
      return { ...result, target: `${hp.host}:${hp.port}` };
    }),

    r("GET", "/api/sessions", async () => {
      return ctx.sessions.list();
    }),

    r("POST", "/api/sessions/:id/close", async ({ params }) => {
      const closed = await ctx.sessions.close(params.id);
      return { closed };
    }),

    r("GET", "/api/settings", async () => ctx.settings.get()),

    r("PATCH", "/api/settings", async ({ body }) => {
      const patch: Parameters<SettingsStore["update"]>[0] = {};
      if (typeof body.defaultEngine === "string" && allHostNames().includes(body.defaultEngine as EngineName)) {
        patch.defaultEngine = body.defaultEngine as EngineName;
      }
      if (body.defaultOs === null) patch.defaultOs = null;
      else if (typeof body.defaultOs === "string" && OSES.includes(body.defaultOs as OS)) patch.defaultOs = body.defaultOs as OS;
      if (body.defaultProxyId === null) patch.defaultProxyId = null;
      else if (typeof body.defaultProxyId === "string") patch.defaultProxyId = body.defaultProxyId;
      if (typeof body.headlessByDefault === "boolean") patch.headlessByDefault = body.headlessByDefault;
      if (typeof body.onboarded === "boolean") patch.onboarded = body.onboarded;
      const updated = ctx.settings.update(patch);
      ctx.activity.record({ type: "settings.update" });
      return updated;
    }),

    r("GET", "/api/export", async ({ query }) => {
      const ids = query.ids ? query.ids.split(",").filter(Boolean) : undefined;
      return { profiles: ctx.profiles.exportConfigs(ids) };
    }),

    r("POST", "/api/import", async ({ body }) => {
      const raw = Array.isArray(body.profiles) ? (body.profiles as ExportedProfile[]) : [];
      if (!raw.length) throw new HttpError(400, "profiles array is required");
      const valid = raw.filter((e) => e && typeof e.name === "string" && typeof e.engine === "string");
      if (!valid.length) throw new HttpError(400, "no valid profiles in payload");
      const created = ctx.profiles.importConfigs(valid);
      ctx.activity.record({ type: "profile.import", message: `imported ${created.length} profiles` });
      return { imported: created.length, profiles: created.map((p) => profileView(ctx, p)) };
    }),

    r("GET", "/api/activity", async ({ query }) => ctx.activity.list(Number(query.limit) || 200)),

    r("DELETE", "/api/activity", async () => {
      ctx.activity.clear();
      return { cleared: true };
    }),

    r("GET", "/api/me", async ({ user }) => {
      const u = user?.id ? ctx.users.get(user.id) : undefined;
      return { user: user?.name ?? "local", role: user?.role ?? "admin", id: user?.id ?? null, totpEnabled: Boolean(u?.totpEnabled) };
    }),

    r("POST", "/api/auth/login", async ({ body }) => {
      const token = typeof body.token === "string" ? body.token : "";
      if (!token) throw new HttpError(400, "token is required");
      const bootstrap = process.env.FB_TOKEN;
      const matched = ctx.users.findByToken(token);
      if (!matched && !(bootstrap && token === bootstrap)) throw new HttpError(401, "invalid token");
      if (matched?.totpEnabled) {
        const code = typeof body.totp === "string" ? body.totp : "";
        if (!verifyTotp(matched.totpSecret ?? "", code)) throw new HttpError(401, "invalid or missing TOTP code");
      }
      const sessionToken = crypto.randomBytes(24).toString("hex");
      const expires = Date.now() + 12 * 3600 * 1000;
      ctx.authSessions.set(sessionToken, { userId: matched?.id, name: matched?.name ?? "admin", role: matched?.role ?? "admin", expires });
      return {
        session: sessionToken,
        expiresAt: new Date(expires).toISOString(),
        user: matched?.name ?? "admin",
        role: matched?.role ?? "admin",
      };
    }),

    r("POST", "/api/auth/logout", async ({ bearer }) => {
      if (bearer) ctx.authSessions.delete(bearer);
      return { loggedOut: true };
    }),

    r("POST", "/api/auth/totp/setup", async ({ user }) => {
      if (!user?.id) throw new HttpError(400, "no user account for this credential");
      const secret = generateTotpSecret();
      ctx.users.setTotpSecret(user.id, secret);
      return { secret, uri: totpUri(secret, user.name) };
    }),

    r("POST", "/api/auth/totp/enable", async ({ user, body }) => {
      if (!user?.id) throw new HttpError(400, "no user account for this credential");
      const account = ctx.users.get(user.id);
      const code = typeof body.code === "string" ? body.code : "";
      if (!account?.totpSecret || !verifyTotp(account.totpSecret, code)) throw new HttpError(400, "invalid TOTP code");
      ctx.users.setTotpEnabled(user.id, true);
      ctx.activity.record({ type: "user.totp.enable", message: account.name });
      return { enabled: true };
    }),

    r("POST", "/api/auth/totp/disable", async ({ user, body }) => {
      if (!user?.id) throw new HttpError(400, "no user account for this credential");
      const account = ctx.users.get(user.id);
      if (account?.totpEnabled) {
        const code = typeof body.code === "string" ? body.code : "";
        if (!account.totpSecret || !verifyTotp(account.totpSecret, code)) throw new HttpError(400, "invalid TOTP code");
      }
      ctx.users.setTotpEnabled(user.id, false);
      ctx.activity.record({ type: "user.totp.disable", message: account?.name });
      return { enabled: false };
    }),

    r("GET", "/api/users", async () =>
      ctx.users.list().map((u) => ({ id: u.id, name: u.name, role: u.role, createdAt: u.createdAt })),
    ),

    r("POST", "/api/users", async ({ body }) => {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const role = typeof body.role === "string" ? body.role : "operator";
      if (!name) throw new HttpError(400, "name is required");
      if (!["admin", "operator", "viewer"].includes(role)) throw new HttpError(400, "role must be admin|operator|viewer");
      const user = ctx.users.create({ name, role: role as Role, token: typeof body.token === "string" ? body.token : undefined });
      ctx.activity.record({ type: "user.create", message: `${user.name} (${user.role})` });
      return { id: user.id, name: user.name, role: user.role, token: user.token };
    }),

    r("DELETE", "/api/users/:id", async ({ params }) => {
      const ok = ctx.users.remove(params.id);
      if (!ok) throw new HttpError(404, "user not found");
      ctx.activity.record({ type: "user.delete", message: params.id });
      return { deleted: params.id };
    }),
  ];
}

/* -------------------------------------------------------------------------- */
/* Static files                                                                */
/* -------------------------------------------------------------------------- */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

function serveStatic(res: http.ServerResponse, pathname: string): boolean {
  if (!fs.existsSync(UI_DIR)) return false;
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let file = path.join(UI_DIR, rel);
  if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(UI_DIR, "index.html"); // SPA fallback
    if (!fs.existsSync(file)) return false;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Server                                                                      */
/* -------------------------------------------------------------------------- */

export interface StartServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  context: AppContext;
  close(): Promise<void>;
}

export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const profiles = new ProfileStore();
  const sessions = new SessionManager((id) => profiles.userDataDir(id));
  const ctx: AppContext = {
    profiles,
    proxies: new ProxyStore(opts.dataDir ? path.join(opts.dataDir, "proxies.json") : PROXIES_DB),
    settings: new SettingsStore(),
    activity: new ActivityStore(),
    users: new UserStore(),
    sessions,
    sync: new Synchronizer((id) => sessions.get(id)),
    authSessions: new Map(),
  };
  const routes = buildRoutes(ctx);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = decodeURIComponent(url.pathname);

      // Auth + role-based permissions. Open when no users and no FB_TOKEN.
      // /api/health and /api/auth/login are public.
      let authUser: { id?: string; name: string; role: Role } | undefined;
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const isPublic = pathname === "/api/health" || pathname === "/api/auth/login";
      if (pathname.startsWith("/api/") && !isPublic) {
        const session = ctx.authSessions.get(bearer);
        if (session && session.expires > Date.now()) {
          authUser = { id: session.userId, name: session.name, role: session.role };
        } else {
          const bootstrapToken = process.env.FB_TOKEN;
          if (!ctx.users.isEmpty || bootstrapToken) {
            const matched = ctx.users.findByToken(bearer);
            if (matched) {
              if (matched.totpEnabled) {
                const code = String(req.headers["x-totp"] ?? "");
                if (!verifyTotp(matched.totpSecret ?? "", code)) {
                  send(res, 401, { error: "totp required", totp: true });
                  return;
                }
              }
              authUser = { id: matched.id, name: matched.name, role: matched.role };
            } else if (bootstrapToken && bearer === bootstrapToken) {
              authUser = { name: "admin", role: "admin" };
            }
            if (!authUser) {
              send(res, 401, { error: "unauthorized" });
              return;
            }
          } else {
            authUser = { name: "local", role: "admin" };
          }
        }
        const need = requiredRank(req.method ?? "GET", pathname);
        if (ROLE_RANK[authUser.role] < need) {
          send(res, 403, { error: "forbidden: requires higher role" });
          return;
        }
      }

      if (pathname.startsWith("/api/")) {
        const parts = pathname.split("/").filter(Boolean);
        for (const route of routes) {
          if (route.method !== req.method || route.segments.length !== parts.length) continue;
          const params: Record<string, string> = {};
          let match = true;
          for (let i = 0; i < route.segments.length; i++) {
            const seg = route.segments[i];
            if (seg.startsWith(":")) params[seg.slice(1)] = parts[i];
            else if (seg !== parts[i]) { match = false; break; }
          }
          if (!match) continue;
          const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req);
          const query: Record<string, string> = {};
          url.searchParams.forEach((v, k) => (query[k] = v));
          const result = await route.handler({ params, query, body, user: authUser, bearer });
          send(res, 200, result);
          return;
        }
        throw new HttpError(404, `no route for ${req.method} ${pathname}`);
      }

      if (!serveStatic(res, pathname)) {
        send(res, 404, { error: "not found" });
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = (err as Error).message;
      if (status >= 500) log.error(SCOPE, `${req.method} ${req.url}: ${message}`);
      send(res, status, { error: message });
    }
  });

  const port = opts.port ?? 0;
  await new Promise<void>((resolve) => server.listen(port, opts.host ?? "127.0.0.1", resolve));
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  log.info(SCOPE, `listening on http://127.0.0.1:${actualPort}`);

  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    context: ctx,
    close: async () => {
      ctx.sync.stopAll();
      await ctx.sessions.closeAll();
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
