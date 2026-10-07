import fs from "node:fs";
import { SETTINGS_DB, ensureDataDirs } from "../config.js";
import type { EngineName } from "../../hosts/types.js";
import type { OS } from "../fingerprint/types.js";

export interface Settings {
  /** Default engine used when creating profiles. */
  defaultEngine: EngineName;
  /** Default OS for new profiles (null = let the generator pick). */
  defaultOs: OS | null;
  /** Default proxy bound to new profiles. */
  defaultProxyId: string | null;
  /** Launch headless by default (not recommended for anti-detect). */
  headlessByDefault: boolean;
  /** Whether the first-run onboarding has been completed. */
  onboarded: boolean;
}

const DEFAULTS: Settings = {
  defaultEngine: "chrome-lite",
  defaultOs: null,
  defaultProxyId: null,
  headlessByDefault: false,
  onboarded: false,
};

export class SettingsStore {
  private data: Settings = { ...DEFAULTS };

  constructor() {
    ensureDataDirs();
    if (fs.existsSync(SETTINGS_DB)) {
      try {
        this.data = { ...DEFAULTS, ...(JSON.parse(fs.readFileSync(SETTINGS_DB, "utf8")) as Partial<Settings>) };
      } catch {
        this.data = { ...DEFAULTS };
      }
    }
  }

  get(): Settings {
    return { ...this.data };
  }

  update(patch: Partial<Settings>): Settings {
    this.data = { ...this.data, ...patch };
    const tmp = `${SETTINGS_DB}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, SETTINGS_DB);
    return this.get();
  }
}
