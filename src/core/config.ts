import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

// `import.meta.url` is unavailable in a CJS bundle (Electron main); fall back
// to cwd. Callers that bundle set FB_ROOT / FB_DATA_DIR explicitly anyway.
const here = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
})();

/**
 * Project root used to locate static assets (ui/). Overridable via FB_ROOT so
 * the packaged desktop app can point at its resources directory.
 */
export const ROOT = process.env.FB_ROOT ? path.resolve(process.env.FB_ROOT) : path.resolve(here, "..", "..");

export const DATA_DIR = process.env.FB_DATA_DIR
  ? path.resolve(process.env.FB_DATA_DIR)
  : path.join(ROOT, "data");

export const PROFILES_DIR = path.join(DATA_DIR, "profiles");
export const PROFILES_DB = path.join(DATA_DIR, "profiles.json");
export const PROXIES_DB = path.join(DATA_DIR, "proxies.json");
export const SETTINGS_DB = path.join(DATA_DIR, "settings.json");
export const ACTIVITY_DB = path.join(DATA_DIR, "activity.json");
export const USERS_DB = path.join(DATA_DIR, "users.json");
export const REPORTS_DIR = path.join(DATA_DIR, "reports");

export function ensureDataDirs(): void {
  for (const dir of [DATA_DIR, PROFILES_DIR, REPORTS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
