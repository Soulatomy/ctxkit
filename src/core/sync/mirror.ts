import crypto from "node:crypto";
import type { EngineSession } from "../../hosts/types.js";
import { log } from "../logger.js";

const SCOPE = "sync";

/**
 * In-page leader capture. Registered with page.evaluate (works regardless of
 * execution world; the buffer lives on a shared DOM attribute so the poller can
 * read it from another world). Each event carries a monotonically increasing
 * sequence number so the poller can pick up only new events.
 */
const CAPTURE_SCRIPT = `(() => {
  if (document.documentElement.hasAttribute('data-fb-sync-installed')) return;
  document.documentElement.setAttribute('data-fb-sync-installed', '1');
  var seq = 0, buf = [];
  function push(ev) {
    seq += 1;
    ev.s = seq;
    buf.push(ev);
    if (buf.length > 100) buf.splice(0, buf.length - 100);
    document.documentElement.setAttribute('data-fb-input', JSON.stringify({ seq: seq, events: buf }));
  }
  var lastMove = 0;
  window.addEventListener('mousemove', function (e) {
    var now = Date.now();
    if (now - lastMove < 40) return;
    lastMove = now;
    push({ t: 'mm', x: e.clientX, y: e.clientY });
  }, true);
  window.addEventListener('mousedown', function (e) { push({ t: 'md', b: e.button }); }, true);
  window.addEventListener('mouseup', function (e) { push({ t: 'mu', b: e.button }); }, true);
  window.addEventListener('wheel', function (e) { push({ t: 'wh', dx: e.deltaX, dy: e.deltaY }); }, true);
  window.addEventListener('keydown', function (e) { push({ t: 'kd', k: e.key }); }, true);
  window.addEventListener('keyup', function (e) { push({ t: 'ku', k: e.key }); }, true);
})();`;

interface CapturedEvent {
  s: number;
  t: "mm" | "md" | "mu" | "wh" | "kd" | "ku";
  x?: number;
  y?: number;
  b?: number;
  dx?: number;
  dy?: number;
  k?: string;
}

export interface SyncGroupView {
  id: string;
  leaderId: string;
  followerIds: string[];
  eventsReplayed: number;
}

interface SyncGroup extends SyncGroupView {
  lastSeq: number;
  timer: ReturnType<typeof setInterval>;
}

function buttonName(b: number | undefined): "left" | "right" | "middle" {
  return b === 2 ? "right" : b === 1 ? "middle" : "left";
}

async function dispatch(session: EngineSession, ev: CapturedEvent): Promise<void> {
  const p = session.page;
  switch (ev.t) {
    case "mm":
      await p.mouse.move(ev.x ?? 0, ev.y ?? 0);
      break;
    case "md":
      await p.mouse.down({ button: buttonName(ev.b) });
      break;
    case "mu":
      await p.mouse.up({ button: buttonName(ev.b) });
      break;
    case "wh":
      await p.mouse.wheel(ev.dx ?? 0, ev.dy ?? 0);
      break;
    case "kd":
      if (ev.k) await p.keyboard.down(ev.k);
      break;
    case "ku":
      if (ev.k) await p.keyboard.up(ev.k);
      break;
  }
}

/**
 * Live input mirroring: capture input events on a leader profile and replay
 * them onto follower profiles (GoLogin/AdsPower "window synchronizer").
 *
 * Polling the DOM attribute is a deliberate choice: patchright runs
 * page.evaluate in an isolated world and neutralises some CDP helpers, so a
 * binding/exposeFunction would be less reliable.
 */
export class Synchronizer {
  private groups = new Map<string, SyncGroup>();

  constructor(private readonly getSession: (id: string) => EngineSession | undefined) {}

  list(): SyncGroupView[] {
    return [...this.groups.values()].map(({ id, leaderId, followerIds, eventsReplayed }) => ({
      id,
      leaderId,
      followerIds,
      eventsReplayed,
    }));
  }

  async start(leaderId: string, followerIds: string[]): Promise<SyncGroupView> {
    const leader = this.getSession(leaderId);
    if (!leader) throw new Error(`leader ${leaderId} is not running`);
    const followers = followerIds.filter((id) => id !== leaderId);
    if (!followers.length) throw new Error("at least one follower is required");
    for (const id of followers) {
      if (!this.getSession(id)) throw new Error(`follower ${id} is not running`);
    }

    await leader.page.evaluate(() => document.documentElement.removeAttribute("data-fb-input")).catch(() => {});
    await leader.page.evaluate(CAPTURE_SCRIPT);

    const id = crypto.randomBytes(6).toString("hex");
    const group: SyncGroup = {
      id,
      leaderId,
      followerIds: followers,
      eventsReplayed: 0,
      lastSeq: 0,
      timer: setInterval(() => void this.tick(id), 120),
    };
    group.timer.unref?.();
    this.groups.set(id, group);
    log.info(SCOPE, `mirror started leader=${leaderId} followers=${followers.join(",")}`);
    return { id, leaderId, followerIds: followers, eventsReplayed: 0 };
  }

  async stop(id: string): Promise<boolean> {
    const group = this.groups.get(id);
    if (!group) return false;
    clearInterval(group.timer);
    this.groups.delete(id);
    log.info(SCOPE, `mirror stopped ${id}`);
    return true;
  }

  stopAll(): void {
    for (const group of this.groups.values()) clearInterval(group.timer);
    this.groups.clear();
  }

  private async tick(id: string): Promise<void> {
    const group = this.groups.get(id);
    if (!group) return;
    const leader = this.getSession(group.leaderId);
    if (!leader) return;

    let raw: string | null = null;
    try {
      raw = await leader.page.getAttribute("html", "data-fb-input");
    } catch {
      return;
    }
    if (!raw) return;

    let parsed: { seq: number; events: CapturedEvent[] };
    try {
      parsed = JSON.parse(raw) as { seq: number; events: CapturedEvent[] };
    } catch {
      return;
    }

    const fresh = (parsed.events ?? []).filter((e) => e.s > group.lastSeq);
    group.lastSeq = parsed.seq;
    if (!fresh.length) return;

    for (const followerId of group.followerIds) {
      const follower = this.getSession(followerId);
      if (!follower) continue;
      for (const ev of fresh) {
        try {
          await dispatch(follower, ev);
          group.eventsReplayed += 1;
        } catch {
          /* ignore individual dispatch failures */
        }
      }
    }
  }
}
