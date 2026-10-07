import fs from "node:fs";
import crypto from "node:crypto";
import { ACTIVITY_DB, ensureDataDirs } from "../config.js";

export interface ActivityEvent {
  id: string;
  ts: string;
  type: string;
  profileId?: string;
  profileName?: string;
  message?: string;
}

const MAX_EVENTS = 1000;

/**
 * Append-only activity log (who did what, when). Kept in memory + JSON, capped,
 * so it never grows unbounded. Swap for SQLite when volume grows.
 */
export class ActivityStore {
  private events: ActivityEvent[] = [];

  constructor(private readonly file: string = ACTIVITY_DB) {
    ensureDataDirs();
    if (fs.existsSync(this.file)) {
      try {
        this.events = JSON.parse(fs.readFileSync(this.file, "utf8")) as ActivityEvent[];
      } catch {
        this.events = [];
      }
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.events, null, 2));
    fs.renameSync(tmp, this.file);
  }

  record(event: Omit<ActivityEvent, "id" | "ts">): ActivityEvent {
    const full: ActivityEvent = { id: crypto.randomBytes(6).toString("hex"), ts: new Date().toISOString(), ...event };
    this.events.push(full);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.persist();
    return full;
  }

  /** Most recent first. */
  list(limit = 200): ActivityEvent[] {
    return this.events.slice(-Math.max(1, limit)).reverse();
  }

  clear(): void {
    this.events = [];
    this.persist();
  }
}
