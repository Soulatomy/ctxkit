#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import { ProfileStore } from "./core/profile/store.js";
import { ProxyStore } from "./core/proxy/store.js";
import { getHost, allHostNames } from "./hosts/registry.js";
import { startServer } from "./server/index.js";
import { checkConsistency } from "./core/fingerprint/consistency.js";
import { PROXIES_DB } from "./core/config.js";
import type { EngineName } from "./hosts/types.js";
import type { FingerprintOverrides, OS } from "./core/fingerprint/types.js";
import type { ProxyConfig } from "./core/proxy/types.js";
import { log } from "./core/logger.js";

function buildInlineProxy(opts: Record<string, string | undefined>): ProxyConfig | undefined {
  if (!opts.proxyServer) return undefined;
  const proxy: ProxyConfig = { server: opts.proxyServer };
  if (opts.proxyUser) proxy.username = opts.proxyUser;
  if (opts.proxyPass) proxy.password = opts.proxyPass;
  if (opts.proxyCountry) proxy.country = opts.proxyCountry.toUpperCase();
  if (opts.timezone) proxy.timezone = opts.timezone;
  return proxy;
}

function buildOverrides(opts: Record<string, string | undefined>): FingerprintOverrides | undefined {
  const o: FingerprintOverrides = {};
  if (opts.os) o.os = opts.os as OS;
  if (opts.timezone) o.timezone = opts.timezone;
  if (opts.locale) o.locale = opts.locale;
  return Object.keys(o).length ? o : undefined;
}

const program = new Command();
program.name("fb").description("fingerprint browser").version("0.1.0");

/* ------------------------------------------------------------------ engines */
program
  .command("engines")
  .description("list available injection hosts and their capabilities")
  .action(async () => {
    for (const name of allHostNames()) {
      const host = getHost(name);
      const avail = await host.isAvailable();
      console.log(`\n● ${name}  ${avail.ok ? "available" : "UNAVAILABLE"}`);
      if (!avail.ok) console.log(`  reason: ${avail.reason}`);
      console.log(`  ${host.capabilities.description}`);
      console.log(
        `  nativeFingerprint=${host.capabilities.nativeFingerprint} jsInjection=${host.capabilities.jsInjection} persistent=${host.capabilities.persistentContext} proxy=${host.capabilities.customProxy}`,
      );
    }
    console.log("");
  });

/* --------------------------------------------------------------- profiles */
program
  .command("profiles:create")
  .requiredOption("--name <name>")
  .option("--engine <engine>", `one of ${allHostNames().join(" | ")}`, "chrome-lite")
  .option("--os <os>", "windows | macos | linux")
  .option("--proxy-id <id>", "bind a proxy from the proxy library")
  .option("--proxy-server <server>", "inline proxy, e.g. http://1.2.3.4:8080")
  .option("--proxy-user <user>")
  .option("--proxy-pass <pass>")
  .option("--proxy-country <cc>", "ISO alpha-2, drives geo consistency")
  .option("--timezone <tz>")
  .action((opts) => {
    const store = new ProfileStore();
    const proxy = buildInlineProxy(opts);
    const profile = store.create({
      name: opts.name,
      engine: opts.engine as EngineName,
      proxy,
      proxyId: opts.proxyId,
      overrides: buildOverrides(opts),
    });
    const issues = checkConsistency(profile.fingerprint, proxy);
    console.log(`created profile ${profile.id} (${profile.name}) engine=${profile.engine}`);
    if (issues.length) {
      console.log("consistency warnings:");
      for (const i of issues) console.log(`  - ${i.field}: ${i.message}`);
    }
  });

program
  .command("profiles:update <id>")
  .option("--name <name>")
  .option("--engine <engine>")
  .option("--os <os>")
  .option("--timezone <tz>")
  .option("--locale <locale>")
  .option("--proxy-id <id>")
  .option("--clear-proxy", "unbind the proxy")
  .action((id: string, opts) => {
    const store = new ProfileStore();
    const patch: Parameters<ProfileStore["update"]>[1] = {};
    if (opts.name) patch.name = opts.name;
    if (opts.engine) patch.engine = opts.engine as EngineName;
    if (opts.clearProxy) patch.proxyId = null;
    else if (opts.proxyId) patch.proxyId = opts.proxyId;
    const overrides = buildOverrides(opts);
    if (overrides) patch.overrides = overrides;
    const updated = store.update(id, patch);
    if (!updated) {
      log.error("cli", `profile not found: ${id}`);
      process.exit(1);
    }
    console.log(`updated profile ${updated.id} (${updated.name})`);
  });

program
  .command("profiles:delete <id>")
  .action((id: string) => {
    const store = new ProfileStore();
    const ok = store.remove(id);
    if (!ok) {
      log.error("cli", `profile not found: ${id}`);
      process.exit(1);
    }
    console.log(`deleted profile ${id}`);
  });

program
  .command("profiles:list")
  .action(() => {
    const store = new ProfileStore();
    const proxies = new ProxyStore(PROXIES_DB);
    const list = store.list();
    if (!list.length) {
      console.log("no profiles. create one with: fb profiles:create --name demo");
      return;
    }
    console.table(
      list.map((p) => ({
        id: p.id,
        name: p.name,
        engine: p.engine,
        os: p.fingerprint.os,
        timezone: p.fingerprint.timezone,
        proxy: store.resolveProxy(p, proxies)?.server ?? "direct",
      })),
    );
  });

program
  .command("profiles:batch")
  .description("create many profiles at once")
  .requiredOption("--count <n>")
  .option("--pattern <pattern>", "name pattern with {n}", "profile-{n}")
  .option("--engine <engine>", `one of ${allHostNames().join(" | ")}`, "chrome-lite")
  .option("--os <os>")
  .option("--proxy-id <id>")
  .option("--tags <tags>", "comma separated")
  .action((opts) => {
    const store = new ProfileStore();
    const count = Math.min(Math.max(Number(opts.count) || 0, 1), 500);
    const tags = opts.tags ? String(opts.tags).split(",").map((t: string) => t.trim()).filter(Boolean) : undefined;
    for (let i = 1; i <= count; i++) {
      store.create({
        name: String(opts.pattern).includes("{n}") ? String(opts.pattern).replace(/\{n\}/g, String(i)) : `${opts.pattern}-${i}`,
        engine: opts.engine as EngineName,
        proxyId: opts.proxyId,
        overrides: buildOverrides(opts),
        tags,
      });
    }
    console.log(`created ${count} profiles`);
  });

program
  .command("profiles:export")
  .description("export profile configs to JSON")
  .option("--ids <ids>", "comma separated profile ids")
  .option("--out <file>", "output file")
  .action((opts) => {
    const store = new ProfileStore();
    const ids = opts.ids ? String(opts.ids).split(",").filter(Boolean) : undefined;
    const payload = { profiles: store.exportConfigs(ids) };
    const json = JSON.stringify(payload, null, 2);
    if (opts.out) {
      fs.writeFileSync(opts.out, json);
      console.log(`exported ${payload.profiles.length} profiles to ${opts.out}`);
    } else {
      console.log(json);
    }
  });

program
  .command("profiles:import <file>")
  .description("import profile configs from JSON")
  .action((file: string) => {
    const store = new ProfileStore();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { profiles?: unknown };
    const entries = Array.isArray(parsed) ? parsed : parsed.profiles ?? [];
    const created = store.importConfigs(entries as never);
    console.log(`imported ${created.length} profiles`);
  });

/* --------------------------------------------------------------- proxies */
program
  .command("proxies:add")
  .requiredOption("--server <server>")
  .option("--name <name>")
  .option("--username <user>")
  .option("--password <pass>")
  .option("--country <cc>")
  .option("--timezone <tz>")
  .action((opts) => {
    const proxies = new ProxyStore(PROXIES_DB);
    const rec = proxies.create({
      name: opts.name,
      server: opts.server,
      username: opts.username,
      password: opts.password,
      country: opts.country,
      timezone: opts.timezone,
    });
    console.log(`added proxy ${rec.id} (${rec.name})`);
  });

program.command("proxies:list").action(() => {
  const proxies = new ProxyStore(PROXIES_DB);
  const list = proxies.list();
  if (!list.length) {
    console.log("no proxies. add one with: fb proxies:add --server http://ip:port");
    return;
  }
  console.table(list.map((p) => ({ id: p.id, name: p.name, server: p.server, country: p.country ?? "" })));
});

program.command("proxies:remove <id>").action((id: string) => {
  const proxies = new ProxyStore(PROXIES_DB);
  if (!proxies.remove(id)) {
    log.error("cli", `proxy not found: ${id}`);
    process.exit(1);
  }
  console.log(`removed proxy ${id}`);
});

/* ---------------------------------------------------------------- launch */
program
  .command("launch <profile>")
  .description("launch a profile's browser")
  .option("--url <url>", "start URL")
  .option("--headless", "run headless (not recommended for anti-detect)", false)
  .action(async (idOrName: string, opts) => {
    const store = new ProfileStore();
    const proxies = new ProxyStore(PROXIES_DB);
    const profile = store.resolve(idOrName);
    if (!profile) {
      log.error("cli", `profile not found: ${idOrName}`);
      process.exit(1);
    }
    const host = getHost(profile.engine);
    const avail = await host.isAvailable();
    if (!avail.ok) {
      log.error("cli", `engine ${profile.engine} unavailable: ${avail.reason}`);
      process.exit(1);
    }
    const session = await host.launch({
      profileId: profile.id,
      fingerprint: profile.fingerprint,
      proxy: store.resolveProxy(profile, proxies),
      userDataDir: store.userDataDir(profile.id),
      headless: opts.headless,
      startUrl: opts.url,
      extensions: profile.extensions,
    });
    store.touch(profile.id);
    log.info("cli", `launched ${profile.engine} for ${profile.name}. Press Ctrl+C to close.`);
    const shutdown = async () => {
      await session.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise(() => {});
  });

/* ----------------------------------------------------------------- serve */
program
  .command("serve")
  .description("start the local web console / API")
  .option("--port <port>", "port (0 = random)", "8787")
  .option("--host <host>", "bind host", "127.0.0.1")
  .action(async (opts) => {
    const server = await startServer({ port: Number(opts.port), host: opts.host });
    console.log(`\n  fingerprint-browser console: ${server.url}\n`);
    const shutdown = async () => {
      await server.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise(() => {});
  });

program.parseAsync(process.argv).catch((err) => {
  log.error("cli", (err as Error).message);
  process.exit(1);
});
