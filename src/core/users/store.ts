import fs from "node:fs";
import crypto from "node:crypto";
import { USERS_DB, ensureDataDirs } from "../config.js";
import { encryptSecret, decryptSecret } from "../crypto/secrets.js";

export type Role = "admin" | "operator" | "viewer";

export const ROLE_RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export interface User {
  id: string;
  name: string;
  role: Role;
  token: string;
  /** Base32 TOTP secret (encrypted at rest); present once 2FA is set up. */
  totpSecret?: string;
  totpEnabled?: boolean;
  createdAt: string;
}

export interface CreateUserInput {
  name: string;
  role: Role;
  token?: string;
}

/**
 * Local team/users store. Tokens are the credentials (bearer); roles gate
 * permissions. When there are no users and no FB_TOKEN, the API is open.
 *
 * NOTE: AES-encrypting tokens at rest is a follow-up; currently they are stored
 * in the data dir alongside the rest of the app state.
 */
export class UserStore {
  private users = new Map<string, User>();

  constructor(private readonly file: string = USERS_DB) {
    ensureDataDirs();
    if (fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as User[];
        for (const u of raw) {
          const user: User = u.totpSecret ? { ...u, totpSecret: decryptSecret(u.totpSecret) } : u;
          this.users.set(user.id, user);
        }
      } catch {
        this.users = new Map();
      }
    }
  }

  private persist(): void {
    const onDisk = [...this.users.values()].map((u) => (u.totpSecret ? { ...u, totpSecret: encryptSecret(u.totpSecret) } : u));
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(onDisk, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list(): User[] {
    return [...this.users.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): User | undefined {
    return this.users.get(id);
  }

  findByToken(token: string): User | undefined {
    if (!token) return undefined;
    return this.list().find((u) => u.token === token);
  }

  create(input: CreateUserInput): User {
    const user: User = {
      id: crypto.randomBytes(6).toString("hex"),
      name: input.name,
      role: input.role,
      token: input.token ?? crypto.randomBytes(24).toString("hex"),
      createdAt: new Date().toISOString(),
    };
    this.users.set(user.id, user);
    this.persist();
    return user;
  }

  remove(id: string): boolean {
    const ok = this.users.delete(id);
    if (ok) this.persist();
    return ok;
  }

  private update(id: string, patch: Partial<User>): User | undefined {
    const existing = this.users.get(id);
    if (!existing) return undefined;
    const next: User = { ...existing, ...patch };
    this.users.set(id, next);
    this.persist();
    return next;
  }

  setTotpSecret(id: string, secret: string): User | undefined {
    return this.update(id, { totpSecret: secret, totpEnabled: false });
  }

  setTotpEnabled(id: string, enabled: boolean): User | undefined {
    return this.update(id, enabled ? { totpEnabled: true } : { totpEnabled: false, totpSecret: undefined });
  }

  get isEmpty(): boolean {
    return this.users.size === 0;
  }
}
