import fs from "node:fs";
import crypto from "node:crypto";
import type { ProxyConfig } from "./types.js";
import { encryptSecret, decryptSecret } from "../crypto/secrets.js";

export interface ProxyRecord extends ProxyConfig {
  id: string;
  name: string;
  createdAt: string;
}

export interface CreateProxyInput extends ProxyConfig {
  name?: string;
}

/**
 * A reusable proxy library. Profiles bind to a proxy by id so the same proxy
 * can be shared/edited once. Persisted as JSON (swap for SQLite later).
 */
export class ProxyStore {
  private items = new Map<string, ProxyRecord>();
  private loaded = false;

  constructor(private readonly file: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as ProxyRecord[];
      for (const p of raw) {
        const record: ProxyRecord = p.password ? { ...p, password: decryptSecret(p.password) } : p;
        this.items.set(record.id, record);
      }
    } catch {
      this.items = new Map();
    }
  }

  private persist(): void {
    // Encrypt proxy passwords at rest; in-memory records keep plaintext for launch.
    const onDisk = [...this.items.values()].map((p) => (p.password ? { ...p, password: encryptSecret(p.password) } : p));
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(onDisk, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list(): ProxyRecord[] {
    this.load();
    return [...this.items.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): ProxyRecord | undefined {
    this.load();
    return this.items.get(id);
  }

  create(input: CreateProxyInput): ProxyRecord {
    this.load();
    const record: ProxyRecord = {
      id: crypto.randomBytes(6).toString("hex"),
      name: input.name?.trim() || input.server,
      server: input.server,
      username: input.username,
      password: input.password,
      country: input.country?.toUpperCase(),
      timezone: input.timezone,
      createdAt: new Date().toISOString(),
    };
    this.items.set(record.id, record);
    this.persist();
    return record;
  }

  update(id: string, patch: Partial<CreateProxyInput>): ProxyRecord | undefined {
    this.load();
    const existing = this.items.get(id);
    if (!existing) return undefined;
    const updated: ProxyRecord = {
      ...existing,
      ...patch,
      country: patch.country ? patch.country.toUpperCase() : existing.country,
      id: existing.id,
      createdAt: existing.createdAt,
    };
    this.items.set(id, updated);
    this.persist();
    return updated;
  }

  remove(id: string): boolean {
    this.load();
    const ok = this.items.delete(id);
    if (ok) this.persist();
    return ok;
  }
}
