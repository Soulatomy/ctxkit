import { getHost } from "../../hosts/registry.js";
import type { EngineSession } from "../../hosts/types.js";
import type { Profile } from "../profile/types.js";
import type { ProxyConfig } from "../proxy/types.js";
import { log } from "../logger.js";

const SCOPE = "session";

export interface SessionInfo {
  profileId: string;
  profileName: string;
  engine: string;
  startedAt: string;
  status: "running" | "closed";
}

export interface LaunchOptions {
  headless?: boolean;
  startUrl?: string;
}

/**
 * Owns the lifetime of running browsers. One session per profile; the profile
 * id is the session id. Closing is idempotent and never throws.
 */
export class SessionManager {
  private running = new Map<string, { info: SessionInfo; engine: EngineSession }>();

  constructor(private readonly userDataDirFor: (profileId: string) => string) {}

  list(): SessionInfo[] {
    return [...this.running.values()].map((s) => s.info).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  isRunning(profileId: string): boolean {
    return this.running.has(profileId);
  }

  /** The live engine session for a profile, if any. */
  get(profileId: string): EngineSession | undefined {
    return this.running.get(profileId)?.engine;
  }

  async launch(profile: Profile, proxy: ProxyConfig | undefined, opts: LaunchOptions = {}): Promise<SessionInfo> {
    if (this.running.has(profile.id)) {
      throw new Error(`profile ${profile.id} is already running`);
    }

    const host = getHost(profile.engine);
    const avail = await host.isAvailable();
    if (!avail.ok) throw new Error(`engine ${profile.engine} unavailable: ${avail.reason}`);

    log.info(SCOPE, `launching ${profile.name} (${profile.id}) engine=${profile.engine}`);
    const engine = await host.launch({
      profileId: profile.id,
      fingerprint: profile.fingerprint,
      proxy,
      userDataDir: this.userDataDirFor(profile.id),
      headless: opts.headless ?? false,
      startUrl: opts.startUrl,
      extensions: profile.extensions,
    });

    const info: SessionInfo = {
      profileId: profile.id,
      profileName: profile.name,
      engine: profile.engine,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    this.running.set(profile.id, { info, engine });

    // Detect external close (user closes the window).
    engine.context.on?.("close", () => {
      this.running.delete(profile.id);
    });

    return info;
  }

  async close(profileId: string): Promise<boolean> {
    const entry = this.running.get(profileId);
    if (!entry) return false;
    this.running.delete(profileId);
    await entry.engine.close().catch((err) => log.warn(SCOPE, `close error: ${(err as Error).message}`));
    return true;
  }

  async closeAll(): Promise<void> {
    const ids = [...this.running.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
  }
}
