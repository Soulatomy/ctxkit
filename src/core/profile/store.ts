import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PROFILES_DB, PROFILES_DIR, ensureDataDirs } from "../config.js";
import { generateFingerprint, fingerprintToOverrides } from "../fingerprint/seed.js";
import type { CreateProfileInput, ExportedProfile, Profile, UpdateProfileInput } from "./types.js";
import type { ProxyStore } from "../proxy/store.js";
import type { ProxyConfig } from "../proxy/types.js";

/**
 * JSON-file profile store. Deliberately behind a tiny interface; swap for
 * SQLite/Postgres later without touching callers.
 */
export class ProfileStore {
  private profiles = new Map<string, Profile>();

  constructor() {
    ensureDataDirs();
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(PROFILES_DB)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(PROFILES_DB, "utf8")) as Profile[];
      for (const p of raw) this.profiles.set(p.id, p);
    } catch {
      this.profiles = new Map();
    }
  }

  private persist(): void {
    const tmp = `${PROFILES_DB}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.profiles.values()], null, 2));
    fs.renameSync(tmp, PROFILES_DB);
  }

  list(): Profile[] {
    return [...this.profiles.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Profile | undefined {
    return this.profiles.get(id);
  }

  resolve(idOrName: string): Profile | undefined {
    return this.profiles.get(idOrName) ?? this.list().find((p) => p.name === idOrName);
  }

  create(input: CreateProfileInput): Profile {
    const id = crypto.randomBytes(8).toString("hex");
    const engine = input.engine ?? "chrome-lite";
    const fingerprint = generateFingerprint(id, input.proxy, input.overrides);
    const profile: Profile = {
      id,
      name: input.name,
      engine,
      fingerprint,
      proxy: input.proxy,
      proxyId: input.proxyId,
      notes: input.notes,
      tags: input.tags,
      folder: input.folder,
      status: input.status,
      extensions: input.extensions,
      createdAt: new Date().toISOString(),
    };
    this.profiles.set(id, profile);
    this.persist();
    return profile;
  }

  /**
   * Update mutable fields. Changing fingerprint overrides regenerates the
   * fingerprint deterministically from the same id, so it stays stable until
   * the user actually changes something.
   */
  update(id: string, patch: UpdateProfileInput): Profile | undefined {
    const existing = this.profiles.get(id);
    if (!existing) return undefined;

    const next: Profile = { ...existing };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.engine !== undefined) next.engine = patch.engine;
    if (patch.notes !== undefined) next.notes = patch.notes;
    if (patch.tags !== undefined) next.tags = patch.tags;
    if (patch.folder !== undefined) next.folder = patch.folder;
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.extensions !== undefined) next.extensions = patch.extensions;
    if (patch.proxy !== undefined) next.proxy = patch.proxy ?? undefined;
    if (patch.proxyId !== undefined) next.proxyId = patch.proxyId ?? undefined;
    if (patch.overrides !== undefined) {
      next.fingerprint = generateFingerprint(id, next.proxy, patch.overrides);
    }

    this.profiles.set(id, next);
    this.persist();
    return next;
  }

  touch(id: string): void {
    const p = this.profiles.get(id);
    if (!p) return;
    p.lastUsedAt = new Date().toISOString();
    this.persist();
  }

  /** Per-profile browser user-data dir (starts with "p_" so we can spot them). */
  userDataDir(id: string): string {
    return path.join(PROFILES_DIR, `p_${id}`);
  }

  remove(id: string): boolean {
    const ok = this.profiles.delete(id);
    if (ok) this.persist();
    return ok;
  }

  /** Resolve the effective proxy for a profile (library entry wins over inline). */
  resolveProxy(profile: Profile, proxies: ProxyStore): ProxyConfig | undefined {
    if (profile.proxyId) {
      const rec = proxies.get(profile.proxyId);
      if (rec) {
        const { id: _id, name: _name, createdAt: _createdAt, ...config } = rec;
        return config;
      }
    }
    return profile.proxy;
  }

  /** Export portable configs (optionally a subset of ids). */
  exportConfigs(ids?: string[]): ExportedProfile[] {
    const selected = ids?.length
      ? ids.map((id) => this.profiles.get(id)).filter((p): p is Profile => Boolean(p))
      : this.list();
    return selected.map((p) => ({
      name: p.name,
      engine: p.engine,
      overrides: fingerprintToOverrides(p.fingerprint),
      proxy: p.proxy,
      proxyId: p.proxyId,
      notes: p.notes,
      tags: p.tags,
      folder: p.folder,
      status: p.status,
      extensions: p.extensions,
    }));
  }

  /** Import portable configs, creating new profiles. */
  importConfigs(entries: ExportedProfile[]): Profile[] {
    return entries.map((e) =>
      this.create({
        name: e.name,
        engine: e.engine,
        overrides: e.overrides,
        proxy: e.proxy,
        proxyId: e.proxyId,
        notes: e.notes,
        tags: e.tags,
        folder: e.folder,
        status: e.status,
        extensions: e.extensions,
      }),
    );
  }

  /** Clone a profile with a new id (fresh fingerprint unless overrides given). */
  duplicate(id: string, name?: string): Profile | undefined {
    const src = this.profiles.get(id);
    if (!src) return undefined;
    return this.create({
      name: name ?? `${src.name} copy`,
      engine: src.engine,
      proxy: src.proxy,
      proxyId: src.proxyId,
      notes: src.notes,
      tags: src.tags,
      folder: src.folder,
      status: src.status,
      extensions: src.extensions,
    });
  }
}
